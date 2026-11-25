import { describe, it, expect, vi, beforeEach } from "vitest";
import dns from "node:dns/promises";
import http from "node:http";
import { EventEmitter } from "node:events";
import {
  OllamaProvider,
  validateOllamaBaseUrl,
  assertSafeOllamaUrl,
  resolveAndValidateOllamaEndpoint,
  safeOllamaFetch,
} from "../services/ai/ollamaProvider";
import { getAIProvider } from "../services/ai/providerFactory";
import { AIProviderError } from "../services/ai/types";

describe("Stage 3B: OllamaProvider & SSRF Security", () => {
  describe("Ollama URL Validation & SSRF Prevention", () => {
    it("accepts valid local Ollama loopback URLs", () => {
      expect(validateOllamaBaseUrl("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
      expect(validateOllamaBaseUrl("http://localhost:11434")).toBe("http://localhost:11434");
      expect(validateOllamaBaseUrl("http://[::1]:11434")).toBe("http://[::1]:11434");
      expect(validateOllamaBaseUrl("http://127.0.0.1:11434/")).toBe("http://127.0.0.1:11434");
    });

    it("rejects non-http and non-https protocols", () => {
      expect(() => validateOllamaBaseUrl("file:///etc/ollama")).toThrow(/Unsupported protocol/);
      expect(() => validateOllamaBaseUrl("ftp://localhost:11434")).toThrow(/Unsupported protocol/);
      expect(() => validateOllamaBaseUrl("gopher://localhost:11434")).toThrow(/Unsupported protocol/);
    });

    it("rejects URLs containing user credentials", () => {
      expect(() => validateOllamaBaseUrl("http://admin:secret@127.0.0.1:11434")).toThrow(
        /must not contain user credentials/,
      );
    });

    it("strictly blocks cloud metadata endpoints under all conditions", () => {
      expect(() => validateOllamaBaseUrl("http://169.254.169.254:80")).toThrow(
        /Access to cloud metadata service is strictly prohibited/,
      );
      expect(() => validateOllamaBaseUrl("http://169.254.170.2:80")).toThrow(
        /Access to cloud metadata service is strictly prohibited/,
      );
      expect(() => validateOllamaBaseUrl("http://metadata.google.internal")).toThrow(
        /Access to cloud metadata service is strictly prohibited/,
      );
      expect(() => validateOllamaBaseUrl("http://100.100.100.200")).toThrow(
        /Access to cloud metadata service is strictly prohibited/,
      );
    });

    it("strictly blocks link-local addresses", () => {
      expect(() => validateOllamaBaseUrl("http://169.254.10.20:11434")).toThrow(
        /Access to link-local addresses/,
      );
    });

    it("blocks private/internal network addresses when allowPrivateNetworks is false", () => {
      expect(() =>
        validateOllamaBaseUrl("http://192.168.1.50:11434", { allowPrivateNetworks: false }),
      ).toThrow(/Access to private or internal network address/);

      expect(() =>
        validateOllamaBaseUrl("http://10.0.1.10:11434", { allowPrivateNetworks: false }),
      ).toThrow(/Access to private or internal network address/);

      expect(() =>
        validateOllamaBaseUrl("http://172.16.5.5:11434", { allowPrivateNetworks: false }),
      ).toThrow(/Access to private or internal network address/);
    });

    it("blocks loopback addresses when allowLocalhost is explicitly false", () => {
      expect(() =>
        validateOllamaBaseUrl("http://127.0.0.1:11434", { allowLocalhost: false }),
      ).toThrow(/Access to loopback\/localhost addresses is disabled/);
    });

    it("throws CONFIGURATION_ERROR on empty or invalid URL format", () => {
      expect(() => validateOllamaBaseUrl("")).toThrow(/cannot be empty/);
      expect(() => validateOllamaBaseUrl("not-a-valid-url")).toThrow(/Invalid Ollama base URL format/);
    });

    it("assertSafeOllamaUrl blocks DNS rebinding when public domain resolves to loopback IP", async () => {
      const lookupSpy = vi.spyOn(dns, "lookup").mockResolvedValueOnce([
        { address: "127.0.0.1", family: 4 },
      ] as any);

      try {
        await expect(
          assertSafeOllamaUrl("http://rebind.attacker.test:11434"),
        ).rejects.toThrow(/DNS rebinding detected/);
      } finally {
        lookupSpy.mockRestore();
      }
    });

    it("assertSafeOllamaUrl blocks domain resolving to cloud metadata IP", async () => {
      const lookupSpy = vi.spyOn(dns, "lookup").mockResolvedValueOnce([
        { address: "169.254.169.254", family: 4 },
      ] as any);

      try {
        await expect(
          assertSafeOllamaUrl("http://meta-resolver.attacker.test:11434"),
        ).rejects.toThrow(/points to prohibited cloud metadata IP/);
      } finally {
        lookupSpy.mockRestore();
      }
    });
  });

  describe("DNS TOCTOU Rebinding & IP Pinning Security", () => {
    it("resolves and pins public hostname resolving to safe public IP", async () => {
      const lookupSpy = vi.spyOn(dns, "lookup").mockResolvedValueOnce([
        { address: "93.184.216.34", family: 4 },
      ] as any);

      try {
        const endpoint = await resolveAndValidateOllamaEndpoint("http://ollama.external.com:11434");
        expect(endpoint.pinnedIp).toBe("93.184.216.34");
        expect(endpoint.pinnedFamily).toBe(4);
        expect(endpoint.hostname).toBe("ollama.external.com");
        expect(endpoint.port).toBe(11434);
        expect(endpoint.isHttps).toBe(false);
        expect(endpoint.cleanUrl).toBe("http://ollama.external.com:11434");
      } finally {
        lookupSpy.mockRestore();
      }
    });

    it("blocks public hostname resolving to private IP when private network access is disabled", async () => {
      const lookupSpy = vi.spyOn(dns, "lookup").mockResolvedValueOnce([
        { address: "192.168.1.100", family: 4 },
      ] as any);

      try {
        await expect(
          resolveAndValidateOllamaEndpoint("http://private.attacker.test:11434", {
            allowPrivateNetworks: false,
          }),
        ).rejects.toThrow(/points to prohibited private\/internal address/);
      } finally {
        lookupSpy.mockRestore();
      }
    });

    it("blocks request if DNS returns multiple IPs and ANY of them is prohibited (mixed safe and loopback)", async () => {
      const lookupSpy = vi.spyOn(dns, "lookup").mockResolvedValueOnce([
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ] as any);

      try {
        await expect(
          resolveAndValidateOllamaEndpoint("http://multi.attacker.test:11434"),
        ).rejects.toThrow(/DNS rebinding detected: host 'multi.attacker.test' resolved to prohibited loopback address/);
      } finally {
        lookupSpy.mockRestore();
      }
    });

    it("blocks request if DNS returns multiple IPs and ANY of them is cloud metadata", async () => {
      const lookupSpy = vi.spyOn(dns, "lookup").mockResolvedValueOnce([
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.169.254", family: 4 },
      ] as any);

      try {
        await expect(
          resolveAndValidateOllamaEndpoint("http://meta-multi.attacker.test:11434"),
        ).rejects.toThrow(/points to prohibited cloud metadata IP/);
      } finally {
        lookupSpy.mockRestore();
      }
    });

    it("blocks request if DNS returns multiple IPs and ANY of them is link-local", async () => {
      const lookupSpy = vi.spyOn(dns, "lookup").mockResolvedValueOnce([
        { address: "93.184.216.34", family: 4 },
        { address: "169.254.10.10", family: 4 },
      ] as any);

      try {
        await expect(
          resolveAndValidateOllamaEndpoint("http://link-multi.attacker.test:11434"),
        ).rejects.toThrow(/points to prohibited link-local address/);
      } finally {
        lookupSpy.mockRestore();
      }
    });

    it("blocks DNS rebinding / TOCTOU: outbound socket pins to validated IP and never performs second DNS query", async () => {
      // Mock DNS resolution: first lookup returns safe public IP 93.184.216.34.
      // If a TOCTOU second lookup were performed during socket connection,
      // it would return 169.254.169.254 (metadata) or loopback.
      const lookupSpy = vi
        .spyOn(dns, "lookup")
        .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }] as any)
        .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }] as any);

      // Spy on http.request to verify socket pinning and Host header
      let interceptedLookupAddress = "";
      let interceptedLookupFamily = 0;
      let interceptedHostHeader = "";

      const requestSpy = vi.spyOn(http, "request").mockImplementationOnce((options: any, callback: any) => {
        interceptedHostHeader = options.headers?.host || options.headers?.Host || "";

        // Invoke the custom lookup function supplied to http.request
        options.lookup("corp-ollama.example.com", {}, (err: any, address: string, family: number) => {
          interceptedLookupAddress = address;
          interceptedLookupFamily = family;
        });

        const mockReq: any = new EventEmitter();
        mockReq.write = vi.fn();
        mockReq.end = vi.fn(() => {
          const mockRes: any = new EventEmitter();
          mockRes.statusCode = 200;
          mockRes.statusMessage = "OK";
          mockRes.headers = { "content-type": "application/json" };
          callback(mockRes);
          mockRes.emit("data", Buffer.from(JSON.stringify({ response: "pinned success", done: true })));
          mockRes.emit("end");
        });
        return mockReq;
      });

      try {
        const res = await safeOllamaFetch(
          "http://corp-ollama.example.com:11434/api/generate",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: "hi" }),
          },
        );

        expect(res.ok).toBe(true);
        const data = await res.json();
        expect(data.response).toBe("pinned success");

        // CRITICAL TOCTOU CHECK:
        // Exactly ONE DNS resolution took place! The second lookup (169.254.169.254) was NEVER queried.
        expect(lookupSpy).toHaveBeenCalledTimes(1);

        // Socket was pinned to the validated IP (93.184.216.34)
        expect(interceptedLookupAddress).toBe("93.184.216.34");
        expect(interceptedLookupFamily).toBe(4);

        // Host header was preserved as original hostname
        expect(interceptedHostHeader).toBe("corp-ollama.example.com:11434");
      } finally {
        lookupSpy.mockRestore();
        requestSpy.mockRestore();
      }
    });

    it("executes real end-to-end request via safeOllamaFetch against legitimate localhost Ollama", async () => {
      let receivedPath = "";
      const server = http.createServer((req, res) => {
        receivedPath = req.url || "";
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "llama3.2",
            response: "localhost response",
            done: true,
            prompt_eval_count: 12,
            eval_count: 8,
          }),
        );
      });

      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const port = (server.address() as any).port;

      try {
        // Instantiate without customFetch -> uses production safeOllamaFetch
        const provider = new OllamaProvider({ baseUrl: `http://127.0.0.1:${port}` });
        const result = await provider.generateText({ prompt: "hello localhost" });

        expect(result.text).toBe("localhost response");
        expect(result.promptTokens).toBe(12);
        expect(result.completionTokens).toBe(8);
        expect(result.totalTokens).toBe(20);
        expect(receivedPath).toBe("/api/generate");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it("blocks redirect to metadata endpoint even if 302 location specifies metadata", async () => {
      const redirectServer = http.createServer((req, res) => {
        res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
        res.end();
      });

      await new Promise<void>((resolve) => redirectServer.listen(0, "127.0.0.1", resolve));
      const port = (redirectServer.address() as any).port;

      try {
        await expect(
          safeOllamaFetch(`http://127.0.0.1:${port}/api/generate`, { method: "POST" }),
        ).rejects.toThrow(/redirects are disabled for SSRF protection/);
      } finally {
        await new Promise<void>((resolve) => redirectServer.close(() => resolve()));
      }
    });

    it("validates legitimate localhost Ollama across formats and enforces allowLocalhost", async () => {
      // 127.0.0.1
      const epV4 = await resolveAndValidateOllamaEndpoint("http://127.0.0.1:11434");
      expect(epV4.pinnedIp).toBe("127.0.0.1");
      expect(epV4.pinnedFamily).toBe(4);

      // localhost
      const epHost = await resolveAndValidateOllamaEndpoint("http://localhost:11434");
      expect(epHost.pinnedIp).toBe("127.0.0.1");
      expect(epHost.pinnedFamily).toBe(4);

      // IPv6 [::1]
      const epV6 = await resolveAndValidateOllamaEndpoint("http://[::1]:11434");
      expect(epV6.pinnedIp).toBe("::1");
      expect(epV6.pinnedFamily).toBe(6);

      // Disabled when allowLocalhost: false
      await expect(
        resolveAndValidateOllamaEndpoint("http://127.0.0.1:11434", { allowLocalhost: false }),
      ).rejects.toThrow(/Access to loopback\/localhost addresses is disabled/);

      await expect(
        resolveAndValidateOllamaEndpoint("http://localhost:11434", { allowLocalhost: false }),
      ).rejects.toThrow(/Access to loopback\/localhost addresses is disabled/);

      await expect(
        resolveAndValidateOllamaEndpoint("http://[::1]:11434", { allowLocalhost: false }),
      ).rejects.toThrow(/Access to loopback\/localhost addresses is disabled/);
    });

    it("handles IPv4 and IPv6 literals and domains correctly", async () => {
      // IPv4 link-local literal blocked
      await expect(
        resolveAndValidateOllamaEndpoint("http://169.254.1.1:11434"),
      ).rejects.toThrow(/Access to link-local addresses/);

      // IPv4 cloud metadata literal blocked
      await expect(
        resolveAndValidateOllamaEndpoint("http://169.254.169.254:11434"),
      ).rejects.toThrow(/Access to cloud metadata service is strictly prohibited/);

      // IPv6 link-local literal blocked
      await expect(
        resolveAndValidateOllamaEndpoint("http://[fe80::1]:11434"),
      ).rejects.toThrow(/Access to link-local addresses/);

      // IPv6 public literal allowed
      const epV6Pub = await resolveAndValidateOllamaEndpoint(
        "http://[2606:2800:220:1:248:1893:25c8:1946]:11434",
      );
      expect(epV6Pub.pinnedIp).toBe("2606:2800:220:1:248:1893:25c8:1946");
      expect(epV6Pub.pinnedFamily).toBe(6);

      // IPv6 domain resolving to IPv6 loopback blocked as DNS rebinding
      const lookupSpy = vi.spyOn(dns, "lookup").mockResolvedValueOnce([
        { address: "::1", family: 6 },
      ] as any);
      try {
        await expect(
          resolveAndValidateOllamaEndpoint("http://v6rebind.attacker.test:11434"),
        ).rejects.toThrow(/DNS rebinding detected/);
      } finally {
        lookupSpy.mockRestore();
      }

      // IPv6 domain resolving to IPv6 link-local blocked
      const lookupSpy2 = vi.spyOn(dns, "lookup").mockResolvedValueOnce([
        { address: "fe80::1", family: 6 },
      ] as any);
      try {
        await expect(
          resolveAndValidateOllamaEndpoint("http://v6link.attacker.test:11434"),
        ).rejects.toThrow(/points to prohibited link-local address/);
      } finally {
        lookupSpy2.mockRestore();
      }

      // IPv6 domain resolving to public IPv6 allowed with family 6
      const lookupSpy3 = vi.spyOn(dns, "lookup").mockResolvedValueOnce([
        { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 },
      ] as any);
      try {
        const ep = await resolveAndValidateOllamaEndpoint("http://v6pub.domain.test:11434");
        expect(ep.pinnedIp).toBe("2606:2800:220:1:248:1893:25c8:1946");
        expect(ep.pinnedFamily).toBe(6);
      } finally {
        lookupSpy3.mockRestore();
      }
    });
  });

  describe("OllamaProvider Text Generation", () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
    });

    it("initializes and registers in factory", () => {
      const provider = getAIProvider("ollama", { baseUrl: "http://127.0.0.1:11434" });
      expect(provider).toBeInstanceOf(OllamaProvider);
      expect(provider.providerType).toBe("ollama");
      expect(provider.defaultModel).toBe("llama3.2");
    });

    it("executes text generation and extracts token metrics", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: "llama3.2",
          response: '{"cases": ["Case A", "Case B"]}',
          done: true,
          prompt_eval_count: 55,
          eval_count: 22,
        }),
      });

      const provider = new OllamaProvider(
        { baseUrl: "http://127.0.0.1:11434", model: "llama3.2" },
        mockFetch as any,
      );

      const result = await provider.generateText({
        prompt: "Generate 2 test cases",
        systemInstruction: "You are a QA Engineer",
        temperature: 0.2,
        maxOutputTokens: 2048,
        responseFormat: "json",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "http://127.0.0.1:11434/api/generate",
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "llama3.2",
            prompt: "Generate 2 test cases",
            stream: false,
            options: {
              temperature: 0.2,
              num_predict: 2048,
            },
            system: "You are a QA Engineer",
            format: "json",
          }),
        }),
      );

      expect(result.text).toBe('{"cases": ["Case A", "Case B"]}');
      expect(result.promptTokens).toBe(55);
      expect(result.completionTokens).toBe(22);
      expect(result.totalTokens).toBe(77);
      expect(result.isUsageEstimated).toBe(false);
      expect(result.estimatedCostUsd).toBe(0); // Free API tokens for local Ollama
      expect(result.provider).toBe("ollama");
    });

    it("falls back to token estimation when Ollama response lacks eval counts", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: "llama3.2",
          response: '{"cases": ["Fallback case"]}',
          done: true,
        }),
      });

      const provider = new OllamaProvider(
        { baseUrl: "http://127.0.0.1:11434" },
        mockFetch as any,
      );

      const prompt = "Short prompt";
      const result = await provider.generateText({ prompt });

      expect(result.isUsageEstimated).toBe(true);
      expect(result.promptTokens).toBe(Math.ceil(prompt.length / 4));
      expect(result.completionTokens).toBe(Math.ceil('{"cases": ["Fallback case"]}'.length / 4));
    });

    it("strips markdown code fences when format is json", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          model: "llama3.2",
          response: '```json\n{"status": "ready"}\n```',
          done: true,
          prompt_eval_count: 10,
          eval_count: 5,
        }),
      });

      const provider = new OllamaProvider(
        { baseUrl: "http://127.0.0.1:11434" },
        mockFetch as any,
      );

      const result = await provider.generateText({
        prompt: "JSON test",
        responseFormat: "json",
      });

      expect(result.text).toBe('{"status": "ready"}');
    });

    it("normalizes connection failure (ECONNREFUSED) to PROVIDER_UNAVAILABLE (retryable)", async () => {
      mockFetch.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:11434"));

      const provider = new OllamaProvider(
        { baseUrl: "http://127.0.0.1:11434" },
        mockFetch as any,
      );

      await expect(provider.generateText({ prompt: "test" })).rejects.toMatchObject({
        code: "PROVIDER_UNAVAILABLE",
        provider: "ollama",
        statusCode: 503,
        retryable: true,
      });
    });

    it("normalizes model not found (404) to MODEL_UNAVAILABLE with pull instructions", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ error: "model 'unknown-model' not found, try pulling it first" }),
      });

      const provider = new OllamaProvider(
        { baseUrl: "http://127.0.0.1:11434", model: "unknown-model" },
        mockFetch as any,
      );

      await expect(provider.generateText({ prompt: "test" })).rejects.toMatchObject({
        code: "MODEL_UNAVAILABLE",
        provider: "ollama",
        statusCode: 404,
        retryable: false,
      });
    });

    it("throws TIMEOUT when request exceeds configured timeout", async () => {
      mockFetch.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(resolve, 200)),
      );

      const provider = new OllamaProvider(
        { baseUrl: "http://127.0.0.1:11434", timeoutMs: 50 },
        mockFetch as any,
      );

      await expect(
        provider.generateText({ prompt: "timeout test", timeoutMs: 50 }),
      ).rejects.toMatchObject({
        code: "TIMEOUT",
        provider: "ollama",
        retryable: true,
      });
    });

    it("rejects HTTP redirects (e.g. 302) to prevent redirect-based SSRF", async () => {
      mockFetch.mockResolvedValueOnce({
        status: 302,
        headers: { get: () => "http://169.254.169.254/latest/meta-data" },
      });

      const provider = new OllamaProvider(
        { baseUrl: "http://127.0.0.1:11434" },
        mockFetch as any,
      );

      await expect(provider.generateText({ prompt: "redirect test" })).rejects.toMatchObject({
        code: "CONFIGURATION_ERROR",
        provider: "ollama",
        message: expect.stringMatching(/redirects are disabled for SSRF protection/),
      });
    });

    it("throws INVALID_RESPONSE on empty response payload", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ response: "   " }),
      });

      const provider = new OllamaProvider(
        { baseUrl: "http://127.0.0.1:11434" },
        mockFetch as any,
      );

      await expect(provider.generateText({ prompt: "empty" })).rejects.toMatchObject({
        code: "INVALID_RESPONSE",
        provider: "ollama",
        retryable: true,
      });
    });
  });

  describe("Ollama Connection Testing (testConnection)", () => {
    let mockFetch: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      mockFetch = vi.fn();
    });

    it("returns success: true when Ollama is running and model is downloaded", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: "llama3.2:latest", size: 2000000000 },
            { name: "codellama:7b", size: 3800000000 },
          ],
        }),
      });

      const provider = new OllamaProvider(
        { baseUrl: "http://127.0.0.1:11434", model: "llama3.2" },
        mockFetch as any,
      );

      const res = await provider.testConnection();
      expect(res.success).toBe(true);
      expect(res.provider).toBe("ollama");
      expect(res.model).toBe("llama3.2");
      expect(res.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("returns success: false when Ollama is running but requested model is missing", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{ name: "mistral:latest" }],
        }),
      });

      const provider = new OllamaProvider(
        { baseUrl: "http://127.0.0.1:11434", model: "llama3.2" },
        mockFetch as any,
      );

      const res = await provider.testConnection();
      expect(res.success).toBe(false);
      expect(res.provider).toBe("ollama");
      expect(res.error).toContain("model 'llama3.2' is not downloaded");
    });

    it("returns success: false with friendly error when Ollama service is unreachable", async () => {
      mockFetch.mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:11434"));

      const provider = new OllamaProvider(
        { baseUrl: "http://127.0.0.1:11434" },
        mockFetch as any,
      );

      const res = await provider.testConnection();
      expect(res.success).toBe(false);
      expect(res.provider).toBe("ollama");
      expect(res.error).toContain("Ollama service is not running or unreachable");
    });
  });
});
