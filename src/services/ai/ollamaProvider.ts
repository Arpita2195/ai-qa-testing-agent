import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { env } from "../../config/env";
import {
  parseIpv4ToNumber,
  inIpv4RestrictedRange,
  parseIpv6Bytes,
  inIpv6RestrictedRange,
  isCloudMetadataTarget,
  isInternalHostname,
} from "../urlGuard";
import { calculateEstimatedCostUsd } from "./pricing";
import {
  type AIProvider,
  type AIProviderType,
  type AIGenerateOptions,
  type AIGenerateResult,
  type AIConnectionTestResult,
  type AIProviderConfig,
  AIProviderError,
} from "./types";

export interface OllamaValidationOptions {
  allowLocalhost?: boolean;
  allowPrivateNetworks?: boolean;
}

/**
 * Validates and normalizes an Ollama base URL to strictly prevent SSRF,
 * metadata exfiltration, and unauthorized network access while allowing
 * legitimate local Ollama instances (e.g. http://127.0.0.1:11434).
 */
export function validateOllamaBaseUrl(
  rawUrl: string,
  options: OllamaValidationOptions = {},
): string {
  if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.trim()) {
    throw new AIProviderError({
      message: "Ollama base URL cannot be empty",
      code: "CONFIGURATION_ERROR",
      provider: "ollama",
    });
  }

  let urlObj: URL;
  try {
    urlObj = new URL(rawUrl.trim());
  } catch {
    throw new AIProviderError({
      message: `Invalid Ollama base URL format: ${rawUrl}`,
      code: "CONFIGURATION_ERROR",
      provider: "ollama",
    });
  }

  // 1. Protocol validation: only http: and https: allowed
  if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
    throw new AIProviderError({
      message: `Unsupported protocol '${urlObj.protocol}': Ollama base URL must use http: or https:`,
      code: "CONFIGURATION_ERROR",
      provider: "ollama",
    });
  }

  // 2. Reject credentials in URL
  if (urlObj.username || urlObj.password) {
    throw new AIProviderError({
      message: "Ollama base URL must not contain user credentials (username or password)",
      code: "CONFIGURATION_ERROR",
      provider: "ollama",
    });
  }

  const rawHost = urlObj.hostname.trim().toLowerCase();
  const host = rawHost.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // 3. Reject cloud metadata endpoints under all circumstances
  if (isCloudMetadataTarget(host)) {
    throw new AIProviderError({
      message: "Access to cloud metadata service is strictly prohibited",
      code: "CONFIGURATION_ERROR",
      provider: "ollama",
    });
  }

  const v4Num = parseIpv4ToNumber(host);
  const v6Bytes = parseIpv6Bytes(host);

  // 4. Check for loopback (127.0.0.0/8, ::1, localhost)
  const isLoopbackV4 = v4Num !== null && (v4Num >>> 24) === 127;
  const isLoopbackV6 =
    v6Bytes !== null &&
    v6Bytes.slice(0, 15).every((b) => b === 0) &&
    v6Bytes[15] === 1;
  const isLoopbackHost =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    isLoopbackV4 ||
    isLoopbackV6;

  const allowLocalhost = options.allowLocalhost ?? true;

  if (isLoopbackHost) {
    if (!allowLocalhost) {
      throw new AIProviderError({
        message: "Access to loopback/localhost addresses is disabled by configuration",
        code: "CONFIGURATION_ERROR",
        provider: "ollama",
      });
    }
    // Legitimate local loopback Ollama allowed
    const cleanPath = urlObj.pathname.replace(/\/+$/, "");
    return `${urlObj.protocol}//${urlObj.host}${cleanPath}`;
  }

  // 5. Check for link-local addresses (169.254.0.0/16 or fe80::/10)
  if (v4Num !== null && ((v4Num & 0xffff0000) >>> 0) === 0xa9fe0000) {
    throw new AIProviderError({
      message: "Access to link-local addresses (169.254.x.x) is prohibited",
      code: "CONFIGURATION_ERROR",
      provider: "ollama",
    });
  }
  if (v6Bytes !== null && v6Bytes[0] === 0xfe && (v6Bytes[1] & 0xc0) === 0x80) {
    throw new AIProviderError({
      message: "Access to link-local addresses (fe80::/10) is prohibited",
      code: "CONFIGURATION_ERROR",
      provider: "ollama",
    });
  }

  // 6. Check for internal / private networks
  const allowPrivate =
    options.allowPrivateNetworks !== undefined
      ? options.allowPrivateNetworks
      : (process.env.ALLOW_PRIVATE_TARGETS === "true" || env.ALLOW_PRIVATE_TARGETS === "true");

  const isRestrictedV4 = v4Num !== null && inIpv4RestrictedRange(v4Num);
  const isRestrictedV6 = v6Bytes !== null && inIpv6RestrictedRange(v6Bytes);
  const isInternalHost = isInternalHostname(host);

  if ((isRestrictedV4 || isRestrictedV6 || isInternalHost) && !allowPrivate) {
    throw new AIProviderError({
      message: `Access to private or internal network address '${host}' is prohibited`,
      code: "CONFIGURATION_ERROR",
      provider: "ollama",
    });
  }

  const cleanPath = urlObj.pathname.replace(/\/+$/, "");
  return `${urlObj.protocol}//${urlObj.host}${cleanPath}`;
}

