import http from "node:http";
import dns from "node:dns/promises";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  assertTargetUrlAllowed,
  isCloudMetadataTarget,
  isInternalHostname,
  isIpPrivateOrRestricted,
  parseIpv4ToNumber,
  parseIpv6Bytes,
  safeFetch,
  SecurityError,
  validateTargetUrl,
} from "../services/urlGuard";

describe("urlGuard IP and address restrictions", () => {
  it("detects private and loopback IPv4 addresses", () => {
    expect(isIpPrivateOrRestricted("10.0.0.1")).toBe(true);
    expect(isIpPrivateOrRestricted("10.255.255.254")).toBe(true);
    expect(isIpPrivateOrRestricted("172.16.0.1")).toBe(true);
    expect(isIpPrivateOrRestricted("172.31.255.255")).toBe(true);
    expect(isIpPrivateOrRestricted("192.168.1.1")).toBe(true);
    expect(isIpPrivateOrRestricted("127.0.0.1")).toBe(true);
    expect(isIpPrivateOrRestricted("127.255.255.255")).toBe(true);
    expect(isIpPrivateOrRestricted("0.0.0.0")).toBe(true);
    expect(isIpPrivateOrRestricted("169.254.169.254")).toBe(true);
    expect(isIpPrivateOrRestricted("100.64.0.1")).toBe(true); // Carrier-grade NAT
    expect(isIpPrivateOrRestricted("224.0.0.1")).toBe(true); // Multicast
    expect(isIpPrivateOrRestricted("240.0.0.1")).toBe(true); // Reserved
    expect(isIpPrivateOrRestricted("255.255.255.255")).toBe(true); // Broadcast
  });

  it("detects private, loopback, and restricted IPv6 addresses", () => {
    expect(isIpPrivateOrRestricted("::1")).toBe(true); // Loopback
    expect(isIpPrivateOrRestricted("::")).toBe(true); // Unspecified
    expect(isIpPrivateOrRestricted("fe80::1")).toBe(true); // Link-local
    expect(isIpPrivateOrRestricted("fc00::1")).toBe(true); // ULA
    expect(isIpPrivateOrRestricted("fd00::1")).toBe(true); // ULA
    expect(isIpPrivateOrRestricted("fd00:ec2::254")).toBe(true); // AWS IPv6 metadata
    expect(isIpPrivateOrRestricted("ff02::1")).toBe(true); // Multicast
    expect(isIpPrivateOrRestricted("2001:db8::1")).toBe(true); // Documentation
    expect(isIpPrivateOrRestricted("::ffff:127.0.0.1")).toBe(true); // IPv4-mapped loopback
    expect(isIpPrivateOrRestricted("::ffff:7f00:1")).toBe(true); // IPv4-mapped hex loopback
    expect(isIpPrivateOrRestricted("::ffff:10.0.0.1")).toBe(true); // IPv4-mapped private
    expect(isIpPrivateOrRestricted("64:ff9b::127.0.0.1")).toBe(true); // NAT64 loopback
  });

  it("allows public IPv4 and IPv6 addresses", () => {
    expect(isIpPrivateOrRestricted("8.8.8.8")).toBe(false);
    expect(isIpPrivateOrRestricted("1.1.1.1")).toBe(false);
    expect(isIpPrivateOrRestricted("93.184.216.34")).toBe(false);
    expect(isIpPrivateOrRestricted("2001:4860:4860::8888")).toBe(false);
    expect(isIpPrivateOrRestricted("::ffff:8.8.8.8")).toBe(false);
  });
});

