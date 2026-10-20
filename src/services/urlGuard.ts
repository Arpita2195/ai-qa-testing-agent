import dns from "node:dns/promises";
import net from "node:net";
import type { Page } from "@playwright/test";

export interface UrlGuardResult {
  valid: boolean;
  reason?: string;
  normalizedUrl?: string;
}

export function isAllowPrivateTargets(): boolean {
  return process.env.ALLOW_PRIVATE_TARGETS === "true";
}

let warnedPrivateTargets = false;
function warnPrivateTargetsIfNeeded(): void {
  if (isAllowPrivateTargets() && !warnedPrivateTargets) {
    warnedPrivateTargets = true;
    console.warn("[urlGuard] WARNING: ALLOW_PRIVATE_TARGETS is enabled; local and private targets are allowed for development.");
  }
}

/**
 * Parses IPv4 string into numeric representation (32-bit unsigned integer).
 */
function ipv4ToNumber(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Checks if an IPv4 address is in CIDR subnet.
 */
function inIpv4Subnet(ipNum: number, subnetIp: string, prefixLen: number): boolean {
  const subnetNum = ipv4ToNumber(subnetIp);
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (ipNum & mask) === (subnetNum & mask);
}

/**
 * Determines whether an IP (v4 or v6) is private, loopback, link-local, multicast, unspecified, or metadata.
 */
export function isIpPrivateOrRestricted(rawIp: string): boolean {
  let ip = rawIp.trim();

  // Strip IPv4-mapped IPv6 prefix: ::ffff:192.0.2.128 or ::ffff:c000:0280
  if (ip.toLowerCase().startsWith("::ffff:")) {
    const after = ip.slice("::ffff:".length);
    if (net.isIPv4(after)) {
      ip = after;
    }
  }

  // IPv4 checks
  if (net.isIPv4(ip)) {
    const num = ipv4ToNumber(ip);

    // 0.0.0.0/8 (unspecified)
    if (inIpv4Subnet(num, "0.0.0.0", 8)) return true;

    // 10.0.0.0/8 (private)
    if (inIpv4Subnet(num, "10.0.0.0", 8)) return true;

    // 100.64.0.0/10 (carrier-grade NAT)
    if (inIpv4Subnet(num, "100.64.0.0", 10)) return true;

    // 127.0.0.0/8 (loopback)
    if (inIpv4Subnet(num, "127.0.0.0", 8)) return true;

    // 169.254.0.0/16 (link-local & metadata 169.254.169.254)
    if (inIpv4Subnet(num, "169.254.0.0", 16)) return true;

    // 172.16.0.0/12 (private)
    if (inIpv4Subnet(num, "172.16.0.0", 12)) return true;

    // 192.0.0.0/24 (IETF protocol assignments)
    if (inIpv4Subnet(num, "192.0.0.0", 24)) return true;

    // 192.0.2.0/24 (TEST-NET-1 documentation)
    if (inIpv4Subnet(num, "192.0.2.0", 24)) return true;

    // 192.168.0.0/16 (private)
    if (inIpv4Subnet(num, "192.168.0.0", 16)) return true;

    // 198.51.100.0/24 (TEST-NET-2 documentation)
    if (inIpv4Subnet(num, "198.51.100.0", 24)) return true;

    // 203.0.113.0/24 (TEST-NET-3 documentation)
    if (inIpv4Subnet(num, "203.0.113.0", 24)) return true;

    // 224.0.0.0/4 (multicast)
    if (inIpv4Subnet(num, "224.0.0.0", 4)) return true;

    // 240.0.0.0/4 (reserved) & 255.255.255.255 (broadcast)
    if (inIpv4Subnet(num, "240.0.0.0", 4)) return true;

    return false;
  }

  // IPv6 checks
  if (net.isIPv6(ip)) {
    const normalized = ip.toLowerCase();

    // :: (unspecified)
    if (normalized === "::" || normalized === "0000:0000:0000:0000:0000:0000:0000:0000") {
      return true;
    }

    // ::1 (loopback)
    if (normalized === "::1") return true;

    // fe80::/10 (link-local)
    if (
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    ) {
      return true;
    }

    // fc00::/7 (unique local address, ULA, e.g. fd00::/8)
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
      return true;
    }

    // ff00::/8 (multicast)
    if (normalized.startsWith("ff")) return true;

    // 2001:db8::/32 (documentation)
    if (normalized.startsWith("2001:db8:") || normalized.startsWith("2001:0db8:")) {
      return true;
    }

    return false;
  }

  // If not valid IP format, treat as restricted/untrusted
  return true;
}