export interface SafeOllamaEndpoint {
  cleanUrl: string;
  urlObj: URL;
  hostname: string;
  port: number;
  isHttps: boolean;
  pinnedIp: string;
  pinnedFamily: number;
  allResolvedIps: string[];
}

/**
 * Resolves DNS and validates an Ollama endpoint against SSRF, DNS rebinding,
 * cloud metadata, link-local, and restricted network rules.
 * Validates ALL returned IPv4 and IPv6 addresses and returns connection pinning parameters.
 */
export async function resolveAndValidateOllamaEndpoint(
  rawUrl: string,
  options: OllamaValidationOptions = {},
): Promise<SafeOllamaEndpoint> {
  const cleanUrl = validateOllamaBaseUrl(rawUrl, options);
  const urlObj = new URL(cleanUrl);
  const rawHost = urlObj.hostname.trim().toLowerCase();
  const host = rawHost.replace(/^\[|\]$/g, ""); // strip IPv6 brackets

  // Unconditionally block cloud metadata targets
  if (isCloudMetadataTarget(host)) {
    throw new AIProviderError({
      message: "Access to cloud metadata service is strictly prohibited",
      code: "CONFIGURATION_ERROR",
      provider: "ollama",
    });
  }

  const allowLocalhost = options.allowLocalhost ?? true;
  const allowPrivate =
    options.allowPrivateNetworks !== undefined
      ? options.allowPrivateNetworks
      : (process.env.ALLOW_PRIVATE_TARGETS === "true" || env.ALLOW_PRIVATE_TARGETS === "true");

  const isHttps = urlObj.protocol === "https:";
  const port = urlObj.port ? parseInt(urlObj.port, 10) : (isHttps ? 443 : 80);

  const ipFamily = net.isIP(host);

  // 1. Target is an explicit IP literal
  if (ipFamily !== 0) {
    if (ipFamily === 4) {
      const v4Num = parseIpv4ToNumber(host);
      const isLoopbackV4 = v4Num !== null && (v4Num >>> 24) === 127;
      if (isLoopbackV4) {
        if (!allowLocalhost) {
          throw new AIProviderError({
            message: "Access to loopback/localhost addresses is disabled by configuration",
            code: "CONFIGURATION_ERROR",
            provider: "ollama",
          });
        }
        return {
          cleanUrl,
          urlObj,
          hostname: host,
          port,
          isHttps,
          pinnedIp: host,
          pinnedFamily: 4,
          allResolvedIps: [host],
        };
      }

      // Link-local check
      if (v4Num !== null && ((v4Num & 0xffff0000) >>> 0) === 0xa9fe0000) {
        throw new AIProviderError({
          message: "Access to link-local addresses (169.254.x.x) is prohibited",
          code: "CONFIGURATION_ERROR",
          provider: "ollama",
        });
      }

      // Private network check
      if (v4Num !== null && inIpv4RestrictedRange(v4Num) && !allowPrivate) {
        throw new AIProviderError({
          message: `Access to private or internal network address '${host}' is prohibited`,
          code: "CONFIGURATION_ERROR",
          provider: "ollama",
        });
      }

      return {
        cleanUrl,
        urlObj,
        hostname: host,
        port,
        isHttps,
        pinnedIp: host,
        pinnedFamily: 4,
        allResolvedIps: [host],
      };
    } else {
      // IPv6 literal
      const v6Bytes = parseIpv6Bytes(host);
      const isLoopbackV6 =
        v6Bytes !== null &&
        v6Bytes.slice(0, 15).every((b) => b === 0) &&
        v6Bytes[15] === 1;

      if (isLoopbackV6) {
        if (!allowLocalhost) {
          throw new AIProviderError({
            message: "Access to loopback/localhost addresses is disabled by configuration",
            code: "CONFIGURATION_ERROR",
            provider: "ollama",
          });
        }
        return {
          cleanUrl,
          urlObj,
          hostname: host,
          port,
          isHttps,
          pinnedIp: host,
          pinnedFamily: 6,
          allResolvedIps: [host],
        };
      }

      // Link-local check (fe80::/10)
      if (v6Bytes !== null && v6Bytes[0] === 0xfe && (v6Bytes[1] & 0xc0) === 0x80) {
        throw new AIProviderError({
          message: "Access to link-local addresses (fe80::/10) is prohibited",
          code: "CONFIGURATION_ERROR",
          provider: "ollama",
        });
      }

      // Private network check
      if (v6Bytes !== null && inIpv6RestrictedRange(v6Bytes) && !allowPrivate) {
        throw new AIProviderError({
          message: `Access to private or internal network address '${host}' is prohibited`,
          code: "CONFIGURATION_ERROR",
          provider: "ollama",
        });
      }

      return {
        cleanUrl,
        urlObj,
        hostname: host,
        port,
        isHttps,
        pinnedIp: host,
        pinnedFamily: 6,
        allResolvedIps: [host],
      };
    }
  }

  // 2. Loopback hostname (localhost / *.localhost)
  if (host === "localhost" || host.endsWith(".localhost")) {
    if (!allowLocalhost) {
      throw new AIProviderError({
        message: "Access to loopback/localhost addresses is disabled by configuration",
        code: "CONFIGURATION_ERROR",
        provider: "ollama",
      });
    }
    return {
      cleanUrl,
      urlObj,
      hostname: host,
      port,
      isHttps,
      pinnedIp: "127.0.0.1",
      pinnedFamily: 4,
      allResolvedIps: ["127.0.0.1"],
    };
  }

  // 3. Domain name - verify internal hostname restriction first
  if (isInternalHostname(host) && !allowPrivate) {
    throw new AIProviderError({
      message: `Access to private or internal network address '${host}' is prohibited`,
      code: "CONFIGURATION_ERROR",
      provider: "ollama",
    });
  }

  // 4. Resolve DNS once and check ALL returned IPv4 and IPv6 addresses
  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await dns.lookup(host, { all: true });
  } catch (dnsErr) {
    throw new AIProviderError({
      message: `Failed to resolve Ollama host '${host}': ${dnsErr instanceof Error ? dnsErr.message : String(dnsErr)}`,
      code: "CONFIGURATION_ERROR",
      provider: "ollama",
      retryable: false,
    });
  }

  if (!resolved || resolved.length === 0) {
    throw new AIProviderError({
      message: `Ollama host '${host}' did not resolve to any IP address`,
      code: "CONFIGURATION_ERROR",
      provider: "ollama",
      retryable: false,
    });
  }

  const allResolvedIps: string[] = [];

  for (const addr of resolved) {
    const resolvedIp = addr.address.trim().toLowerCase();
    allResolvedIps.push(resolvedIp);

    // Cloud metadata check on resolved IP
    if (isCloudMetadataTarget(resolvedIp)) {
      throw new AIProviderError({
        message: `DNS resolution of '${host}' points to prohibited cloud metadata IP (${resolvedIp})`,
        code: "CONFIGURATION_ERROR",
        provider: "ollama",
      });
    }

    const resV4 = parseIpv4ToNumber(resolvedIp);
    const resV6 = parseIpv6Bytes(resolvedIp);

    // DNS Rebinding prevention: A public domain name cannot resolve to loopback!
    const isResolvedLoopback =
      (resV4 !== null && (resV4 >>> 24) === 127) ||
      (resV6 !== null && resV6.slice(0, 15).every((b) => b === 0) && resV6[15] === 1);

    if (isResolvedLoopback) {
      throw new AIProviderError({
        message: `DNS rebinding detected: host '${host}' resolved to prohibited loopback address (${resolvedIp})`,
        code: "CONFIGURATION_ERROR",
        provider: "ollama",
      });
    }

    // Link-local check on resolved IP
    if (resV4 !== null && ((resV4 & 0xffff0000) >>> 0) === 0xa9fe0000) {
      throw new AIProviderError({
        message: `DNS resolution of '${host}' points to prohibited link-local address (${resolvedIp})`,
        code: "CONFIGURATION_ERROR",
        provider: "ollama",
      });
    }
    if (resV6 !== null && resV6[0] === 0xfe && (resV6[1] & 0xc0) === 0x80) {
      throw new AIProviderError({
        message: `DNS resolution of '${host}' points to prohibited link-local address (${resolvedIp})`,
        code: "CONFIGURATION_ERROR",
        provider: "ollama",
      });
    }

    // Private network check on resolved IP
    const isResRestrictedV4 = resV4 !== null && inIpv4RestrictedRange(resV4);
    const isResRestrictedV6 = resV6 !== null && inIpv6RestrictedRange(resV6);

    if ((isResRestrictedV4 || isResRestrictedV6) && !allowPrivate) {
      throw new AIProviderError({
        message: `DNS resolution of '${host}' points to prohibited private/internal address (${resolvedIp})`,
        code: "CONFIGURATION_ERROR",
        provider: "ollama",
      });
    }
  }

  // All resolved IP addresses passed security validation!
  // Pin connection to the first validated address.
  const pinnedIp = resolved[0].address;
  const pinnedFamily = resolved[0].family;

  return {
    cleanUrl,
    urlObj,
    hostname: host,
    port,
    isHttps,
    pinnedIp,
    pinnedFamily,
    allResolvedIps,
  };
}