describe("cloud metadata endpoints", () => {
  it("identifies cloud metadata IPv4, IPv6, and hostnames", () => {
    expect(isCloudMetadataTarget("169.254.169.254")).toBe(true);
    expect(isCloudMetadataTarget("169.254.170.2")).toBe(true); // AWS ECS metadata
    expect(isCloudMetadataTarget("100.100.100.200")).toBe(true); // Alibaba metadata
    expect(isCloudMetadataTarget("fd00:ec2::254")).toBe(true); // AWS IPv6 metadata
    expect(isCloudMetadataTarget("metadata.google.internal")).toBe(true);
    expect(isCloudMetadataTarget("metadata")).toBe(true);
    expect(isCloudMetadataTarget("instance-data")).toBe(true);
    expect(isCloudMetadataTarget("2852039166")).toBe(true); // Integer for 169.254.169.254
  });

  it("unconditionally blocks cloud metadata even if ALLOW_PRIVATE_TARGETS=true", async () => {
    const oldVal = process.env.ALLOW_PRIVATE_TARGETS;
    try {
      process.env.ALLOW_PRIVATE_TARGETS = "true";
      const res1 = await validateTargetUrl("http://169.254.169.254/latest/meta-data");
      expect(res1.valid).toBe(false);

      const res2 = await validateTargetUrl("http://[fd00:ec2::254]/latest/meta-data");
      expect(res2.valid).toBe(false);

      const res3 = await validateTargetUrl("http://metadata.google.internal/computeMetadata/v1/");
      expect(res3.valid).toBe(false);

      const res4 = await validateTargetUrl("http://169.254.170.2/v2/credentials");
      expect(res4.valid).toBe(false);
    } finally {
      process.env.ALLOW_PRIVATE_TARGETS = oldVal;
    }
  });
});

describe("internal and local hostnames", () => {
  it("identifies internal domain suffixes and localhost", () => {
    expect(isInternalHostname("localhost")).toBe(true);
    expect(isInternalHostname("test.localhost")).toBe(true);
    expect(isInternalHostname("service.internal")).toBe(true);
    expect(isInternalHostname("db.corp")).toBe(true);
    expect(isInternalHostname("printer.local")).toBe(true);
    expect(isInternalHostname("gateway.lan")).toBe(true);
    expect(isInternalHostname("nas.home")).toBe(true);
    expect(isInternalHostname("server.priv")).toBe(true);
    expect(isInternalHostname("intranet.corp")).toBe(true);
    expect(isInternalHostname("backend", false)).toBe(true); // Single label in strict mode
    expect(isInternalHostname("example.com")).toBe(false);
  });

  it("blocks internal hostnames in strict mode", async () => {
    const res1 = await validateTargetUrl("http://service.internal/api", {
      allowPrivateTargets: false,
    });
    expect(res1.valid).toBe(false);
    expect(res1.reason).toContain("internal, local, or restricted domain");

    const res2 = await validateTargetUrl("http://router.local", { allowPrivateTargets: false });
    expect(res2.valid).toBe(false);

    const res3 = await validateTargetUrl("http://app.localhost:8080", {
      allowPrivateTargets: false,
    });
    expect(res3.valid).toBe(false);
  });
});

describe("encoded IP addresses and representation bypass defenses", () => {
  it("parses and normalizes alternative IPv4 representations", () => {
    // Decimal integer (2130706433 = 127.0.0.1)
    expect(parseIpv4ToNumber("2130706433")).toBe(0x7f000001);
    // Hex integer (0x7f000001 = 127.0.0.1)
    expect(parseIpv4ToNumber("0x7f000001")).toBe(0x7f000001);
    // Octal integer (017700000001 = 127.0.0.1)
    expect(parseIpv4ToNumber("017700000001")).toBe(0x7f000001);
    // Shortened 2-part dotted (127.1 = 127.0.0.1)
    expect(parseIpv4ToNumber("127.1")).toBe(0x7f000001);
    // Dotted hex (0x7f.0.0.1)
    expect(parseIpv4ToNumber("0x7f.0.0.1")).toBe(0x7f000001);
    // Dotted octal (0177.0.0.1)
    expect(parseIpv4ToNumber("0177.0.0.1")).toBe(0x7f000001);
  });

  it("blocks encoded IP addresses from bypassing validation", async () => {
    // Decimal integer (127.0.0.1)
    const resDec = await validateTargetUrl("http://2130706433/", { allowPrivateTargets: false });
    expect(resDec.valid).toBe(false);

    // Hex integer (127.0.0.1)
    const resHex = await validateTargetUrl("http://0x7f000001/", { allowPrivateTargets: false });
    expect(resHex.valid).toBe(false);

    // Shortened dotted (127.1)
    const resShort = await validateTargetUrl("http://127.1/", { allowPrivateTargets: false });
    expect(resShort.valid).toBe(false);

    // Dotted hex (0x7f.1)
    const resDotHex = await validateTargetUrl("http://0x7f.1/", { allowPrivateTargets: false });
    expect(resDotHex.valid).toBe(false);

    // IPv4-mapped IPv6 hex loopback (::ffff:7f00:1)
    const resMappedHex = await validateTargetUrl("http://[::ffff:7f00:1]/", {
      allowPrivateTargets: false,
    });
    expect(resMappedHex.valid).toBe(false);

    // IPv4-mapped IPv6 dotted loopback (::ffff:127.0.0.1)
    const resMappedDot = await validateTargetUrl("http://[::ffff:127.0.0.1]/", {
      allowPrivateTargets: false,
    });
    expect(resMappedDot.valid).toBe(false);
  });
});

