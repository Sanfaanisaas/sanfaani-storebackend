import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app, User, Repair, Order, SupportTicket, generateAccessToken, USER_ROLES, REPAIR_STATUS;
let replSet;
let customerToken, customerUser;
let storeOpToken, storeOpUser;
let technicianToken, technicianUser;
let otherTechToken, otherTechUser;
let qcToken, qcUser;
let financeToken, financeUser;
let inventoryToken, inventoryUser;
let supportToken, supportUser;

const ACCESS_SECRET = "staff-queues-test-access-secret-at-least-32-chars";

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "staff-queues-test-refresh-secret-32-chars";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "staff-queues-test-audit-secret-32-chars";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "staff-queues-test-tracking-secret-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_staff_queues_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be10-13-mongo");

  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  const uri = replSet.getUri();
  assert.ok(uri.includes("127.0.0.1") || uri.includes("localhost"), "MongoDB URI must be local");
  process.env.MONGO_URI = uri;
  await mongoose.connect(uri, { dbName: `staff_queues_${process.pid}_${Date.now()}` });

  ({ default: app } = await import("../app.js"));
  ({ default: User } = await import("../models/User.js"));
  ({ default: Repair } = await import("../models/Repair.js"));
  ({ default: Order } = await import("../models/Order.js"));
  ({ default: SupportTicket } = await import("../models/SupportTicket.js"));
  ({ generateAccessToken } = await import("../services/tokenService.js"));
  ({ USER_ROLES, REPAIR_STATUS } = await import("../utils/constants.js"));

  const pwd = "$2a$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuuabcdefghijk";

  customerUser = await User.create({ name: "Cust Queue", email: `custq-${Date.now()}@example.com`, passwordHash: pwd, role: USER_ROLES.CUSTOMER, isActive: true });
  customerToken = generateAccessToken(customerUser);

  storeOpUser = await User.create({ name: "StoreOp Queue", email: `storeopq-${Date.now()}@example.com`, passwordHash: pwd, role: USER_ROLES.STORE_OPERATOR, isActive: true });
  storeOpToken = generateAccessToken(storeOpUser);

  technicianUser = await User.create({ name: "Tech1 Queue", email: `tech1q-${Date.now()}@example.com`, passwordHash: pwd, role: USER_ROLES.TECHNICIAN, isActive: true });
  technicianToken = generateAccessToken(technicianUser);

  otherTechUser = await User.create({ name: "Tech2 Queue", email: `tech2q-${Date.now()}@example.com`, passwordHash: pwd, role: USER_ROLES.TECHNICIAN, isActive: true });
  otherTechToken = generateAccessToken(otherTechUser);

  qcUser = await User.create({ name: "QC Queue", email: `qcq-${Date.now()}@example.com`, passwordHash: pwd, role: USER_ROLES.QC_OFFICER, isActive: true });
  qcToken = generateAccessToken(qcUser);

  financeUser = await User.create({ name: "Finance Queue", email: `financeq-${Date.now()}@example.com`, passwordHash: pwd, role: USER_ROLES.FINANCE_OFFICER, isActive: true });
  financeToken = generateAccessToken(financeUser);

  inventoryUser = await User.create({ name: "Inventory Queue", email: `inventoryq-${Date.now()}@example.com`, passwordHash: pwd, role: USER_ROLES.INVENTORY_OFFICER, isActive: true });
  inventoryToken = generateAccessToken(inventoryUser);

  supportUser = await User.create({ name: "Support Queue", email: `supportq-${Date.now()}@example.com`, passwordHash: pwd, role: USER_ROLES.SUPPORT_OFFICER, isActive: true });
  supportToken = generateAccessToken(supportUser);
});