/**
 * Asynchronously verifies that an Ollama base URL does not violate SSRF constraints,
 * resolving DNS to prevent DNS rebinding attacks and blocking internal/metadata endpoints.
 */
export async function assertSafeOllamaUrl(
  rawUrl: string,
  options: OllamaValidationOptions = {},
): Promise<string> {
  const endpoint = await resolveAndValidateOllamaEndpoint(rawUrl, options);
  return endpoint.cleanUrl;
}

/**
 * Outbound HTTP client for Ollama that executes requests pinned to the
 * pre-validated IP address, strictly defeating DNS rebinding and TOCTOU vulnerabilities.
 * Preserves HTTP Host header, TLS SNI, and strict TLS certificate verification.
 */
export async function safeOllamaFetch(
  urlInput: string | URL,
  init: RequestInit = {},
  options: OllamaValidationOptions = {},
): Promise<Response> {
  const endpoint = await resolveAndValidateOllamaEndpoint(urlInput.toString(), options);

  const parsedUrl = new URL(urlInput.toString());
  const method = (init.method || "GET").toUpperCase();

  // Normalize request headers
  const reqHeaders: Record<string, string> = {};
  if (init.headers) {
    if (init.headers instanceof Headers) {
      init.headers.forEach((v, k) => {
        reqHeaders[k.toLowerCase()] = v;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [k, v] of init.headers) {
        reqHeaders[k.toLowerCase()] = v;
      }
    } else {
      for (const [k, v] of Object.entries(init.headers)) {
        if (v !== undefined) {
          reqHeaders[k.toLowerCase()] = String(v);
        }
      }
    }
  }
  // Ensure the original Host header is preserved
  reqHeaders["host"] = parsedUrl.host;

  const transport = endpoint.isHttps ? https : http;
  const maxBodySizeBytes = 50 * 1024 * 1024; // 50MB limit

  return new Promise<Response>((resolve, reject) => {
    let completed = false;
    const done = (err: Error | null, res?: Response) => {
      if (completed) return;
      completed = true;
      if (err) reject(err);
      else if (res) resolve(res);
    };

    const reqOptions: http.RequestOptions = {
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: parsedUrl.pathname + parsedUrl.search,
      method,
      headers: reqHeaders,
      // Pin connection to the pre-validated IP; prevents DNS rebinding / TOCTOU completely
      lookup: (_hostname, lookupOptions, callback) => {
        const returnsAllAddresses =
          typeof lookupOptions === "object" &&
          lookupOptions !== null &&
          "all" in lookupOptions &&
          lookupOptions.all;

        return returnsAllAddresses
          ? callback(null, [{ address: endpoint.pinnedIp, family: endpoint.pinnedFamily }] as any)
          : callback(null, endpoint.pinnedIp, endpoint.pinnedFamily);
      },
    };

    if (endpoint.isHttps) {
      // Set servername for TLS SNI and certificate validation against the original hostname
      (reqOptions as https.RequestOptions).servername = endpoint.hostname;
      // Note: rejectUnauthorized is intentionally NOT set to false, preserving full TLS validation
    }

    const req = transport.request(reqOptions, (res) => {
      const statusCode = res.statusCode || 200;

      // Block all redirects to defeat redirect-based SSRF
      if (statusCode >= 300 && statusCode < 400) {
        req.destroy();
        return done(
          new AIProviderError({
            message:
              "Ollama endpoint returned an unexpected HTTP redirect; redirects are disabled for SSRF protection",
            code: "CONFIGURATION_ERROR",
            provider: "ollama",
            retryable: false,
          }),
        );
      }

      // Check Content-Length if present
      const clHeader = res.headers["content-length"];
      if (clHeader) {
        const cl = parseInt(clHeader, 10);
        if (!Number.isNaN(cl) && cl > maxBodySizeBytes) {
          req.destroy();
          return done(
            new AIProviderError({
              message: `Ollama response exceeded maximum allowed size of ${maxBodySizeBytes} bytes`,
              code: "INVALID_RESPONSE",
              provider: "ollama",
              retryable: false,
            }),
          );
        }
      }

      const chunks: Buffer[] = [];
      let totalBytes = 0;

      res.on("data", (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxBodySizeBytes) {
          req.destroy();
          return done(
            new AIProviderError({
              message: `Ollama response exceeded maximum allowed size of ${maxBodySizeBytes} bytes`,
              code: "INVALID_RESPONSE",
              provider: "ollama",
              retryable: false,
            }),
          );
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        const bodyBuffer = Buffer.concat(chunks);
        const resHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (Array.isArray(v)) {
            for (const item of v) resHeaders.append(k, item);
          } else if (v !== undefined) {
            resHeaders.set(k, v);
          }
        }

        const response = new Response(bodyBuffer, {
          status: statusCode,
          statusText: res.statusMessage || "OK",
          headers: resHeaders,
        });

        done(null, response);
      });

      res.on("error", (err) => done(err));
    });

    if (init.signal) {
      if (init.signal.aborted) {
        req.destroy(new Error("The operation was aborted"));
        return;
      }
      init.signal.addEventListener(
        "abort",
        () => {
          req.destroy(new Error("The operation was aborted"));
        },
        { once: true },
      );
    }

    req.on("error", (err) => done(err));

    if (init.body !== null && init.body !== undefined) {
      if (typeof init.body === "string" || Buffer.isBuffer(init.body)) {
        req.write(init.body);
      } else {
        req.write(Buffer.from(init.body as any));
      }
    }
    req.end();
  });
}