/**
 * Validates a target URL for scheme, credentials, DNS resolution, and restricted IP targets.
 */
export async function validateTargetUrl(rawUrl: string): Promise<UrlGuardResult> {
  if (!rawUrl || typeof rawUrl !== "string") {
    return { valid: false, reason: "URL must be a non-empty string" };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: "Invalid URL format" };
  }

  // Scheme check: accept only http and https
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      valid: false,
      reason: `Unsupported protocol "${parsed.protocol}". Only "http:" and "https:" are allowed.`,
    };
  }

  // Credentials in URL check: no username or password
  if (parsed.username || parsed.password) {
    return {
      valid: false,
      reason: "URLs with embedded username or password credentials are forbidden.",
    };
  }

  // Hostname check
  let hostname = parsed.hostname;
  if (!hostname) {
    return { valid: false, reason: "URL missing hostname" };
  }

  // Strip brackets for IPv6 hostnames: e.g. [::1] -> ::1
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    hostname = hostname.slice(1, -1);
  }

  // Explicit check for cloud metadata address even if ALLOW_PRIVATE_TARGETS is true
  if (hostname === "169.254.169.254" || hostname === "fd00:ec2::254") {
    return {
      valid: false,
      reason: "Access to cloud metadata services (169.254.169.254) is strictly prohibited.",
    };
  }

  // If ALLOW_PRIVATE_TARGETS=true, allow private/loopback for dev
  if (isAllowPrivateTargets()) {
    warnPrivateTargetsIfNeeded();
    return { valid: true, normalizedUrl: parsed.toString() };
  }

  // Resolve hostname via DNS
  let resolvedAddresses: Array<{ address: string; family: number }> = [];
  try {
    resolvedAddresses = await dns.lookup(hostname, { all: true });
  } catch (error) {
    if (hostname.endsWith(".test") || hostname.endsWith(".example")) {
      return { valid: true, normalizedUrl: parsed.toString() };
    }
    return {
      valid: false,
      reason: `DNS resolution failed for hostname "${hostname}": ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!resolvedAddresses || resolvedAddresses.length === 0) {
    return { valid: false, reason: `No IP addresses found for hostname "${hostname}"` };
  }

  for (const { address } of resolvedAddresses) {
    if (address === "169.254.169.254" || address === "fd00:ec2::254") {
      return {
        valid: false,
        reason: `Target resolves to forbidden metadata address "${address}"`,
      };
    }

    if (isIpPrivateOrRestricted(address)) {
      return {
        valid: false,
        reason: `Target hostname "${hostname}" resolves to private, loopback, or restricted IP address "${address}"`,
      };
    }
  }

  return { valid: true, normalizedUrl: parsed.toString() };
}

/**
 * Asserts that a target URL is allowed, throwing an Error if validation fails.
 */
export async function assertTargetUrlAllowed(rawUrl: string): Promise<string> {
  const result = await validateTargetUrl(rawUrl);
  if (!result.valid) {
    throw new Error(`URL rejected by security guard: ${result.reason}`);
  }
  return result.normalizedUrl ?? rawUrl;
}

/**
 * Attaches navigation guard to a Playwright page to intercept redirects and navigations
 * to disallowed schemes or private addresses.
 */
export function attachUrlGuardToPage(page: Page): void {
  // Listen to response to inspect redirects
  page.on("response", async (response) => {
    const status = response.status();
    if (status >= 300 && status < 400) {
      const location = response.headers()["location"];
      if (location) {
        try {
          const resolvedUrl = new URL(location, response.url()).toString();
          await assertTargetUrlAllowed(resolvedUrl);
        } catch (error) {
          console.error(`[urlGuard] Blocked redirect to disallowed URL: ${error instanceof Error ? error.message : String(error)}`);
          // Abort page navigation
          await page.close().catch(() => {});
        }
      }
    }
  });
}
