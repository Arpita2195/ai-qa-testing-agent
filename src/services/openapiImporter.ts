import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ApiMethod, ApiEndpoint, ExpectedFieldType } from "./apiRunner";

export interface ApiEndpointDraft {
  name: string;
  method: ApiMethod;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
  expected_status: number;
  expected_fields: Record<string, ExpectedFieldType>;
}

const supportedMethods: ApiMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function resolveLocalRef(
  value: unknown,
  document: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const reference = (value as Record<string, unknown>)["$ref"];
  if (typeof reference !== "string" || !reference.startsWith("#/components/schemas/")) {
    return value as Record<string, unknown>;
  }
  const name = reference.slice("#/components/schemas/".length);
  if (!name || name.includes("/") || name.includes("~")) return;
  const schemas = document.components as Record<string, unknown> | undefined;
  const definitions = schemas?.schemas as Record<string, unknown> | undefined;
  const resolved = definitions?.[name];
  if (typeof resolved !== "object" || resolved === null || Array.isArray(resolved)) return;
  return resolved as Record<string, unknown>;
}

function schemaType(
  schema: unknown,
  document: Record<string, unknown>,
  allowRef: boolean,
): ExpectedFieldType | undefined {
  let candidate = schema;
  if (
    allowRef &&
    typeof candidate === "object" &&
    candidate !== null &&
    "$ref" in candidate
  ) {
    candidate = resolveLocalRef(candidate, document);
  }
  if (typeof candidate !== "object" || candidate === null) return;
  const type = (candidate as Record<string, unknown>).type;
  if (type === "string" || type === "number" || type === "integer") return type === "integer" ? "number" : type;
  if (type === "boolean" || type === "object" || type === "array") return type;
}

function expectedFields(
  schemaValue: unknown,
  document: Record<string, unknown>,
): Record<string, ExpectedFieldType> {
  const schema = resolveLocalRef(schemaValue, document);
  const properties = schema?.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return {};
  const result: Record<string, ExpectedFieldType> = {};
  for (const [name, propertySchema] of Object.entries(properties)) {
    const type = schemaType(propertySchema, document, true);
    if (type) result[name] = type;
  }
  return result;
}

function sampleValue(
  schemaValue: unknown,
  document: Record<string, unknown>,
  refDepth = 0,
): unknown {
  if (
    typeof schemaValue === "object" &&
    schemaValue !== null &&
    "$ref" in schemaValue
  ) {
    if (refDepth >= 1) return null;
    schemaValue = resolveLocalRef(schemaValue, document);
    refDepth += 1;
  }
  const schema = resolveLocalRef(schemaValue, document);
  if (!schema) return null;
  if ("example" in schema) return schema.example;
  if ("default" in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  switch (schema.type) {
    case "string":
      return "example";
    case "integer":
    case "number":
      return 1;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object": {
      const properties = schema.properties;
      if (typeof properties !== "object" || properties === null || Array.isArray(properties)) return {};
      return Object.fromEntries(
        Object.entries(properties).map(([key, value]) => [key, sampleValue(value, document, refDepth)]),
      );
    }
    default:
      return null;
  }
}

function jsonSchema(contentValue: unknown): unknown {
  if (typeof contentValue !== "object" || contentValue === null) return;
  const content = contentValue as Record<string, unknown>;
  const media = content["application/json"] ??
    Object.entries(content).find(([type]) => type.endsWith("+json"))?.[1];
  if (typeof media !== "object" || media === null) return;
  return (media as Record<string, unknown>).schema;
}

function firstSuccessResponse(responsesValue: unknown): [number, unknown] {
  if (typeof responsesValue !== "object" || responsesValue === null) return [200, undefined];
  for (const [code, responseValue] of Object.entries(responsesValue)) {
    if (!/^2\d\d$/.test(code)) continue;
    const response = typeof responseValue === "object" && responseValue !== null
      ? responseValue as Record<string, unknown>
      : undefined;
    return [Number(code), jsonSchema(response?.content)];
  }
  return [200, undefined];
}

export function importOpenApi(spec: unknown): ApiEndpointDraft[] {
  let document: unknown = spec;
  if (typeof spec === "string") {
    try {
      document = parseYaml(spec, { uniqueKeys: true });
    } catch (error) {
      throw new Error(`Invalid OpenAPI JSON/YAML: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const parsed = z.record(z.string(), z.unknown()).safeParse(document);
  if (!parsed.success) {
    throw new Error("OpenAPI specification must be a JSON or YAML object");
  }
  const version = parsed.data.openapi;
  if (typeof version !== "string" || !/^3\.\d+(?:\.\d+)?(?:[-+].*)?$/.test(version)) {
    throw new Error("Only OpenAPI 3.x specifications are supported");
  }
  const paths = parsed.data.paths;
  if (typeof paths !== "object" || paths === null || Array.isArray(paths)) {
    throw new Error("OpenAPI specification must contain a paths object");
  }

  const endpointDrafts: ApiEndpointDraft[] = [];
  for (const [path, pathItemValue] of Object.entries(paths)) {
    if (typeof pathItemValue !== "object" || pathItemValue === null || Array.isArray(pathItemValue)) continue;
    const pathItem = pathItemValue as Record<string, unknown>;
    for (const method of supportedMethods) {
      const operationValue = pathItem[method.toLowerCase()];
      if (typeof operationValue !== "object" || operationValue === null || Array.isArray(operationValue)) continue;
      const operation = operationValue as Record<string, unknown>;
      const [expectedStatus, responseSchema] = firstSuccessResponse(operation.responses);
      const requestContent = operation.requestBody &&
        typeof operation.requestBody === "object" &&
        operation.requestBody !== null
        ? jsonSchema((operation.requestBody as Record<string, unknown>).content)
        : undefined;
      const operationId = typeof operation.operationId === "string" ? operation.operationId : undefined;
      const draft: ApiEndpointDraft = {
        name: operationId || `${method} ${path}`,
        method,
        path,
        headers: {},
        expected_status: expectedStatus,
        expected_fields: expectedFields(responseSchema, parsed.data),
      };
      if (["POST", "PUT", "PATCH"].includes(method) && requestContent !== undefined) {
        draft.body = sampleValue(requestContent, parsed.data);
      }
      endpointDrafts.push(draft);
    }
  }
  return endpointDrafts;
}

export function skipExistingEndpoints(
  drafts: ApiEndpointDraft[],
  existing: Array<Pick<ApiEndpoint, "method" | "path">>,
): { created: ApiEndpointDraft[]; skipped: number } {
  const keys = new Set(existing.map((endpoint) => `${endpoint.method}\u0000${endpoint.path}`));
  const created: ApiEndpointDraft[] = [];
  let skipped = 0;
  for (const draft of drafts) {
    const key = `${draft.method}\u0000${draft.path}`;
    if (keys.has(key)) {
      skipped += 1;
      continue;
    }
    keys.add(key);
    created.push(draft);
  }
  return { created, skipped };
}
