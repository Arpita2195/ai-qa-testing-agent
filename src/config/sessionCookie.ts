export function shouldUseSecureSessionCookie(
  nodeEnv: string | undefined = process.env.NODE_ENV,
  cookieSecure: string | undefined = process.env.COOKIE_SECURE,
  allowInsecureHttp: string | undefined = process.env.COOKIE_ALLOW_INSECURE_HTTP,
): boolean {
  if (allowInsecureHttp === "true") {
    return false;
  }

  return nodeEnv === "production" || cookieSecure === "true";
}
