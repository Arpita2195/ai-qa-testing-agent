import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import {
  generateSiteTestCases,
  isRetryableGeminiError,
} from "../services/generator";
import { readSite } from "../services/pageReader";
import { crawlSite } from "../services/crawler";
import { checkGenerateRateLimit } from "../services/rateLimiter";
import { assertProjectAccess } from "../services/authService";
import { runLoopGeneration, withProjectGenerationLock } from "../services/loopGenerator";
import {
  getProjectFunctionalities,
  getProjectScenarios,
  calculateCoverage,
} from "../services/functionalityPlanner";

const paramsSchema = z.object({
  projectId: z.string().uuid(),
});

const bodySchema = z.object({
  path: z.string().optional(),
  loop: z.boolean().optional(),
  crawl: z.boolean().optional(),
  maxDepth: z.number().int().min(1).max(5).optional(),
  maxPages: z.number().int().min(1).max(50).optional(),
  resume: z.boolean().optional(),
  maxRetriesPerFunctionality: z.number().int().min(0).max(5).optional(),
});

interface ProjectRow {
  id: string;
  name: string;
  base_url: string;
}

const generateRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { projectId: string } }>(
    "/projects/:projectId/generate",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "qa_engineer");
      }

      const body = bodySchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.code(400).send({
          error: `Invalid request body: ${body.error.issues.map((issue) => issue.message).join(", ")}`,
        });
      }

      const projectResult = await pool.query<ProjectRow>(
        "SELECT id, name, base_url FROM projects WHERE id = $1",
        [params.data.projectId],
      );
      const project = projectResult.rows[0];
      if (!project) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const apiKey = (request.headers["x-api-key"] as string) || "anonymous";
      const rateLimit = checkGenerateRateLimit(apiKey);
      if (!rateLimit.allowed) {
        return reply.code(429).send({
          error: `Rate limit exceeded. Try again in ${rateLimit.retryAfterSeconds} seconds.`,
        });
      }

      // Execute with project-level concurrency lock on a dedicated checked-out connection
      const lockResult = await withProjectGenerationLock(project.id, async () => {
        let siteData;
        try {
          if (body.data.crawl) {
            const crawlResult = await crawlSite(project, {
              maxDepth: body.data.maxDepth,
              maxPages: body.data.maxPages,
              startPath: body.data.path,
              resume: body.data.resume,
              createdBy: request.user?.id,
            });
            siteData = {
              baseUrl: project.base_url,
              isLoggedIn: crawlResult.isLoggedIn,
              loginSteps: [],
              pages: crawlResult.pages
                .filter((p) => p.status === "visited")
                .map((p) => p.scrapedPage),
            };
          } else {
            siteData = await readSite(project, { path: body.data.path });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Failed to read site";
          if (
            message.includes("This app needs a login") ||
            message.includes("Session expired or login needed") ||
            message.includes("Login required but test credentials are missing") ||
            message.includes("needs manual steps")
          ) {
            return {
              status: 409,
              body: {
                error: "This app needs a login. Add test credentials or log in manually on the project page.",
                message,
              },
            };
          }
          if (message.includes("URL rejected by security guard")) {
            return { status: 400, body: { error: message } };
          }
          return { status: 500, body: { error: message } };
        }

        // Loop-based functionality generation is the default unless explicitly set to false
        const useLoop = body.data.loop !== false;
        if (useLoop) {
          let loopResult;
          try {
            loopResult = await runLoopGeneration(siteData, {
              projectId: project.id,
              appName: project.name,
              resume: Boolean(body.data.resume),
              maxRetriesPerFunctionality: body.data.maxRetriesPerFunctionality,
              createdBy: request.user?.id,
              targetPath: body.data.path ? body.data.path.trim() : undefined,
              isCrawl: Boolean(body.data.crawl),
            });
          } catch (error) {
            if ((error as any)?.code === "BUDGET_EXCEEDED" || (error as any)?.statusCode === 429) {
              return {
                status: 429,
                body: {
                  error: (error as Error).message || "AI budget limit exceeded",
                  code: "BUDGET_EXCEEDED",
                },
              };
            }
            if (isRetryableGeminiError(error)) {
              return {
                status: 503,
                body: {
                  error: "AI service is currently unavailable. Please try again later.",
                },
              };
            }
            const message = error instanceof Error ? error.message : "AI loop generation failed";
            return { status: 500, body: { error: message } };
          }

          if (loopResult.createdTestCases.length === 0) {
            if (loopResult.totalScenariosPlanned > 0 && loopResult.missingScenarios === 0) {
              return {
                status: 200,
                body: {
                  message: `All ${loopResult.totalScenariosPlanned} planned scenarios for this feature are already generated and up to date.`,
                  created: 0,
                  skipped_invalid: loopResult.skippedInvalid,
                  skipped_duplicate: loopResult.skippedDuplicates,
                  generation_mode: "loop_based",
                  total_functionalities: loopResult.totalFunctionalities,
                  completed_functionalities: loopResult.completedFunctionalities,
                  scenarios_planned: loopResult.totalScenariosPlanned,
                  scenarios_generated: loopResult.totalScenariosGenerated,
                  missing_scenarios: loopResult.missingScenarios,
                  status: loopResult.status,
                  test_cases: [],
                },
              };
            }

            if (loopResult.skippedDuplicates > 0 && loopResult.skippedInvalid === 0) {
              return {
                status: 200,
                body: {
                  message: `All test cases for these scenarios already exist in this project (${loopResult.skippedDuplicates} duplicates skipped).`,
                  created: 0,
                  skipped_invalid: loopResult.skippedInvalid,
                  skipped_duplicate: loopResult.skippedDuplicates,
                  generation_mode: "loop_based",
                  total_functionalities: loopResult.totalFunctionalities,
                  completed_functionalities: loopResult.completedFunctionalities,
                  scenarios_planned: loopResult.totalScenariosPlanned,
                  scenarios_generated: loopResult.totalScenariosGenerated,
                  missing_scenarios: loopResult.missingScenarios,
                  status: loopResult.status,
                  test_cases: [],
                },
              };
            }

            const emptyDetail =
              loopResult.totalFunctionalities === 0
                ? (body.data.path
                    ? `No testable functionalities or interactive elements were found on "${body.data.path}". Check that this page path exists (e.g. not a 404 page) and contains interactive buttons, forms, or content.`
                    : "No testable interactive functionalities or elements were detected on this site.")
                : `Loop generation produced no new test cases: ${loopResult.skippedInvalid} invalid, ${loopResult.skippedDuplicates} duplicate`;

            return {
              status: 422,
              body: {
                error: "No test cases created",
                message: emptyDetail,
                created: 0,
                skipped_invalid: loopResult.skippedInvalid,
                skipped_duplicate: loopResult.skippedDuplicates,
                generation_mode: "loop_based",
                total_functionalities: loopResult.totalFunctionalities,
                completed_functionalities: loopResult.completedFunctionalities,
                scenarios_planned: loopResult.totalScenariosPlanned,
                scenarios_generated: loopResult.totalScenariosGenerated,
                missing_scenarios: loopResult.missingScenarios,
                status: loopResult.status,
                test_cases: [],
              },
            };
          }

          return {
            status: 201,
            body: {
              created: loopResult.createdTestCases.length,
              skipped_invalid: loopResult.skippedInvalid,
              skipped_duplicate: loopResult.skippedDuplicates,
              generation_mode: "loop_based",
              total_functionalities: loopResult.totalFunctionalities,
              completed_functionalities: loopResult.completedFunctionalities,
              scenarios_planned: loopResult.totalScenariosPlanned,
              scenarios_generated: loopResult.totalScenariosGenerated,
              missing_scenarios: loopResult.missingScenarios,
              status: loopResult.status,
              iterations: loopResult.iterations,
              test_cases: loopResult.createdTestCases,
            },
          };
        }

        let generationResult;
        try {
          generationResult = await generateSiteTestCases(siteData, project.name, { projectId: project.id });
        } catch (error) {
          if ((error as any)?.code === "BUDGET_EXCEEDED" || (error as any)?.statusCode === 429) {
            return {
              status: 429,
              body: {
                error: (error as Error).message || "AI budget limit exceeded",
                code: "BUDGET_EXCEEDED",
              },
            };
          }
          if (isRetryableGeminiError(error)) {
            return {
              status: 503,
              body: {
                error: "AI service is currently unavailable. Please try again later.",
              },
            };
          }
          const message = error instanceof Error ? error.message : "AI generation failed";
          return { status: 500, body: { error: message } };
        }

        const { testCases, skipped_invalid, generation_mode } = generationResult;

        const existingRows = await pool.query<{ title: string }>(
          "SELECT title FROM test_cases WHERE project_id = $1",
          [project.id],
        );
        const existingTitles = new Set(existingRows.rows.map((row) => row.title));

        let skipped_duplicate = 0;
        const createdCases = [];

        for (const testCase of testCases) {
          if (existingTitles.has(testCase.title)) {
            skipped_duplicate++;
            continue;
          }

          const result = await pool.query(
            `INSERT INTO test_cases
               (id, project_id, title, description, steps, expected_result, review_status,
                functionality_id, scenario_id, priority, test_type, ai_review_metadata)
             VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10)
             RETURNING *`,
            [
              project.id,
              testCase.title,
              testCase.description,
              JSON.stringify(testCase.steps),
              testCase.expected_result,
              (testCase as any).functionality_id || null,
              (testCase as any).scenario_id || null,
              (testCase as any).priority || "medium",
              (testCase as any).category || "positive",
              (testCase as any).ai_review_metadata ? JSON.stringify((testCase as any).ai_review_metadata) : null,
            ],
          );

          if (!result.rows[0]) {
            throw new Error(`Failed to save generated test case "${testCase.title}"`);
          }
          createdCases.push(result.rows[0]);
          existingTitles.add(testCase.title);
        }

        if (createdCases.length === 0) {
          const emptyDetail =
            testCases.length === 0
              ? (body.data.path
                  ? `No testable functionalities or interactive elements were found on "${body.data.path}". Check that this page path exists (e.g. not a 404 page) and contains interactive buttons, forms, or content.`
                  : "No testable interactive functionalities or elements were detected on this site.")
              : `Generation produced no new test cases: ${skipped_invalid} invalid, ${skipped_duplicate} duplicate`;

          return {
            status: 422,
            body: {
              error: "No test cases created",
              message: emptyDetail,
              created: 0,
              skipped_invalid,
              skipped_duplicate,
              generation_mode,
              test_cases: [],
            },
          };
        }

        return {
          status: 201,
          body: {
            created: createdCases.length,
            skipped_invalid,
            skipped_duplicate,
            generation_mode,
            test_cases: createdCases,
          },
        };
      });

      if (!lockResult.acquired) {
        return reply.code(409).send({
          error: "Generation already in progress",
          message: "A test generation job is currently running for this project. Please wait for it to complete.",
        });
      }

      return reply.code(lockResult.result.status).send(lockResult.result.body);
    },
  );

  /**
   * GET /projects/:projectId/functionalities
   * Returns discovered functionality inventory for a project.
   */
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/functionalities",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "viewer");
      }

      const projCheck = await pool.query("SELECT id FROM projects WHERE id = $1", [params.data.projectId]);
      if (!projCheck.rows[0]) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const functionalities = await getProjectFunctionalities(params.data.projectId);
      return reply.code(200).send({ functionalities });
    },
  );

  /**
   * GET /projects/:projectId/scenarios
   * Returns scenario checklist and coverage summary for a project.
   */
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/scenarios",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "viewer");
      }

      const projCheck = await pool.query("SELECT id FROM projects WHERE id = $1", [params.data.projectId]);
      if (!projCheck.rows[0]) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const scenarios = await getProjectScenarios(params.data.projectId);
      const coverage = await calculateCoverage(params.data.projectId);
      return reply.code(200).send({ scenarios, coverage });
    },
  );

  /**
   * GET /projects/:projectId/coverage
   * Returns deterministic test coverage metrics across planned scenarios.
   */
  fastify.get<{ Params: { projectId: string } }>(
    "/projects/:projectId/coverage",
    async (request, reply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ error: "Invalid projectId: expected a UUID" });
      }

      if (request.user) {
        await assertProjectAccess(request.user, params.data.projectId, "viewer");
      }

      const projCheck = await pool.query("SELECT id FROM projects WHERE id = $1", [params.data.projectId]);
      if (!projCheck.rows[0]) {
        return reply.code(404).send({ error: "Project not found" });
      }

      const coverage = await calculateCoverage(params.data.projectId);
      return reply.code(200).send(coverage);
    },
  );
};

export default generateRoutes;
