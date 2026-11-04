import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL = "postgresql://localhost/test";
process.env.GEMINI_API_KEY = "test-gemini-key";
process.env.AI_MODEL = "test-model";
process.env.PLATFORM_API_KEY = "test-platform-api-key-12345";
process.env.ALLOW_PRIVATE_TARGETS = "true";

vi.mock("../services/secretStore", () => ({
  getProjectAccess: vi.fn().mockResolvedValue(null),
}));

describe("web automation authentication", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())),
      );
    }
    server = undefined;
  });

  it("signs into the configured StockFlow origin before running saved steps", async () => {
    const html = `<!doctype html>
      <html><body>
        <h1>Welcome back</h1>
        <form>
          <label>Email address<input type="email" placeholder="Email address"></label>
          <label>Password<input type="password" placeholder="Password"></label>
          <button type="submit">Sign in</button>
        </form>
        <script>
          document.querySelector("form").addEventListener("submit", (event) => {
            event.preventDefault();
            document.body.innerHTML = "<h1>Dashboard</h1>";
          });
        </script>
      </body></html>`;
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(html);
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Could not start the local authentication test server");
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    process.env.STOCKFLOW_BASE_URL = baseUrl;
    process.env.STOCKFLOW_TEST_EMAIL = "qa-user@example.test";
    process.env.STOCKFLOW_TEST_PASSWORD = "qa-password-fixture";
    vi.resetModules();

    const { runTestCase } = await import("../services/runner");
    const result = await runTestCase(
      baseUrl,
      ["expect text Dashboard"],
      { runId: randomUUID(), resultId: randomUUID() },
      { projectId: randomUUID() },
    );

    expect(result.status).toBe("passed");
    expect(result.evidence.errorMessage).toBeNull();
  });
});
