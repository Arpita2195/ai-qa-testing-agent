import { describe, expect, it } from "vitest";
import { validateTargetUrl, isIpPrivateOrRestricted } from "../services/urlGuard";

describe("urlGuard IP and address restrictions", () => {
  it("detects private IPv4 addresses", () => {
    expect(isIpPrivateOrRestricted("10.0.0.1")).toBe(true);
    expect(isIpPrivateOrRestricted("172.16.0.1")).toBe(true);
    expect(isIpPrivateOrRestricted("192.168.1.1")).toBe(true);
    expect(isIpPrivateOrRestricted("127.0.0.1")).toBe(true);
    expect(isIpPrivateOrRestricted("0.0.0.0")).toBe(true);
    expect(isIpPrivateOrRestricted("169.254.169.254")).toBe(true);
  });

  it("detects private and restricted IPv6 addresses", () => {
    expect(isIpPrivateOrRestricted("::1")).toBe(true);
    expect(isIpPrivateOrRestricted("::")).toBe(true);
    expect(isIpPrivateOrRestricted("fe80::1")).toBe(true);
    expect(isIpPrivateOrRestricted("fc00::1")).toBe(true);
    expect(isIpPrivateOrRestricted("fd00:ec2::254")).toBe(true);
    expect(isIpPrivateOrRestricted("::ffff:127.0.0.1")).toBe(true);
    expect(isIpPrivateOrRestricted("::ffff:10.0.0.1")).toBe(true);
  });

  it("allows public IP addresses", () => {
    expect(isIpPrivateOrRestricted("8.8.8.8")).toBe(false);
    expect(isIpPrivateOrRestricted("1.1.1.1")).toBe(false);
    expect(isIpPrivateOrRestricted("93.184.216.34")).toBe(false);
  });
});

describe("validateTargetUrl security validation", () => {
  it("rejects non-http/https protocols", async () => {
    const res = await validateTargetUrl("file:///etc/passwd");
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("Unsupported protocol");

    const ftpRes = await validateTargetUrl("ftp://example.com/test");
    expect(ftpRes.valid).toBe(false);
  });

  it("rejects URLs with embedded credentials", async () => {
    const res = await validateTargetUrl("https://admin:secret123@example.com/dashboard");
    expect(res.valid).toBe(false);
    expect(res.reason).toContain("URLs with embedded username or password credentials are forbidden");
  });

  it("blocks loopback and localhost targets", async () => {
    const res1 = await validateTargetUrl("http://127.0.0.1:3000");
    expect(res1.valid).toBe(false);

    const res2 = await validateTargetUrl("http://localhost:8080");
    expect(res2.valid).toBe(false);

    const res3 = await validateTargetUrl("http://[::1]:3000");
    expect(res3.valid).toBe(false);
  });

  it("blocks cloud metadata addresses", async () => {
    const res1 = await validateTargetUrl("http://169.254.169.254/latest/meta-data");
    expect(res1.valid).toBe(false);

    const res2 = await validateTargetUrl("http://[fd00:ec2::254]/latest/meta-data");
    expect(res2.valid).toBe(false);
  });

  it("blocks decimal and hex encoded IP addresses", async () => {
    // 2130706433 is 127.0.0.1
    const resDec = await validateTargetUrl("http://2130706433/");
    expect(resDec.valid).toBe(false);

    // 0x7f000001 is 127.0.0.1
    const resHex = await validateTargetUrl("http://0x7f000001/");
    expect(resHex.valid).toBe(false);

    // 2852039166 is 169.254.169.254
    const resMeta = await validateTargetUrl("http://2852039166/");
    expect(resMeta.valid).toBe(false);
  });

  it("allows valid public URLs", async () => {
    const res = await validateTargetUrl("https://example.com");
    expect(res.valid).toBe(true);
    expect(res.normalizedUrl).toContain("https://example.com");
  });

  it("allows private targets when ALLOW_PRIVATE_TARGETS=true", async () => {
    const oldVal = process.env.ALLOW_PRIVATE_TARGETS;
    try {
      process.env.ALLOW_PRIVATE_TARGETS = "true";
      const res = await validateTargetUrl("http://localhost:3000");
      expect(res.valid).toBe(true);

      // Cloud metadata MUST still be blocked even when ALLOW_PRIVATE_TARGETS=true
      const metaRes = await validateTargetUrl("http://169.254.169.254/latest/meta-data");
      expect(metaRes.valid).toBe(false);
    } finally {
      process.env.ALLOW_PRIVATE_TARGETS = oldVal;
    }
  });
});
