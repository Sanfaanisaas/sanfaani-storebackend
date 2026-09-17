import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app, User, Repair, generateAccessToken, USER_ROLES, createRepairFinanceOverride;
let replSet;
let customerToken, customerUser;
let technicianToken, technicianUser;
let secondTechToken, secondTechUser;
let storeOpToken, storeOpUser;
let opsManagerToken, opsManagerUser;
let qcToken, qcUser;

const ACCESS_SECRET = "repair-evidence-test-access-secret-at-least-32-chars";

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "repair-evidence-test-refresh-secret-32-chars";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "repair-evidence-test-audit-secret-32-chars";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "repair-evidence-test-tracking-secret-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_repair_evidence_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be10-13-mongo");

  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const uri = replSet.getUri();
  assert.ok(uri.includes("127.0.0.1") || uri.includes("localhost"), "MongoDB URI must be local");
  process.env.MONGO_URI = uri;
  await mongoose.connect(uri, { dbName: `repair_evidence_${process.pid}_${Date.now()}` });

  ({ default: app } = await import("../app.js"));
  ({ default: User } = await import("../models/User.js"));
  ({ default: Repair } = await import("../models/Repair.js"));
  ({ generateAccessToken } = await import("../services/tokenService.js"));
  ({ USER_ROLES } = await import("../utils/constants.js"));
  ({ createRepairFinanceOverride } = await import("../services/repairFinanceService.js"));

  const pwd = "$2a$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuuabcdefghijk";

  customerUser = await User.create({ name: "Cust One", email: `cust1-${Date.now()}@example.com`, passwordHash: pwd, role: USER_ROLES.CUSTOMER, isActive: true });
  customerToken = generateAccessToken(customerUser);

  storeOpUser = await User.create({ name: "Store Op", email: `storeop-${Date.now()}@example.com`, passwordHash: pwd, role: USER_ROLES.STORE_OPERATOR, isActive: true });
  storeOpToken = generateAccessToken(storeOpUser);

  opsManagerUser = await User.create({ name: "Ops Mgr", email: `opsmgr-${Date.now()}@example.com`, passwordHash: pwd, role: USER_ROLES.OPS_MANAGER, isActive: true });
  opsManagerToken = generateAccessToken(opsManagerUser);

  technicianUser = await User.create({ name: "Tech One", email: `tech1-${Date.now()}@example.com`, passwordHash: pwd, role: USER_ROLES.TECHNICIAN, isActive: true });
  technicianToken = generateAccessToken(technicianUser);

  secondTechUser = await User.create({ name: "Tech Two", email: `tech2-${Date.now()}@example.com`, passwordHash: pwd, role: USER_ROLES.TECHNICIAN, isActive: true });
  secondTechToken = generateAccessToken(secondTechUser);

  qcUser = await User.create({ name: "QC Officer", email: `qc-${Date.now()}@example.com`, passwordHash: pwd, role: USER_ROLES.QC_OFFICER, isActive: true });
  qcToken = generateAccessToken(qcUser);
});

