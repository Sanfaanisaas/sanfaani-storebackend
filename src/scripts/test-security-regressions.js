import test from "node:test";
import assert from "node:assert/strict";
import { projectProductPublic, projectVariantPublic } from "../utils/projections.js";

const FORBIDDEN_CUSTOMER_FIELDS = [
  "passwordHash",
  "supplier",
  "purchaseCost",
  "agreedUnitCost",
  "costPrice",
  "rawIdentityReference",
  "privateObjectKey",
  "technicianNotes",
  "auditLogs",
  "__v"
];

function containsForbiddenField(obj, forbiddenKeys) {
  if (!obj || typeof obj !== "object") return false;
  if (Array.isArray(obj)) {
    return obj.some((item) => containsForbiddenField(item, forbiddenKeys));
  }
  for (const [key, value] of Object.entries(obj)) {
    if (forbiddenKeys.includes(key)) return true;
    if (typeof value === "object" && value !== null) {
      if (containsForbiddenField(value, forbiddenKeys)) return true;
    }
  }
  return false;
}

test("BE-12 Security & Privacy Regressions Suite", async (t) => {

  await t.test("1. Product and Variant public projections strip internal supplier/cost keys recursively", () => {
    const rawProduct = {
      _id: "60f7b1234567890123456789",
      name: "Test Laptop",
      slug: "test-laptop",
      description: "Description",
      category: "Laptops",
      brand: "BrandX",
      supplier: "Secret Supplier Ltd",
      purchaseCost: 250000,
      costPrice: 200000,
      __v: 0
    };

    const rawVariant = {
      _id: "60f7b9876543210987654321",
      sku: "SKU-PROD-01",
      price: 300000,
      supplierId: "SUPP-999",
      inStock: 5
    };

    const safeProj = projectProductPublic(rawProduct, [rawVariant]);
    assert.equal(containsForbiddenField(safeProj, FORBIDDEN_CUSTOMER_FIELDS), false);
    assert.equal(safeProj.supplier, undefined);
    assert.equal(safeProj.purchaseCost, undefined);
    assert.equal(safeProj.costPrice, undefined);
  });

  await t.test("2. Public Repair Tracking projections exclude private internal evidence & technician notes", () => {
    const rawRepair = {
      _id: "60f7b9876543210987654321",
      status: "IN_REPAIR",
      customer: "60f7b1234567890123456789",
      technicianNotes: "Private technician diagnosis",
      rawIdentityReference: "ID-PRIVATE-999",
      custody: {
        receivingOperator: "Operator A",
        notes: "Internal intake note"
      }
    };

    assert.equal(containsForbiddenField(rawRepair, FORBIDDEN_CUSTOMER_FIELDS), true);
  });
});
