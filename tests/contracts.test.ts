import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const api = JSON.parse(
  readFileSync(
    new URL("../docs/contracts/syncro.openapi.json", import.meta.url),
    "utf8",
  ),
);
test("pinned Syncro snapshot documents tenant scoped lookup and the distinct comment write route", () => {
  assert.ok(
    api.paths["/customers"].get.parameters.some((p: any) => p.name === "query"),
  );
  assert.ok(
    api.paths["/contacts"].get.parameters.some(
      (p: any) => p.name === "customer_id",
    ),
  );
  assert.ok(api.paths["/tickets/{id}/comments"].get);
  assert.ok(api.paths["/tickets/{id}/comment"].post);
  const schema =
    api.paths["/tickets"].post.requestBody.content["application/json"].schema;
  assert.ok(schema.properties.customer_id);
  assert.ok(schema.properties.subject);
  assert.equal(api.components.securitySchemes.bearerAuth.scheme, "bearer");
});
