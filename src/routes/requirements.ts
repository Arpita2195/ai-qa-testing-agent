import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { assertProjectAccess } from "../services/authService";
import { extractTextFromDocument, DocumentProcessingError } from "../services/documentParser";
import { generateTestCasesFromRequirements, RequirementsGenerationError } from "../services/requirementsGenerator";
import { logAuditEvent } from "../services/auditLogger";
import { redactSecrets } from "../services/runner";

const projectParamsSchema = z.object({
  projectId: z.string().uuid(),
});

const docParamsSchema = z.object({
  projectId: z.string().uuid(),
  documentId: z.string().uuid(),
});

const jsonGenerateBodySchema = z.object({
  filename: z.string().min(1).max(255).default("requirements.txt"),
  fileType: z.enum(["pdf", "docx", "txt"]).optional(),
  contentBase64: z.string().optional(),
  text: z.string().min(20).optional(),
}).refine((data) => data.contentBase64 !== undefined || data.text !== undefined, {
  message: "Either text or contentBase64 must be provided",
});

const batchApproveBodySchema = z.object({
  documentId: z.string().uuid().optional(),
  testCaseIds: z.array(z.string().uuid()).optional(),
});

interface ProjectRow {
  id: string;
  name: string;
  base_url: string;
}

interface RequirementDocRow {
  id: string;
  project_id: string;
  user_id: string | null;
  filename: string;
  file_type: string;
  file_size: number;
  extracted_text: string;
  generated_count: number;
  created_at: Date;
}