export class OllamaProvider implements AIProvider {
  public readonly providerType: AIProviderType = "ollama";
  public readonly defaultModel: string;
  public readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: (url: string | URL, init?: RequestInit) => Promise<Response>;
  private readonly customFetch?: typeof fetch;
  private readonly validationOptions: OllamaValidationOptions;

  constructor(
    config: AIProviderConfig = {},
    customFetch?: typeof fetch,
    options: OllamaValidationOptions = {},
  ) {
    const rawUrl =
      config.baseUrl ||
      process.env.OLLAMA_BASE_URL ||
      env.OLLAMA_BASE_URL ||
      "http://127.0.0.1:11434";

    this.validationOptions = options;
    this.baseUrl = validateOllamaBaseUrl(rawUrl, options);
    this.defaultModel =
      config.model || process.env.OLLAMA_MODEL || env.OLLAMA_MODEL || "llama3.2";
    this.timeoutMs = config.timeoutMs || 120000;
    this.customFetch = customFetch;
    this.fetchFn = customFetch ?? ((url, init) => safeOllamaFetch(url, init, this.validationOptions));
  }

  async generateText(options: AIGenerateOptions): Promise<AIGenerateResult> {
    const model = options.model || this.defaultModel;
    const maxOutputTokens = options.maxOutputTokens ?? 4096;
    const temperature = options.temperature ?? 0.2;
    const t0 = Date.now();

    try {
      const ollamaPayload: Record<string, unknown> = {
        model,
        prompt: options.prompt,
        stream: false,
        options: {
          temperature,
          num_predict: maxOutputTokens,
        },
      };

      if (options.systemInstruction) {
        ollamaPayload.system = options.systemInstruction;
      }

      if (options.stopSequences && options.stopSequences.length > 0) {
        (ollamaPayload.options as Record<string, unknown>).stop = options.stopSequences;
      }

      if (options.responseFormat === "json") {
        ollamaPayload.format = "json";
      }

      // Timeout controller
      const timeoutMs = options.timeoutMs || this.timeoutMs;
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;

      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new AIProviderError({
              message: `Ollama request timed out after ${timeoutMs}ms`,
              code: "TIMEOUT",
              provider: "ollama",
              retryable: true,
            }),
          );
        }, timeoutMs);
      });

      // Pre-flight SSRF and DNS rebinding validation when customFetch is supplied (e.g. test mock environments).
      // safeOllamaFetch performs single-resolution DNS validation and socket IP pinning by default.
      if (this.customFetch) {
        await assertSafeOllamaUrl(this.baseUrl, this.validationOptions);
      }

      const fetchPromise = (async () => {
        try {
          const res = await this.fetchFn(`${this.baseUrl}/api/generate`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(ollamaPayload),
            signal: controller.signal,
            redirect: "manual",
          });

          if (res.status >= 300 && res.status < 400) {
            throw new AIProviderError({
              message: "Ollama endpoint returned an unexpected HTTP redirect; redirects are disabled for SSRF protection",
              code: "CONFIGURATION_ERROR",
              provider: "ollama",
              retryable: false,
            });
          }

          if (!res.ok) {
            let errorText = "";
            try {
              const errJson = await res.json();
              errorText = errJson.error || JSON.stringify(errJson);
            } catch {
              errorText = await res.text();
            }

            if (res.status === 404 || errorText.toLowerCase().includes("not found")) {
              throw new AIProviderError({
                message: `Ollama model '${model}' is not available or not installed. Run 'ollama pull ${model}' to install it.`,
                code: "MODEL_UNAVAILABLE",
                provider: "ollama",
                statusCode: 404,
                retryable: false,
              });
            }

            throw new Error(`HTTP ${res.status}: ${errorText}`);
          }

          return await res.json();
        } catch (err) {
          if (err instanceof AIProviderError) throw err;
          throw err;
        }
      })();

      let data: any;
      try {
        data = await Promise.race([fetchPromise, timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }

      const durationMs = Date.now() - t0;

      if (!data || typeof data.response !== "string" || !data.response.trim()) {
        throw new AIProviderError({
          message: "Ollama returned an empty response",
          code: "INVALID_RESPONSE",
          provider: "ollama",
          retryable: true,
        });
      }

      let text = data.response.trim();
      if (options.responseFormat === "json") {
        if (text.startsWith("```json")) {
          text = text.slice(7);
        } else if (text.startsWith("```")) {
          text = text.slice(3);
        }
        if (text.endsWith("```")) {
          text = text.slice(0, -3);
        }
        text = text.trim();
      }

      // Extract usage tokens
      let promptTokens: number;
      let completionTokens: number;
      let isUsageEstimated = false;

      if (
        typeof data.prompt_eval_count === "number" &&
        typeof data.eval_count === "number"
      ) {
        promptTokens = data.prompt_eval_count;
        completionTokens = data.eval_count;
        isUsageEstimated = false;
      } else {
        promptTokens = Math.ceil((options.prompt.length + (options.systemInstruction?.length || 0)) / 4);
        completionTokens = Math.ceil(text.length / 4);
        isUsageEstimated = true;
      }

      const totalTokens = promptTokens + completionTokens;
      // Note: Ollama API token cost is $0.00 (local hardware/hosting costs apply separately)
      const estimatedCostUsd = calculateEstimatedCostUsd(model, promptTokens, completionTokens, "ollama");

      return {
        text,
        promptTokens,
        completionTokens,
        totalTokens,
        estimatedCostUsd,
        model,
        provider: "ollama",
        durationMs,
        isUsageEstimated,
      };
    } catch (error) {
      if (error instanceof AIProviderError) {
        throw error;
      }
      throw this.normalizeError(error, model);
    }
  }

  async testConnection(): Promise<AIConnectionTestResult> {
    const t0 = Date.now();
    try {
      if (this.customFetch) {
        await assertSafeOllamaUrl(this.baseUrl, this.validationOptions);
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);

      const res = await this.fetchFn(`${this.baseUrl}/api/tags`, {
        method: "GET",
        signal: controller.signal,
        redirect: "manual",
      }).finally(() => clearTimeout(timer));

      if (res.status >= 300 && res.status < 400) {
        throw new AIProviderError({
          message: "Ollama endpoint returned an unexpected HTTP redirect; redirects are disabled for SSRF protection",
          code: "CONFIGURATION_ERROR",
          provider: "ollama",
          retryable: false,
        });
      }

      const latencyMs = Date.now() - t0;

      if (!res.ok) {
        return {
          success: false,
          provider: "ollama",
          model: this.defaultModel,
          latencyMs,
          error: `Ollama returned HTTP ${res.status}: ${res.statusText}`,
        };
      }

      const data = await res.json();
      const models = Array.isArray(data?.models) ? data.models : [];

      // Check if requested default model is in the installed list
      const normalizedTarget = this.defaultModel.toLowerCase();
      const found = models.some((m: { name?: string }) => {
        const name = (m.name || "").toLowerCase();
        return (
          name === normalizedTarget ||
          name.startsWith(`${normalizedTarget}:`) ||
          normalizedTarget.startsWith(`${name}:`)
        );
      });

      if (!found && models.length > 0) {
        return {
          success: false,
          provider: "ollama",
          model: this.defaultModel,
          latencyMs,
          error: `Ollama service is reachable, but model '${this.defaultModel}' is not downloaded. Run 'ollama pull ${this.defaultModel}'. Available models: ${models.map((m: any) => m.name).join(", ")}`,
        };
      }

      return {
        success: true,
        provider: "ollama",
        model: this.defaultModel,
        latencyMs,
      };
    } catch (err) {
      const latencyMs = Date.now() - t0;
      const normalized = this.normalizeError(err, this.defaultModel);
      return {
        success: false,
        provider: "ollama",
        model: this.defaultModel,
        latencyMs,
        error: normalized.message,
      };
    }
  }

  private redactSecrets(text: string): string {
    if (!text) return "";
    let sanitized = text;
    for (const secret of [
      process.env.GEMINI_API_KEY,
      process.env.OPENAI_API_KEY,
      process.env.GROQ_API_KEY,
      env.PLATFORM_API_KEY,
      env.STOCKFLOW_TEST_PASSWORD,
    ]) {
      if (secret) {
        sanitized = sanitized.split(secret).join("[hidden]");
      }
    }
    return sanitized;
  }

  private normalizeError(error: unknown, model: string): AIProviderError {
    const rawMessage = this.redactSecrets(error instanceof Error ? error.message : String(error));
    const sanitizedOriginal =
      error instanceof Error
        ? { name: error.name, message: this.redactSecrets(error.message) }
        : { message: this.redactSecrets(String(error)) };
    const lower = rawMessage.toLowerCase();

    // Connection refused / service not running
    if (
      lower.includes("econnrefused") ||
      lower.includes("fetch failed") ||
      lower.includes("failed to fetch") ||
      lower.includes("connect econnrefused")
    ) {
      return new AIProviderError({
        message: `Ollama service is not running or unreachable at ${this.baseUrl}. Ensure Ollama is started ('ollama serve').`,
        code: "PROVIDER_UNAVAILABLE",
        provider: "ollama",
        statusCode: 503,
        retryable: true,
        originalError: sanitizedOriginal,
      });
    }

    // Model unavailable
    if (
      lower.includes("not found") ||
      lower.includes("pull") ||
      lower.includes("model not available")
    ) {
      return new AIProviderError({
        message: `Ollama model '${model}' is not available or not installed. Run 'ollama pull ${model}'.`,
        code: "MODEL_UNAVAILABLE",
        provider: "ollama",
        statusCode: 404,
        retryable: false,
        originalError: sanitizedOriginal,
      });
    }

    // Timeout
    if (lower.includes("timeout") || lower.includes("aborted")) {
      return new AIProviderError({
        message: `Ollama request timed out at ${this.baseUrl}`,
        code: "TIMEOUT",
        provider: "ollama",
        statusCode: 408,
        retryable: true,
        originalError: sanitizedOriginal,
      });
    }

    return new AIProviderError({
      message: `Ollama error: ${rawMessage}`,
      code: "UNKNOWN_ERROR",
      provider: "ollama",
      retryable: false,
      originalError: sanitizedOriginal,
    });
  }
}