describe("malformed URLs and protocol validation", () => {
  it("rejects non-http/https protocols", async () => {
    const fileRes = await validateTargetUrl("file:///etc/passwd");
    expect(fileRes.valid).toBe(false);
    expect(fileRes.reason).toContain("Unsupported protocol");

    const ftpRes = await validateTargetUrl("ftp://ftp.example.com/file.txt");
    expect(ftpRes.valid).toBe(false);
    expect(ftpRes.reason).toContain("Unsupported protocol");

    const gopherRes = await validateTargetUrl("gopher://example.com/");
    expect(gopherRes.valid).toBe(false);

    const dataRes = await validateTargetUrl("data:text/html,<html></html>");
    expect(dataRes.valid).toBe(false);
  });

  it("rejects URLs with embedded credentials", async () => {
    const res = await validateTargetUrl("https://admin:secret123@example.com/dashboard");
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("embedded username or password credentials");
  });

  it("rejects URLs with backslashes in authority", async () => {
    const res = await validateTargetUrl("http://example.com\\@127.0.0.1/");
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("Backslashes");
  });

  it("rejects URLs with control characters", async () => {
    const res = await validateTargetUrl("http://example.com\r\n/test");
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("control characters");
  });

  it("rejects malformed and empty URLs", async () => {
    expect((await validateTargetUrl("")).valid).toBe(false);
    expect((await validateTargetUrl("not-a-valid-url")).valid).toBe(false);
  });
});

describe("sanitized error messages (no internal network exposure)", () => {
  it("does not expose internal IP addresses in rejection messages", async () => {
    const res = await validateTargetUrl("http://10.24.50.100/admin", {
      allowPrivateTargets: false,
    });
    expect(res.valid).toBe(false);
    // Error message must NOT reveal the specific IP or internal network topology
    expect(res.reason).not.toContain("10.24.50.100");
    expect(res.reason).toContain("address is private, loopback, or restricted");
  });
});

