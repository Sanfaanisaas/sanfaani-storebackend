import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registerPath = path.resolve(
  __dirname,
  "../../docs/backend-ticket-register.md",
);
const traceabilityPath = path.resolve(
  __dirname,
  "../../docs/backend-prd-traceability.md",
);

test("BE-14 Traceability and Ticket Identity Verification", async (t) => {
  let registerContent = "";
  let traceabilityContent = "";

  await t.test("Documentation files exist", async () => {
    registerContent = await fs.readFile(registerPath, "utf-8");
    traceabilityContent = await fs.readFile(traceabilityPath, "utf-8");
    assert.ok(registerContent.length > 0, "Ticket register must not be empty");
    assert.ok(
      traceabilityContent.length > 0,
      "Traceability matrix must not be empty",
    );
  });

  await t.test("No duplicate ticket IDs exist in the register", () => {
    const ticketRegex = /\*\*BE-\d{2}\*\*/g;
    const matches = registerContent.match(ticketRegex) || [];
    const uniqueTickets = new Set(matches);

    assert.ok(matches.length > 0, "Must contain BE-XX ticket IDs");
    assert.equal(
      matches.length,
      uniqueTickets.size,
      "Duplicate ticket IDs found in the register!",
    );
  });

  await t.test(
    "Deferred R2-R4 scope is visibly separated from R1 blockers",
    () => {
      assert.ok(
        registerContent.includes("## Later-Release Scope (R2 - R4)"),
        "Must contain a distinct section for R2-R4 scope",
      );
      assert.ok(
        registerContent.includes("BE-29"),
        "BE-29 must be documented as deferred",
      );
      assert.ok(
        registerContent.includes("BE-31"),
        "BE-31 must be documented as deferred",
      );
    },
  );

  await t.test("Traceability matrix maps PRD domains correctly", () => {
    const requiredDomains = [
      "FOUND",
      "AUTH",
      "CAT / PDP",
      "CART / CHECKOUT",
      "ORDER",
      "PAY",
      "INVENTORY",
      "QUOTE / B2B",
      "REPAIR / TECH / QC",
      "WARRANTY / RETURN",
      "SUPPORT",
      "CONTENT",
      "ANALYTICS",
      "DEVOPS / SEC",
      "MOBILE",
      "SEARCH",
    ];

    requiredDomains.forEach((domain) => {
      assert.ok(
        traceabilityContent.includes(domain),
        `Traceability matrix is missing domain: ${domain}`,
      );
    });
  });
});
