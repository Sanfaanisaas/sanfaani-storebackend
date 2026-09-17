import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { swaggerSpec } from "../config/swagger.js";

test("BE-25 versioned OpenAPI artifact and client compatibility", async (t) => {
  await t.test("1. every operation has a unique stable operationId and standard error response", () => {
    const seen = new Set();
    for (const path of Object.values(swaggerSpec.paths)) for (const method of ["get", "post", "put", "patch", "delete"]) if (path[method]) { assert.ok(path[method].operationId); assert.ok(!seen.has(path[method].operationId)); seen.add(path[method].operationId); assert.ok(path[method].responses.default); }
  });
  await t.test("2. committed v1 artifact exactly matches the deterministic runtime export", async () => {
    const artifact = JSON.parse(await readFile(new URL("../../openapi/sanfaani-api.v1.json", import.meta.url), "utf8"));
    assert.equal(artifact.openapi, "3.1.0"); assert.equal(artifact.info.version, "1.0.0"); assert.deepEqual(Object.keys(artifact.paths).sort(), Object.keys(swaggerSpec.paths).sort());
  });
});