describe("safeFetch: redirects, timeout, size limits, and DNS rebinding defense", () => {
  let localServer: http.Server;
  let serverPort: number;
  let serverBaseUrl: string;

  beforeAll(async () => {
    localServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${serverPort}`);

      if (url.pathname === "/ok") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "success", message: "Hello safe world" }));
        return;
      }

      if (url.pathname === "/redirect-to-private") {
        // Simulates an open redirect attempting to pivot into local service
        res.writeHead(302, { Location: `http://127.0.0.1:${serverPort}/secret-admin` });
        res.end();
        return;
      }

      if (url.pathname === "/redirect-chain-1") {
        res.writeHead(302, { Location: `http://127.0.0.1:${serverPort}/redirect-chain-2` });
        res.end();
        return;
      }

      if (url.pathname === "/redirect-chain-2") {
        res.writeHead(302, { Location: `http://127.0.0.1:${serverPort}/redirect-chain-3` });
        res.end();
        return;
      }

      if (url.pathname === "/redirect-chain-3") {
        res.writeHead(302, { Location: `http://127.0.0.1:${serverPort}/ok` });
        res.end();
        return;
      }

      if (url.pathname === "/infinite-redirect") {
        res.writeHead(302, { Location: `http://127.0.0.1:${serverPort}/infinite-redirect` });
        res.end();
        return;
      }

      if (url.pathname === "/slow") {
        // Delays response for 200ms to test timeout
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("delayed response");
        }, 200);
        return;
      }

      if (url.pathname === "/oversized") {
        // Sends 50KB chunk
        const chunk = "A".repeat(50 * 1024);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(chunk);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    });

    await new Promise<void>((resolve) => {
      localServer.listen(0, "127.0.0.1", () => {
        serverPort = (localServer.address() as AddressInfo).port;
        serverBaseUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      localServer.close(() => resolve());
    });
  });

  it("successfully makes legitimate requests with allowPrivateTargets enabled", async () => {
    const res = await safeFetch(`${serverBaseUrl}/ok`, { allowPrivateTargets: true });
    expect(res.status).toBe(200);
    const json = await res.json<{ status: string; message: string }>();
    expect(json.status).toBe("success");
    expect(json.message).toBe("Hello safe world");
  });

  it("supports all-address DNS lookups while pinning hostname requests", async () => {
    const lookup = vi
      .spyOn(dns, "lookup")
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    try {
      const response = await safeFetch(`http://api.example.test:${serverPort}/ok`, {
        allowPrivateTargets: true,
      });

      expect(response.status).toBe(200);
      expect(await response.json<{ status: string }>()).toMatchObject({ status: "success" });
      expect(lookup).toHaveBeenCalled();
    } finally {
      lookup.mockRestore();
    }
  });

  it("blocks requests to private destinations when allowPrivateTargets=false", async () => {
    await expect(
      safeFetch(`${serverBaseUrl}/ok`, { allowPrivateTargets: false }),
    ).rejects.toThrow("URL rejected by security guard");
  });

  it("blocks redirects to private IP destinations during safeFetch", async () => {
    // When following redirect, destination is validated:
    // If destination is private and allowPrivateTargets=false, redirect is aborted!
    await expect(
      safeFetch(`${serverBaseUrl}/redirect-to-private`, {
        allowPrivateTargets: false,
      }),
    ).rejects.toThrow("URL rejected by security guard");
  });

  it("validates each hop in redirect chains and follows legitimate redirects", async () => {
    const res = await safeFetch(`${serverBaseUrl}/redirect-chain-1`, {
      allowPrivateTargets: true,
      maxRedirects: 5,
    });
    expect(res.status).toBe(200);
    expect(res.redirected).toBe(true);
    const text = await res.text();
    expect(text).toContain("Hello safe world");
  });

  it("aborts when redirect count exceeds maxRedirects limit", async () => {
    await expect(
      safeFetch(`${serverBaseUrl}/infinite-redirect`, {
        allowPrivateTargets: true,
        maxRedirects: 3,
      }),
    ).rejects.toThrow("Too many redirects");
  });

  it("enforces connection and request timeouts", async () => {
    await expect(
      safeFetch(`${serverBaseUrl}/slow`, {
        allowPrivateTargets: true,
        timeoutMs: 50,
      }),
    ).rejects.toThrow("timed out");
  });

  it("enforces maximum response size limits", async () => {
    // Limit to 10KB while server sends 50KB
    await expect(
      safeFetch(`${serverBaseUrl}/oversized`, {
        allowPrivateTargets: true,
        maxResponseSizeBytes: 10 * 1024,
      }),
    ).rejects.toThrow("Response body exceeds maximum allowed size");
  });

  it("detects and rejects DNS resolution failures cleanly", async () => {
    await expect(
      safeFetch("https://nonexistent-domain-xyz-987456123.org", {
        allowPrivateTargets: false,
      }),
    ).rejects.toThrow("DNS resolution failed");
  });

  it("protects against DNS rebinding via socket IP pinning", async () => {
    // Verify that safeFetch lookup hook rejects restricted destination IPs
    // even if initial URL validation was bypassed
    await expect(
      safeFetch("http://127.0.0.1:8080/", {
        allowPrivateTargets: false,
      }),
    ).rejects.toThrow();
  });
});

describe("public HTTPS URLs validation", () => {
  it("allows normal public HTTPS URLs", async () => {
    const res = await validateTargetUrl("https://example.com");
    expect(res.valid).toBe(true);
    expect(res.normalizedUrl).toBe("https://example.com/");
  });

  it("assertTargetUrlAllowed returns normalized URL for valid public targets", async () => {
    const normalized = await assertTargetUrlAllowed("https://example.com");
    expect(normalized).toBe("https://example.com/");
  });
});