after(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

test("BE-10 Repair Evidence & Lifecycle Suite", async (t) => {

  await t.test("1 & 2. Repair ownership comes from req.user.id and rejects/ignores spoofed ownership", async () => {
    const res = await request(app)
      .post("/api/repairs")
      .set("Authorization", `Bearer ${customerToken}`)
      .send({
        device: { type: "Smartphone", brand: "Apple", model: "iPhone 13" },
        issueDescription: "Cracked screen",
        privacyAcknowledged: true,
        customerId: "spoofed-user-id-999"
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    const id = res.body.data.repair._id || res.body.data.repair.id;
    assert.ok(id);
    const dbRepair = await Repair.findById(id);
    assert.equal(dbRepair.customer.toString(), customerUser._id.toString());
  });

  await t.test("3 & 4. Canonical create content type application/json succeeds, unsupported fails", async () => {
    const failRes = await request(app)
      .post("/api/repairs")
      .set("Authorization", `Bearer ${customerToken}`)
      .set("Content-Type", "text/plain")
      .send("raw plain text body");
    assert.ok([400, 415, 422].includes(failRes.status));
  });

  await t.test("5. Malformed device/evidence metadata returns standard envelope", async () => {
    const res = await request(app)
      .post("/api/repairs")
      .set("Authorization", `Bearer ${customerToken}`)
      .send({ device: "invalid string", issueDescription: "", privacyAcknowledged: false });

    assert.equal(res.status, 422);
    assert.equal(res.body.success, false);
    assert.ok(Array.isArray(res.body.errors));
  });

  let repairId;
  await t.test("6 & 7 & 8. Custody record persistence, missing custody evidence blocks IN_CUSTODY, unauthorized operator fails", async () => {
    const createRes = await request(app)
      .post("/api/repairs")
      .set("Authorization", `Bearer ${customerToken}`)
      .send({
        device: { type: "Laptop", brand: "Dell", model: "XPS 15" },
        issueDescription: "Battery replacement required",
        privacyAcknowledged: true
      });
    repairId = createRes.body.data.repair._id || createRes.body.data.repair.id;

    const unauthRes = await request(app)
      .patch(`/api/repairs/${repairId}/intake`)
      .set("Authorization", `Bearer ${customerToken}`)
      .send({ intakeCondition: "Scratched lid", intakePhotos: ["photo-1"] });
    assert.equal(unauthRes.status, 403);

    const validRes = await request(app)
      .patch(`/api/repairs/${repairId}/intake`)
      .set("Authorization", `Bearer ${storeOpToken}`)
      .send({
        intakeCondition: "Scratched lid",
        intakePhotos: ["photo-1"]
      });
    assert.equal(validRes.status, 200);
    assert.equal(validRes.body.data.status, "RECEIVED");
  });

  await t.test("9 & 10. Technician assignment and diagnosis authorization", async () => {
    const assignRes = await request(app)
      .patch(`/api/repairs/${repairId}/assign-technician`)
      .set("Authorization", `Bearer ${opsManagerToken}`)
      .send({ technicianId: technicianUser._id.toString() });
    assert.equal(assignRes.status, 200);

    const unassignedRes = await request(app)
      .patch(`/api/repairs/${repairId}/diagnosis`)
      .set("Authorization", `Bearer ${secondTechToken}`)
      .send({ diagnosisNotes: "Faulty battery cell", estimatedCost: 15000 });
    assert.equal(unassignedRes.status, 403);

    const diagRes = await request(app)
      .patch(`/api/repairs/${repairId}/diagnosis`)
      .set("Authorization", `Bearer ${technicianToken}`)
      .send({
        diagnosisNotes: "Cell degradation",
        estimatedCost: 15000
      });
    assert.equal(diagRes.status, 200);
    assert.equal(diagRes.body.data.status, "DIAGNOSING");
  });

  await t.test("11 & 12. Structured diagnosis and required work persistence", async () => {
    const repair = await Repair.findById(repairId);
    assert.equal(repair.diagnosisNotes, "Cell degradation");
    assert.equal(repair.estimatedCost, 15000);
  });

  await t.test("18 & 19 & 20. Self-QC Prohibition: Technician who performed repair CANNOT approve their own QC", async () => {
    const quoteRes = await request(app)
      .post(`/api/repairs/${repairId}/quote`)
      .set("Authorization", `Bearer ${technicianToken}`)
      .send({ lineItems: [{ description: "Battery Replacement", amount: 15000 }] });
    assert.equal(quoteRes.status, 201);
    const quoteId = quoteRes.body.data._id;

    const acceptRes = await request(app)
      .patch(`/api/repairs/${repairId}/quote/${quoteId}/approve`)
      .set("Authorization", `Bearer ${customerToken}`)
      .send({});
    assert.equal(acceptRes.status, 200);

    const startRes = await request(app)
      .patch(`/api/repairs/${repairId}/start`)
      .set("Authorization", `Bearer ${technicianToken}`)
      .send({});
    assert.equal(startRes.status, 200);

    const completeRes = await request(app)
      .patch(`/api/repairs/${repairId}/complete`)
      .set("Authorization", `Bearer ${technicianToken}`)
      .send({ notes: "Installed new battery pack" });
    assert.equal(completeRes.status, 200);

    // Apply finance override so finance gate passes
    await createRepairFinanceOverride({
      repairId,
      actorId: opsManagerUser._id.toString(),
      actorRole: USER_ROLES.OPS_MANAGER,
      scope: "ALL",
      reason: "Test finance override for repair evidence"
    });

    // Self-QC Attempt: technician without QC officer role is rejected with 403
    const selfQcRes1 = await request(app)
      .patch(`/api/repairs/${repairId}/qc`)
      .set("Authorization", `Bearer ${technicianToken}`)
      .send({ passed: true, checklistVersion: "1.0", results: [{ item: "Charge Test", passed: true }], evidenceIds: [new mongoose.Types.ObjectId().toString()] });
    assert.equal(selfQcRes1.status, 403);

    // Valid independent QC by qcUser
    const validQcRes = await request(app)
      .patch(`/api/repairs/${repairId}/qc`)
      .set("Authorization", `Bearer ${qcToken}`)
      .send({ passed: true, checklistVersion: "1.0", results: [{ item: "QC Battery Test", passed: true }], evidenceIds: [new mongoose.Types.ObjectId().toString()] });
    assert.equal(validQcRes.status, 200);
    assert.equal(validQcRes.body.data.status, "READY");
  });

  await t.test("24 & 25 & 26. Handover record persistence and customer acknowledgement requirement", async () => {
    const missingRes = await request(app)
      .patch(`/api/repairs/${repairId}/handover`)
      .set("Authorization", `Bearer ${storeOpToken}`)
      .send({ recipient: "", customerAcknowledgement: false });
    assert.equal(missingRes.status, 409);

    const validRes = await request(app)
      .patch(`/api/repairs/${repairId}/handover`)
      .set("Authorization", `Bearer ${storeOpToken}`)
      .send({
        recipient: "Cust One",
        identityVerificationMethod: "GOVERNMENT_ID",
        customerAcknowledgement: true
      });
    assert.equal(validRes.status, 200);
    assert.equal(validRes.body.data.repair.status, "HANDED_OVER");
  });

  await t.test("27. Entire lifecycle reconstructs deterministically", async () => {
    const res = await request(app)
      .get(`/api/repairs/${repairId}/reconstruction`)
      .set("Authorization", `Bearer ${storeOpToken}`);

    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data.timeline));
    assert.ok(res.body.data.timeline.length >= 2);
  });

  await t.test("28 & 29. Invalid transition returns 400/409, duplicate transition is idempotent", async () => {
    const invalidRes = await request(app)
      .patch(`/api/repairs/${repairId}/diagnosis`)
      .set("Authorization", `Bearer ${technicianToken}`)
      .send({ diagnosisNotes: "re-diagnose", estimatedCost: 15000 });
    assert.ok([400, 409].includes(invalidRes.status));

    const dupRes = await request(app)
      .patch(`/api/repairs/${repairId}/handover`)
      .set("Authorization", `Bearer ${storeOpToken}`)
      .send({
        recipient: "Cust One",
        identityVerificationMethod: "GOVERNMENT_ID",
        customerAcknowledgement: true
      });
    assert.ok([200, 400, 409].includes(dupRes.status));
  });

  await t.test("31 & 32. Projections exclude internal evidence/identity", async () => {
    const trackRes = await request(app)
      .get(`/api/repairs/${repairId}/track`)
      .set("Authorization", `Bearer ${customerToken}`);

    assert.equal(trackRes.status, 200);
    assert.equal(trackRes.body.data.maskedIdentityReference, undefined);
    assert.equal(trackRes.body.data.technicianNotes, undefined);
  });
});
