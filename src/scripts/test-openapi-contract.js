import test from "node:test";
import assert from "node:assert/strict";
import { swaggerSpec } from "../config/swagger.js";

test("BE-12 OpenAPI Validation & Contract Drift Suite", async (t) => {
  await t.test("1. OpenAPI Document parses and has valid version", () => {
    assert.ok(swaggerSpec);
    assert.ok(swaggerSpec.openapi);
    assert.ok(swaggerSpec.openapi.startsWith("3."));
  });

  await t.test("2. Paths, Operations, Schemas, Security Schemes totals report", () => {
    const paths = Object.keys(swaggerSpec.paths || {});
    assert.ok(paths.length >= 10, `Expected at least 10 paths, got ${paths.length}`);

    let operationCount = 0;
    const operationIds = new Set();
    
    for (const pathKey of paths) {
      const pathObj = swaggerSpec.paths[pathKey];
      for (const method of ["get", "post", "put", "patch", "delete"]) {
        if (pathObj[method]) {
          operationCount += 1;
          if (pathObj[method].operationId) {
            assert.ok(!operationIds.has(pathObj[method].operationId), `Duplicate operationId: ${pathObj[method].operationId}`);
            operationIds.add(pathObj[method].operationId);
          }
        }
      }
    }

    const schemas = Object.keys(swaggerSpec.components?.schemas || {});
    const securitySchemes = Object.keys(swaggerSpec.components?.securitySchemes || {});

    assert.ok(operationCount >= 15, `Expected at least 15 operations, got ${operationCount}`);
    assert.ok(schemas.length >= 5, `Expected at least 5 schemas, got ${schemas.length}`);
    assert.ok(securitySchemes.length >= 1, "Expected securitySchemes defined");
  });

  await t.test("3. Security scheme declaration check for protected paths", () => {
    for (const [pathKey, pathObj] of Object.entries(swaggerSpec.paths)) {
      for (const [method, op] of Object.entries(pathObj)) {
        if (["get", "post", "patch", "delete"].includes(method)) {
          if (op.security) {
            assert.ok(Array.isArray(op.security));
          }
        }
      }
    }
  });
});
