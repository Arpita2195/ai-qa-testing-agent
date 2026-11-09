import { describe, expect, it } from "vitest";
import { shouldUseSecureSessionCookie } from "../config/sessionCookie";

describe("session cookie Secure configuration", () => {
  it("defaults Secure off for local HTTP development", () => {
    expect(shouldUseSecureSessionCookie("development")).toBe(false);
  });

  it("defaults Secure on in production", () => {
    expect(shouldUseSecureSessionCookie("production")).toBe(true);
  });

  it("allows COOKIE_SECURE to force Secure outside production", () => {
    expect(shouldUseSecureSessionCookie("development", "true")).toBe(true);
  });

  it("allows HTTP only when the explicit insecure mode is enabled", () => {
    expect(shouldUseSecureSessionCookie("production", "true", "true")).toBe(false);
  });
});
