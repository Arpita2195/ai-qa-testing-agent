import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { pool } from "../config/db";
import {
  extractTextFromDocument,
  detectFileType,
  DocumentProcessingError,
} from "../services/documentParser";
import {
  generateTestCasesFromRequirements,
  requirementTestCaseSchema,
  RequirementsGenerationError,
} from "../services/requirementsGenerator";
import requirementRoutes from "../routes/requirements";
import testCaseRoutes from "../routes/testCases";
import { createAuthHook } from "../services/auth";
import { AccessDeniedError } from "../services/authService";
import { callGeminiWithRetry } from "../services/generator";

vi.mock("../config/db", () => ({
  pool: {
    query: vi.fn(),
    connect: vi.fn(),
  },
}));

vi.mock("../services/generator", () => ({
  callGeminiWithRetry: vi.fn(),
  isRetryableGeminiError: vi.fn().mockReturnValue(false),
}));

const mockedCallGemini = vi.mocked(callGeminiWithRetry);

describe("TASK 6: Requirements-Based AI Test Case Generation", () => {
  const testProjectId = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const testDocId = "b0eebc99-9c0b-4ef8-bb6d-6bb9bd380b22";
  const validApiKey = "test-platform-key";

  describe("Document Parsing & Text Extraction", () => {
    it("correctly identifies supported file types", () => {
      expect(detectFileType("spec.pdf")).toBe("pdf");
      expect(detectFileType("requirements.docx")).toBe("docx");
      expect(detectFileType("user_stories.txt")).toBe("txt");
      expect(detectFileType("notes.md")).toBe("txt");
    });

    it("rejects unsupported file formats with clear error message", () => {
      expect(() => detectFileType("payload.exe")).toThrowError(DocumentProcessingError);
      expect(() => detectFileType("image.png")).toThrowError(DocumentProcessingError);
    });

    it("extracts and normalizes text from plain text buffer", async () => {
      const sampleText = `User Authentication Requirements:
1. The user must be able to sign in using their email and password.
2. If invalid credentials are provided, show an error message.
3. Password must be at least 8 characters long.`;

      const buffer = Buffer.from(sampleText, "utf8");
      const result = await extractTextFromDocument(buffer, "srs.txt", "text/plain");

      expect(result.fileType).toBe("txt");
      expect(result.filename).toBe("srs.txt");
      expect(result.characterCount).toBeGreaterThan(50);
      expect(result.wordCount).toBeGreaterThan(15);
      expect(result.text).toContain("User Authentication Requirements");
    });

    it("rejects empty files with HTTP 400", async () => {
      const emptyBuffer = Buffer.alloc(0);
      await expect(extractTextFromDocument(emptyBuffer, "empty.txt")).rejects.toThrow(
        "The uploaded file is empty.",
      );
    });

    it("rejects files with insufficient text (< 20 characters)", async () => {
      const tinyBuffer = Buffer.from("Too short", "utf8");
      await expect(extractTextFromDocument(tinyBuffer, "short.txt")).rejects.toThrow(
        "Insufficient text extracted",
      );
    });

    it("rejects oversized documents exceeding 10 MB", async () => {
      const hugeBuffer = Buffer.alloc(11 * 1024 * 1024);
      await expect(extractTextFromDocument(hugeBuffer, "huge.txt")).rejects.toThrow(
        "exceeds the maximum allowed limit of 10 MB",
      );
    });
  });

  describe("Gemini Requirements AI Test Case Generation", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("generates comprehensive test cases covering positive, negative, boundary, and edge_case types", async () => {
      const mockAiResponse = JSON.stringify([
        {
          title: "Successful user login with valid credentials",
          requirement_description: "REQ-1: Users must be able to log in with valid email and password",
          preconditions: "User account exists and is activated",
          steps: [
            "Navigate to /login",
            "Enter valid email and password",
            "Click Sign In button",
          ],
          expected_result: "Redirect to dashboard with authenticated session cookie",
          priority: "critical",
          test_type: "positive",
        },
        {
          title: "Login rejected when password is wrong",
          requirement_description: "REQ-1.1: System must reject invalid password with 401",
          preconditions: "User account exists",
          steps: [
            "Navigate to /login",
            "Enter valid email with wrong password",
            "Click Sign In",
          ],
          expected_result: "Display error message 'Invalid email or password'",
          priority: "high",
          test_type: "negative",
        },
        {
          title: "Password length exactly 8 characters boundary check",
          requirement_description: "REQ-2: Minimum password length is 8 characters",
          preconditions: "User registration page open",
          steps: [
            "Enter 8-character password 'Abc1234!'",
            "Submit registration form",
          ],
          expected_result: "Registration accepts exactly 8 characters",
          priority: "medium",
          test_type: "boundary",
        },
        {
          title: "Concurrent login attempts with Unicode characters in email",
          requirement_description: "REQ-1.2: System handles unusual characters and edge cases gracefully",
          preconditions: "System online",
          steps: [
            "Attempt sign-in with non-standard international characters",
            "Simulate concurrent login requests",
          ],
          expected_result: "System sanitizes input and returns standardized error",
          priority: "low",
          test_type: "edge_case",
        },
      ]);

      mockedCallGemini.mockResolvedValueOnce(mockAiResponse);

      const testCases = await generateTestCasesFromRequirements("Sample requirement text...", {
        name: "Test App",
        baseUrl: "https://example.com",
      });

      expect(testCases.length).toBe(4);
      const types = testCases.map((tc) => tc.test_type);
      expect(types).toContain("positive");
      expect(types).toContain("negative");
      expect(types).toContain("boundary");
      expect(types).toContain("edge_case");

      for (const tc of testCases) {
        expect(requirementTestCaseSchema.safeParse(tc).success).toBe(true);
        expect(tc.title).toBeTruthy();
        expect(tc.preconditions).toBeTruthy();
        expect(tc.steps.length).toBeGreaterThan(0);
        expect(tc.expected_result).toBeTruthy();
      }
    });

    it("throws RequirementsGenerationError when AI returns invalid JSON", async () => {
      mockedCallGemini.mockResolvedValueOnce("Invalid response not in json format");
      await expect(generateTestCasesFromRequirements("Requirements")).rejects.toThrowError(
        RequirementsGenerationError,
      );
    });
  });

  describe("Requirements HTTP API Endpoints", () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      vi.clearAllMocks();
      app = Fastify();
      app.setErrorHandler((error, _request, reply) => {
        if (error instanceof AccessDeniedError || (error as any).statusCode === 403) {
          return reply.code(403).send({ error: error.message });
        }
        reply.code((error as any).statusCode || 500).send({ error: error.message });
      });

      app.register(cookie);
      app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });
      app.addHook("onRequest", createAuthHook(validApiKey));
      app.register(requirementRoutes);
      app.register(testCaseRoutes);
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it("requires authentication for requirements endpoints", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/requirements/generate`,
        payload: { text: "Some long requirements text here..." },
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects unauthorized users with viewer role from generating test cases (RBAC)", async () => {
      // Mock session as viewer
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("FROM sessions s")) {
          return {
            rowCount: 1,
            rows: [
              {
                session_id: "sess-v",
                user_id: "user-viewer",
                token_hash: "hash",
                csrf_token: "csrf-token-123",
                expires_at: new Date(Date.now() + 100000),
                email: "viewer@example.com",
                full_name: "Viewer User",
                role: "viewer",
                is_active: true,
              },
            ],
          } as any;
        }
        if (sql.includes("FROM project_members")) {
          return { rowCount: 1, rows: [{ role: "viewer" }] } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/requirements/generate`,
        cookies: { qa_session: "viewer-session" },
        headers: { "x-csrf-token": "csrf-token-123" },
        payload: {
          filename: "srs.txt",
          text: "User Stories: As an authenticated user I want to reset my password safely.",
        },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toContain("Action requires 'qa_engineer'");
    });

    it("successfully uploads requirement document and generates pending test cases (QA Engineer)", async () => {
      // Mock project check
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("FROM projects WHERE id = $1")) {
          return {
            rowCount: 1,
            rows: [{ id: testProjectId, name: "StockFlow", base_url: "https://stockflow.example.com" }],
          } as any;
        }
        if (sql.includes("INSERT INTO requirement_documents")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: testDocId,
                project_id: testProjectId,
                user_id: "user-qa",
                filename: "requirements.txt",
                file_type: "txt",
                file_size: 250,
                extracted_text: "Requirements text...",
                created_at: new Date(),
              },
            ],
          } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes("INSERT INTO test_cases")) {
            return {
              rowCount: 1,
              rows: [
                {
                  id: "tc-req-1",
                  project_id: testProjectId,
                  title: "Test Case 1",
                  description: "Requirement 1 description",
                  steps: ["Step 1", "Step 2"],
                  expected_result: "Expected success",
                  preconditions: "User logged in",
                  priority: "high",
                  test_type: "positive",
                  review_status: "pending",
                  requirement_doc_id: testDocId,
                },
              ],
            };
          }
          return { rowCount: 1, rows: [] };
        }),
        release: vi.fn(),
      };
      vi.mocked(pool.connect).mockResolvedValue(mockClient as any);

      mockedCallGemini.mockResolvedValueOnce(
        JSON.stringify([
          {
            title: "Test Case 1",
            requirement_description: "Requirement 1 description",
            preconditions: "User logged in",
            steps: ["Step 1", "Step 2"],
            expected_result: "Expected success",
            priority: "high",
            test_type: "positive",
          },
        ]),
      );

      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/requirements/generate`,
        headers: { "x-api-key": validApiKey },
        payload: {
          filename: "requirements.txt",
          text: "Functional Requirements: User must be able to view inventory report and filter by warehouse location.",
        },
      });

      expect(res.statusCode).toBe(201);
      const json = res.json();
      expect(json.document.id).toBe(testDocId);
      expect(json.generated_count).toBe(1);
      expect(json.test_cases[0].review_status).toBe("pending");
      expect(json.test_cases[0].test_type).toBe("positive");
    });

    it("allows QA Manager to batch approve requirement test cases", async () => {
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("UPDATE test_cases") && sql.includes("review_status = 'approved'")) {
          return { rowCount: 5, rows: [] } as any;
        }
        return { rowCount: 1, rows: [] } as any;
      });

      const res = await app.inject({
        method: "POST",
        url: `/projects/${testProjectId}/requirements/batch-approve`,
        headers: { "x-api-key": validApiKey },
        payload: {
          documentId: testDocId,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().approved_count).toBe(5);
    });

    it("allows QA Engineer to edit test case details via PATCH /test-cases/:id", async () => {
      vi.mocked(pool.query).mockImplementation(async (sql: string) => {
        if (sql.includes("SELECT project_id FROM test_cases WHERE id = $1")) {
          return { rowCount: 1, rows: [{ project_id: testProjectId }] } as any;
        }
        if (sql.includes("UPDATE test_cases SET")) {
          return {
            rowCount: 1,
            rows: [
              {
                id: "tc-1",
                title: "Updated Title",
                description: "Updated Requirement",
                preconditions: "New Preconditions",
                steps: ["Updated step 1", "Updated step 2"],
                expected_result: "New outcome",
                priority: "critical",
                test_type: "boundary",
                review_status: "pending",
              },
            ],
          } as any;
        }
        return { rowCount: 0, rows: [] } as any;
      });

      const res = await app.inject({
        method: "PATCH",
        url: "/test-cases/a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        headers: { "x-api-key": validApiKey },
        payload: {
          title: "Updated Title",
          preconditions: "New Preconditions",
          priority: "critical",
          test_type: "boundary",
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().title).toBe("Updated Title");
      expect(res.json().priority).toBe("critical");
      expect(res.json().test_type).toBe("boundary");
    });
  });
});