const requirementRoutes: FastifyPluginAsync = async (fastify) => {
  // 1. Upload requirements document and generate AI test cases
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/requirements/generate",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "qa_engineer");
      }

      const projectResult = await pool.query<ProjectRow>(
        "SELECT id, name, base_url FROM projects WHERE id = $1",
        [params.data.projectId],
      );
      const project = projectResult.rows[0];
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      let filename = "requirements.txt";
      let buffer: Buffer;
      let mimeType: string | undefined;

      const contentType = request.headers["content-type"] || "";

      if (contentType.includes("multipart/form-data")) {
        const fileData = await (request as any).file();
        if (!fileData) {
          return reply.code(400).send({ error: "No file provided in multipart upload" });
        }
        filename = fileData.filename;
        mimeType = fileData.mimetype;
        buffer = await fileData.toBuffer();
      } else {
        const bodyParsed = jsonGenerateBodySchema.safeParse(request.body);
        if (!bodyParsed.success) {
          return reply.code(400).send({
            error: `Invalid request payload: ${bodyParsed.error.issues.map((i) => i.message).join(", ")}`,
          });
        }
        filename = bodyParsed.data.filename;
        if (bodyParsed.data.text) {
          buffer = Buffer.from(bodyParsed.data.text, "utf8");
          mimeType = "text/plain";
        } else if (bodyParsed.data.contentBase64) {
          buffer = Buffer.from(bodyParsed.data.contentBase64, "base64");
          mimeType = bodyParsed.data.fileType ? `application/${bodyParsed.data.fileType}` : undefined;
        } else {
          return reply.code(400).send({ error: "Missing document content" });
        }
      }

      // Step 2: Extract text from document
      let parsedDoc;
      try {
        parsedDoc = await extractTextFromDocument(buffer, filename, mimeType);
      } catch (err) {
        if (err instanceof DocumentProcessingError) {
          return reply.code(err.statusCode).send({ error: err.message });
        }
        return reply.code(400).send({
          error: `Document processing failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Step 3: Insert requirement document record
      const insertDocResult = await pool.query<RequirementDocRow>(
        `INSERT INTO requirement_documents
           (project_id, user_id, filename, file_type, file_size, extracted_text, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         RETURNING *`,
        [
          project.id,
          request.user?.id ?? null,
          parsedDoc.filename,
          parsedDoc.fileType,
          parsedDoc.fileSize,
          parsedDoc.text,
        ],
      );
      const savedDoc = insertDocResult.rows[0];

      // Step 4: Call Gemini AI to generate test cases covering positive, negative, boundary, edge_case
      let generatedCases;
      try {
        generatedCases = await generateTestCasesFromRequirements(parsedDoc.text, {
          name: project.name,
          baseUrl: project.base_url,
        });
      } catch (err) {
        if (err instanceof RequirementsGenerationError) {
          return reply.code(502).send({ error: err.message, details: err.details });
        }
        return reply.code(500).send({
          error: `AI test case generation failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Step 5: Save generated test cases with review_status: 'pending'
      const createdTestCases: any[] = [];
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const tc of generatedCases) {
          const insertTc = await client.query(
            `INSERT INTO test_cases
               (id, project_id, title, description, steps, expected_result, review_status,
                preconditions, priority, test_type, requirement_doc_id, created_at)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, NOW())
             RETURNING *`,
            [
              project.id,
              tc.title,
              tc.requirement_description,
              JSON.stringify(tc.steps),
              tc.expected_result,
              tc.preconditions,
              tc.priority,
              tc.test_type,
              savedDoc.id,
            ],
          );
          if (insertTc.rows[0]) {
            const row = insertTc.rows[0];
            createdTestCases.push({
              ...row,
              title: redactSecrets(row.title),
              description: row.description ? redactSecrets(row.description) : null,
              preconditions: row.preconditions ? redactSecrets(row.preconditions) : null,
              steps: row.steps.map((s: string) => redactSecrets(s)),
              expected_result: row.expected_result ? redactSecrets(row.expected_result) : null,
            });
          }
        }

        await client.query(
          "UPDATE requirement_documents SET generated_count = $1 WHERE id = $2",
          [createdTestCases.length, savedDoc.id],
        );
        await client.query("COMMIT");
      } catch (insertError) {
        await client.query("ROLLBACK");
        throw insertError;
      } finally {
        client.release();
      }

      // Audit logs
      await logAuditEvent({
        actorId: request.user?.id,
        action: "REQUIREMENT_DOCUMENT_UPLOADED",
        projectId: project.id,
        targetResource: savedDoc.filename,
        outcome: "success",
        details: {
          documentId: savedDoc.id,
          fileType: savedDoc.file_type,
          fileSize: savedDoc.file_size,
          wordCount: parsedDoc.wordCount,
        },
        ipAddress: request.ip,
      });

      await logAuditEvent({
        actorId: request.user?.id,
        action: "REQUIREMENT_TEST_CASES_GENERATED",
        projectId: project.id,
        targetResource: savedDoc.filename,
        outcome: "success",
        details: {
          documentId: savedDoc.id,
          generatedCount: createdTestCases.length,
        },
        ipAddress: request.ip,
      });

      return reply.code(201).send({
        document: {
          id: savedDoc.id,
          filename: savedDoc.filename,
          fileType: savedDoc.file_type,
          fileSize: savedDoc.file_size,
          wordCount: parsedDoc.wordCount,
          characterCount: parsedDoc.characterCount,
          createdAt: savedDoc.created_at,
        },
        test_cases: createdTestCases,
        generated_count: createdTestCases.length,
      });
    },
  );

  // 2. List requirements documents for a project
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/requirements/documents",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "viewer");
      }

      const result = await pool.query<RequirementDocRow>(
        `SELECT id, project_id, user_id, filename, file_type, file_size, generated_count, created_at
         FROM requirement_documents
         WHERE project_id = $1
         ORDER BY created_at DESC`,
        [params.data.projectId],
      );

      return reply.code(200).send(result.rows);
    },
  );

  // 3. Get single requirements document details and its test cases
  fastify.get<{ Params: { projectId: string; documentId: string } }>(
    "/projects/:projectId/requirements/documents/:documentId",
    async (request, reply) => {
      const params = docParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid parameters: expected UUIDs" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "viewer");
      }

      const docResult = await pool.query<RequirementDocRow>(
        "SELECT * FROM requirement_documents WHERE id = $1 AND project_id = $2",
        [params.data.documentId, params.data.projectId],
      );
      const doc = docResult.rows[0];
      if (!doc) {
        return reply.code(404).send({ error: "Requirements document not found" });
      }

      const testCasesResult = await pool.query(
        `SELECT * FROM test_cases
         WHERE requirement_doc_id = $1
         ORDER BY created_at ASC`,
        [doc.id],
      );

      return reply.code(200).send({
        document: doc,
        test_cases: testCasesResult.rows.map((row) => ({
          ...row,
          title: redactSecrets(row.title),
          description: row.description ? redactSecrets(row.description) : null,
          preconditions: row.preconditions ? redactSecrets(row.preconditions) : null,
          steps: row.steps.map((s: string) => redactSecrets(s)),
          expected_result: row.expected_result ? redactSecrets(row.expected_result) : null,
        })),
      });
    },
  );

  // 4. Batch approve requirement-based test cases
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/requirements/batch-approve",
    async (request, reply) => {
      const params = projectParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "qa_manager");
      }

      const body = batchApproveBodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid request body: ${body.error.issues.map((i) => i.message).join(", ")}`,
        });
      }

      let updateQuery: string;
      let queryParams: any[];

      if (body.data.testCaseIds && body.data.testCaseIds.length > 0) {
        updateQuery = `
          UPDATE test_cases
          SET review_status = 'approved'
          WHERE project_id = $1 AND id = ANY($2::uuid[])
          RETURNING id
        `;
        queryParams = [params.data.projectId, body.data.testCaseIds];
      } else if (body.data.documentId) {
        updateQuery = `
          UPDATE test_cases
          SET review_status = 'approved'
          WHERE project_id = $1 AND requirement_doc_id = $2
          RETURNING id
        `;
        queryParams = [params.data.projectId, body.data.documentId];
      } else {
        updateQuery = `
          UPDATE test_cases
          SET review_status = 'approved'
          WHERE project_id = $1 AND requirement_doc_id IS NOT NULL AND review_status = 'pending'
          RETURNING id
        `;
        queryParams = [params.data.projectId];
      }

      const result = await pool.query(updateQuery, queryParams);

      await logAuditEvent({
        actorId: request.user?.id,
        action: "REQUIREMENT_TEST_CASES_BATCH_APPROVED",
        projectId: params.data.projectId,
        outcome: "success",
        details: {
          approvedCount: result.rowCount,
          documentId: body.data.documentId,
        },
        ipAddress: request.ip,
      });

      return reply.code(200).send({
        approved_count: result.rowCount,
        message: `Successfully approved ${result.rowCount} requirement test cases.`,
      });
    },
  );
};

export default requirementRoutes;
