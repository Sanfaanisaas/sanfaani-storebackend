import test from "node:test";
import assert from "node:assert/strict";
import { REPAIR_STATUS, ORDER_STATUS, PAYMENT_STATUS, QUOTE_STATUS } from "../utils/constants.js";
import { swaggerSpec } from "../config/swagger.js";

test("BE-11 & BE-12 Canonical Status Contract & Drift Suite", async (t) => {
  await t.test("1. Canonical status constants are complete and uppercase", () => {
    assert.equal(REPAIR_STATUS.IN_CUSTODY, "IN_CUSTODY");
    assert.equal(REPAIR_STATUS.DIAGNOSING, "DIAGNOSING");
    assert.equal(REPAIR_STATUS.QC_PENDING, "QC_PENDING");
    assert.equal(REPAIR_STATUS.READY, "READY");

    assert.ok(ORDER_STATUS);
    assert.ok(PAYMENT_STATUS);
    assert.ok(QUOTE_STATUS);
  });

  await t.test("2. OpenAPI Enum values match backend canonical constants", () => {
    const schemas = swaggerSpec.components?.schemas || {};
    if (schemas.RepairStatus && schemas.RepairStatus.enum) {
      for (const val of schemas.RepairStatus.enum) {
        assert.ok(Object.values(REPAIR_STATUS).includes(val), `Unknown RepairStatus enum in OpenAPI: ${val}`);
      }
    }
  });

  await t.test("3. Drift Check: No lowercase repair/quote status drift exists in constants", () => {
    for (const val of Object.values(REPAIR_STATUS)) {
      assert.equal(val, val.toUpperCase(), `Status value ${val} must be uppercase`);
    }
    for (const val of Object.values(QUOTE_STATUS)) {
      assert.equal(val, val.toUpperCase(), `Quote status value ${val} must be uppercase`);
    }
  });
});