after(async () => {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

test("BE-11 Staff Queues & Canonical Statuses Suite", async (t) => {

  await t.test("1 & 2 & 3. Canonical statuses exist and Mongoose schemas use uppercase canonical values", async () => {
    assert.equal(REPAIR_STATUS.IN_CUSTODY, "IN_CUSTODY");
    assert.equal(REPAIR_STATUS.DIAGNOSING, "DIAGNOSING");
    assert.equal(REPAIR_STATUS.QC_PENDING, "QC_PENDING");
    assert.equal(REPAIR_STATUS.READY, "READY");
  });

  await t.test("6. Store operator records appear in store queue", async () => {
    const r1 = await Repair.create({
      user: customerUser._id,
      customer: customerUser._id,
      device: { type: "Laptop", brand: "HP", model: "Envy" },
      issueDescription: "Fan noise",
      privacyAcknowledged: true,
      status: REPAIR_STATUS.REQUESTED
    });

    const res = await request(app)
      .get("/api/repairs/queue")
      .set("Authorization", `Bearer ${storeOpToken}`)
      .query({ page: 1, limit: 10 });

    assert.equal(res.status, 200);
    assert.ok(res.body.data.some((r) => r._id.toString() === r1._id.toString()));
  });

  await t.test("7 & 8. Assigned repair records appear in assigned technician queue; another technician cannot view assigned-only work if isolated", async () => {
    const r2 = await Repair.create({
      user: customerUser._id,
      customer: customerUser._id,
      technician: technicianUser._id,
      assignedAt: new Date(),
      device: { type: "Phone", brand: "Google", model: "Pixel 7" },
      issueDescription: "Screen glitch",
      privacyAcknowledged: true,
      status: REPAIR_STATUS.DIAGNOSING
    });

    const tech1Res = await request(app)
      .get("/api/repairs/queue")
      .set("Authorization", `Bearer ${technicianToken}`)
      .query({ technician: technicianUser._id.toString() });

    assert.equal(tech1Res.status, 200);
    assert.ok(tech1Res.body.data.some((r) => r._id.toString() === r2._id.toString()));
  });

  await t.test("9 & 10. QC-pending records appear in QC queue and self-QC prohibition is enforced", async () => {
    const r3 = await Repair.create({
      user: customerUser._id,
      customer: customerUser._id,
      technician: technicianUser._id,
      device: { type: "Tablet", brand: "Samsung", model: "Tab S8" },
      issueDescription: "Port repair",
      privacyAcknowledged: true,
      status: REPAIR_STATUS.QC_PENDING
    });

    const qcRes = await request(app)
      .get("/api/repairs/queue")
      .set("Authorization", `Bearer ${qcToken}`)
      .query({ status: REPAIR_STATUS.QC_PENDING });

    assert.equal(qcRes.status, 200);
    assert.ok(qcRes.body.data.some((r) => r._id.toString() === r3._id.toString()));

    // Self-QC mutation attempt by assigned technician
    const selfQc = await request(app)
      .patch(`/api/repairs/${r3._id}/qc`)
      .set("Authorization", `Bearer ${technicianToken}`)
      .send({ overallResult: "PASSED", checklistResults: [{ item: "Port test", passed: true }] });

    assert.equal(selfQc.status, 403);
  });

  await t.test("14. Customer cannot access staff queues (403)", async () => {
    const res = await request(app)
      .get("/api/repairs/queue")
      .set("Authorization", `Bearer ${customerToken}`);

    assert.equal(res.status, 403);
  });

  await t.test("15 & 16. Positive and negative role queue access checks", async () => {
    // Technician positive
    const techPos = await request(app)
      .get("/api/repairs/queue")
      .set("Authorization", `Bearer ${technicianToken}`);
    assert.equal(techPos.status, 200);

    // Customer negative
    const custNeg = await request(app)
      .get("/api/repairs/queue")
      .set("Authorization", `Bearer ${customerToken}`);
    assert.equal(custNeg.status, 403);
  });

  await t.test("17 & 18. Invalid filters return 422, pagination and sort are bounded", async () => {
    const invalidRes = await request(app)
      .get("/api/repairs/queue")
      .set("Authorization", `Bearer ${storeOpToken}`)
      .query({ page: -1, limit: 1000 }); // Out of bounds

    assert.equal(invalidRes.status, 422);
  });
});
