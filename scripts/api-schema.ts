import { writeFileSync } from "node:fs";
import { z } from "zod";
import {
  connectionSchema,
  agentSchema,
  userSchema,
} from "../packages/shared/src/config.ts";
const paths: Record<string, any> = {};
const routes: [string, string, string, string, unknown?][] = [
  ["get", "/api/setup/status", "public", "First-run state"],
  [
    "post",
    "/api/setup",
    "bootstrap",
    "Create the first administrator",
    z.toJSONSchema(
      userSchema.omit({ role: true }).extend({ bootstrapToken: z.string() }),
    ),
  ],
  [
    "post",
    "/api/auth/login",
    "public",
    "Sign in",
    z.toJSONSchema(userSchema.omit({ role: true })),
  ],
  ["post", "/api/auth/logout", "session", "Revoke session"],
  ["get", "/api/auth/me", "session", "Current role and CSRF token"],
  ["get", "/api/health/live", "public", "Liveness only"],
  [
    "get",
    "/api/health/ready",
    "session",
    "Live integration readiness remains blocked",
  ],
  ["get", "/api/dashboard/metrics", "session", "Retained-call counts"],
  [
    "get",
    "/api/settings/connections",
    "admin",
    "Masked metadata; no secret values",
  ],
  [
    "put",
    "/api/settings/connections",
    "admin",
    "Save settings and optional write-only secret",
    z.toJSONSchema(connectionSchema),
  ],
  [
    "post",
    "/api/settings/test/{provider}",
    "admin",
    "Read-only provider test; demo and PBX checks blocked",
  ],
  [
    "get",
    "/api/settings/agent",
    "session",
    "Active agent settings and version",
  ],
  [
    "put",
    "/api/settings/agent",
    "admin",
    "Create an immutable agent version",
    z.toJSONSchema(agentSchema),
  ],
  [
    "get",
    "/api/conversations",
    "session",
    "Search/filter cursor-paginated retained history",
  ],
  [
    "get",
    "/api/conversations/{id}",
    "session",
    "Call metadata and first 200 turns",
  ],
  [
    "get",
    "/api/conversations/{id}/turns",
    "session",
    "Further turns by after index",
  ],
  [
    "get",
    "/api/conversations/{id}/events",
    "session",
    "Events by after sequence",
  ],
  [
    "get",
    "/api/conversations/{id}/export",
    "admin",
    "Audited sanitized JSON export, capped at 10000 turns",
  ],
  ["get", "/api/admin/users", "admin", "User metadata only, first 200 users"],
  [
    "post",
    "/api/admin/users",
    "admin",
    "Create an admin or support account",
    z.toJSONSchema(userSchema),
  ],
  ["get", "/api/admin/audit", "admin", "Cursor-paginated security audit"],
];
routes.push(
  [
    "get",
    "/api/demo-calls/status",
    "admin",
    "Browser-call configuration readiness",
  ],
  [
    "post",
    "/api/demo-calls",
    "admin",
    "Create browser demo; preview default, live_test requires customer ID",
    {
      type: "object",
      required: ["sdp"],
      properties: {
        sdp: { type: "string", maxLength: 18000 },
        writeMode: {
          type: "string",
          enum: ["preview", "live_test"],
          default: "preview",
        },
        testCustomerId: { type: "string", pattern: "^\\d+$" },
      },
    },
  ],
  ["get", "/api/demo-calls/{id}", "admin", "Owned browser-call snapshot"],
  ...["activate", "heartbeat", "end"].map(
    (action) =>
      [
        "post",
        `/api/demo-calls/{id}/${action}`,
        "admin",
        `Browser call ${action}`,
      ] as [string, string, string, string],
  ),
);
for (const [method, path, access, description, schema] of routes) {
  const parameters: any[] = [];
  for (const part of path.matchAll(/\{(\w+)\}/g))
    parameters.push({
      name: part[1],
      in: "path",
      required: true,
      schema:
        part[1] === "id"
          ? { type: "string", format: "uuid" }
          : { type: "string", enum: ["pbx", "openai", "syncro"] },
    });
  if (method !== "get") {
    parameters.push({
      name: "Origin",
      in: "header",
      required: true,
      schema: { type: "string" },
      description: "Must equal APP_ORIGIN exactly",
    });
    if (access === "session" || access === "admin")
      parameters.push({
        name: "X-CSRF-Token",
        in: "header",
        required: true,
        schema: { type: "string" },
      });
  }
  if (path === "/api/conversations") {
    for (const name of [
      "cursor",
      "q",
      "outcome",
      "clinic",
      "from",
      "to",
      "ticket",
    ])
      parameters.push({ name, in: "query", schema: { type: "string" } });
    parameters.push({
      name: "limit",
      in: "query",
      schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
    });
  }
  if (path.endsWith("/turns") || path.endsWith("/events"))
    parameters.push(
      {
        name: "after",
        in: "query",
        schema: { type: "integer", minimum: -1, default: -1 },
      },
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
    );
  if (path === "/api/admin/audit")
    parameters.push(
      { name: "after", in: "query", schema: { type: "string" } },
      {
        name: "limit",
        in: "query",
        schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
    );
  paths[path] ??= {};
  paths[path][method] = {
    summary: description,
    "x-access-role": access,
    security: ["admin", "session"].includes(access)
      ? [{ sessionCookie: [] }]
      : [],
    parameters,
    responses: {
      200: {
        description:
          "Successful result; inspect docs/api-contracts.md for response shape",
      },
      default: {
        description: "Sanitized error envelope",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/Error" },
          },
        },
      },
    },
    ...(schema
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema } },
          },
        }
      : {}),
  };
}
writeFileSync(
  "docs/contracts/app.openapi.json",
  JSON.stringify(
    {
      openapi: "3.1.0",
      info: {
        title: "ChinookIT AI Receptionist Foundation",
        version: "0.1.0",
        description:
          "Implemented Phase 1 routes only. Live voice and ticket writes are disabled.",
      },
      paths,
      components: {
        securitySchemes: {
          sessionCookie: {
            type: "apiKey",
            in: "cookie",
            name: "chinook_session",
          },
        },
        schemas: {
          Error: {
            type: "object",
            required: ["error"],
            properties: {
              error: {
                type: "object",
                required: ["code", "correlationId"],
                properties: {
                  code: { type: "string" },
                  correlationId: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    null,
    2,
  ) + "\n",
);
