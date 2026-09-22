import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app;
let AppError;
let AuditLog;
let Evidence;
let EvidenceCleanupTask;
let Order;
let Repair;
let createS3CompatibleStorageAdapter;
let memoryEvidenceStorageAdapter;
let processEvidenceCleanupBatch;
let queueEvidenceCleanup;
let setAuditServiceTestHooks;
let setEvidenceStorageAdapter;
let validateEnvironment;
let replicaSet;
let storage;
let sequence = 0;
const ACCESS_SECRET = "evidence-storage-access-secret-at-least-32-characters";
const id = () => new mongoose.Types.ObjectId();
const next = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const auth = (userId, role = "customer") => ({ Authorization: `Bearer ${jwt.sign({ userId: userId.toString(), role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}` });
const clear = async () => { for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({}); };
const createOrder = async (owner) => Order.create({
  userId: owner,
  items: [],
  shippingAddress: { street: "1 Evidence Street", city: "Lagos", state: "LA", country: "Nigeria" },
  subtotal: 1000,
  total: 1000,
  paymentMethod: "bank_transfer",
});
const upload = ({ owner, orderId, purpose = "order_receipt", subjectType = "order", subjectId = orderId, file = jpeg, filename = "receipt.jpg", contentType = "image/jpeg", role = "customer" } = {}) => request(app)
  .post("/api/evidence")
  .set(auth(owner, role))
  .field("subjectType", subjectType)
  .field("subjectId", String(subjectId))
  .field("purpose", purpose)
  .attach("file", file, { filename, contentType });
const createUploadedOrderEvidence = async (owner = id()) => {
  const order = await createOrder(owner);
  const response = await upload({ owner, orderId: order._id });
  assert.equal(response.status, 201);
  return { owner, order, response, evidence: await Evidence.findById(response.body.data.id).select("+objectKey") };
};

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "evidence-storage-refresh-secret-at-least-32-characters";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "evidence-storage-audit-secret-at-least-32-characters";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "evidence-storage-tracking-secret-at-least-32-characters";
  process.env.GUIDANCE_TOKEN_SECRET = "evidence-storage-guidance-secret-at-least-32-characters";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_evidence_storage";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be09-mongo");
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `evidence_storage_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: AppError } = await import("../utils/AppError.js"));
  ({ default: AuditLog } = await import("../models/AuditLog.js"));
  ({ default: Evidence } = await import("../models/Evidence.js"));
  ({ default: EvidenceCleanupTask } = await import("../models/EvidenceCleanupTask.js"));
  ({ default: Order } = await import("../models/Order.js"));
  ({ default: Repair } = await import("../models/Repair.js"));
  ({ createS3CompatibleStorageAdapter, memoryEvidenceStorageAdapter, setEvidenceStorageAdapter } = await import("../services/evidenceStorageService.js"));
  ({ processEvidenceCleanupBatch, queueEvidenceCleanup } = await import("../services/evidenceCleanupService.js"));
  ({ setAuditServiceTestHooks } = await import("../services/auditService.js"));
  ({ validateEnvironment } = await import("../config/env.js"));
  await mongoose.syncIndexes();
});

test.beforeEach(async () => {
  await clear();
  setAuditServiceTestHooks();
  storage = memoryEvidenceStorageAdapter();
  setEvidenceStorageAdapter(storage);
});

test.after(async () => {
  setAuditServiceTestHooks();
  setEvidenceStorageAdapter(null);
  if (mongoose.connection.readyState) await mongoose.disconnect();
  await replicaSet?.stop();
});

test("1. an authorized customer uploads evidence through the real route", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await upload({ owner, orderId: order._id });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.purpose, "order_receipt");
  assert.equal(await Evidence.countDocuments(), 1);
  assert.equal(await AuditLog.countDocuments({ action: "EVIDENCE_UPLOADED" }), 1);
});

test("2. persisted metadata records detected MIME type, size, category, and checksum", async () => {
  const { evidence } = await createUploadedOrderEvidence();
  assert.equal(evidence.detectedMimeType, "image/jpeg");
  assert.equal(evidence.size, jpeg.length);
  assert.equal(evidence.purpose, "order_receipt");
  assert.match(evidence.checksum, /^[a-f0-9]{64}$/);
});

test("3. uploads use cryptographically random private object keys", async () => {
  const { evidence } = await createUploadedOrderEvidence();
  assert.match(evidence.objectKey, /^private\/evidence\/[A-Za-z0-9_-]{43}$/);
  assert.equal(storage.keys().length, 1);
});

test("4. an original filename is never used as the object key", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await upload({ owner, orderId: order._id, filename: "Ada-Lovelace-repair-serial-123.jpg" });
  const evidence = await Evidence.findById(response.body.data.id).select("+objectKey");
  assert.equal(evidence.objectKey.includes("Ada"), false);
  assert.equal(evidence.objectKey.includes(order._id.toString()), false);
});

test("5. empty files fail validation", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await upload({ owner, orderId: order._id, file: Buffer.alloc(0) });
  assert.equal(response.status, 400);
  assert.equal(await Evidence.countDocuments(), 0);
});

test("6. oversized files fail before persistence", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await upload({ owner, orderId: order._id, file: Buffer.alloc(5 * 1024 * 1024 + 1, 1) });
  assert.equal(response.status, 400);
  assert.equal(await Evidence.countDocuments(), 0);
});

test("7. excess evidence files use the standard validation envelope", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await request(app).post("/api/evidence").set(auth(owner))
    .field("subjectType", "order").field("subjectId", String(order._id)).field("purpose", "order_receipt")
    .attach("file", jpeg, { filename: "one.jpg", contentType: "image/jpeg" })
    .attach("file", jpeg, { filename: "two.jpg", contentType: "image/jpeg" });
  assert.equal(response.status, 400);
  assert.equal(response.body.success, false);
});

test("8. unsupported content is rejected even when the submitted MIME type is allowed", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await upload({ owner, orderId: order._id, file: Buffer.from("not an image"), contentType: "image/jpeg" });
  assert.equal(response.status, 400);
});

test("9. a spoofed submitted MIME type is rejected", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await upload({ owner, orderId: order._id, contentType: "application/pdf" });
  assert.equal(response.status, 400);
});

test("10. a missing category fails", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await request(app).post("/api/evidence").set(auth(owner))
    .field("subjectType", "order").field("subjectId", String(order._id))
    .attach("file", jpeg, { filename: "receipt.jpg", contentType: "image/jpeg" });
  assert.equal(response.status, 400);
});

test("11. an invalid domain category pair fails", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await upload({ owner, orderId: order._id, purpose: "qc" });
  assert.equal(response.status, 400);
});

test("12. foreign customer uploads use a non-enumerating 404", async () => {
  const owner = id(); const foreign = id(); const order = await createOrder(owner);
  const response = await upload({ owner: foreign, orderId: order._id });
  assert.equal(response.status, 404);
  assert.equal(response.body.errors[0].code, "evidence_unavailable");
});

test("13. a staff member outside the workflow role receives 403", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await upload({ owner, orderId: order._id, role: "sales_advisor" });
  assert.equal(response.status, 403);
});

test("14. an authorized owner obtains an opaque short-lived signed download", async () => {
  const { owner, evidence } = await createUploadedOrderEvidence();
  const response = await request(app).get(`/api/evidence/${evidence._id}/download`).set(auth(owner));
  assert.equal(response.status, 200);
  assert.match(response.body.data.url, /^memory:\/\/evidence-download\//);
  assert.equal(new Date(response.body.data.expiresAt) > new Date(), true);
  assert.equal(await AuditLog.countDocuments({ action: "EVIDENCE_DOWNLOAD_AUTHORIZED" }), 1);
});

test("15. a foreign customer cannot obtain a signed download", async () => {
  const { evidence } = await createUploadedOrderEvidence();
  const response = await request(app).get(`/api/evidence/${evidence._id}/download`).set(auth(id()));
  assert.equal(response.status, 404);
});

test("16. customer upload and download responses omit the raw object key", async () => {
  const { owner, response, evidence } = await createUploadedOrderEvidence();
  const download = await request(app).get(`/api/evidence/${evidence._id}/download`).set(auth(owner));
  const body = JSON.stringify({ upload: response.body, download: download.body });
  assert.equal(body.includes(evidence.objectKey), false);
});

test("17. signed URLs are not persisted in evidence or audit records", async () => {
  const { owner, evidence } = await createUploadedOrderEvidence();
  const download = await request(app).get(`/api/evidence/${evidence._id}/download`).set(auth(owner));
  const serialized = JSON.stringify({ evidence: await Evidence.findById(evidence._id).lean(), audits: await AuditLog.find().lean() });
  assert.equal(serialized.includes(download.body.data.url), false);
});

test("18. storage failure creates no evidence metadata", async () => {
  const owner = id(); const order = await createOrder(owner);
  setEvidenceStorageAdapter({ ...storage, putObject: async () => { throw new AppError("Evidence storage is temporarily unavailable", 503); } });
  const response = await upload({ owner, orderId: order._id });
  assert.equal(response.status, 503);
  assert.equal(await Evidence.countDocuments(), 0);
});

test("19. metadata transaction failure removes the newly written object", async () => {
  const owner = id(); const order = await createOrder(owner);
  setAuditServiceTestHooks({ beforeWrite: ({ action }) => { if (action === "EVIDENCE_UPLOADED") throw new Error("forced evidence audit failure"); } });
  const response = await upload({ owner, orderId: order._id });
  assert.equal(response.status, 500);
  assert.equal(await Evidence.countDocuments(), 0);
  assert.equal(storage.objectCount(), 0);
});

test("20. failed compensation creates a retryable cleanup record", async () => {
  const owner = id(); const order = await createOrder(owner);
  setEvidenceStorageAdapter({ ...storage, deleteObject: async () => { throw new AppError("Evidence storage is temporarily unavailable", 503); } });
  setAuditServiceTestHooks({ beforeWrite: ({ action }) => { if (action === "EVIDENCE_UPLOADED") throw new Error("forced evidence audit failure"); } });
  const response = await upload({ owner, orderId: order._id });
  assert.equal(response.status, 500);
  const task = await EvidenceCleanupTask.findOne().select("+objectKey");
  assert.equal(task.taskType, "DELETE_ORPHAN");
  assert.equal(task.status, "PENDING");
  assert.match(task.objectKey, /^private\/evidence\//);
});

test("21. the cleanup worker removes an orphan through the real storage interface", async () => {
  const owner = id(); const key = "private/evidence/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await storage.putObject({ key, body: jpeg, contentType: "image/jpeg" });
  await queueEvidenceCleanup({ taskType: "DELETE_ORPHAN", objectKey: key, actorId: owner });
  const result = await processEvidenceCleanupBatch({ limit: 5 });
  assert.deepEqual(result, { processed: 1, completed: 1, retried: 0, exhausted: 0 });
  assert.equal(storage.objectCount(), 0);
  assert.equal((await EvidenceCleanupTask.findOne()).status, "COMPLETED");
  assert.equal(await AuditLog.countDocuments({ action: "EVIDENCE_CLEANUP_COMPLETED" }), 1);
});

test("22. the cleanup worker is idempotent after a completed deletion", async () => {
  const owner = id(); const key = "private/evidence/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await queueEvidenceCleanup({ taskType: "DELETE_ORPHAN", objectKey: key, actorId: owner });
  await processEvidenceCleanupBatch({ limit: 1 });
  assert.deepEqual(await processEvidenceCleanupBatch({ limit: 1 }), { processed: 0, completed: 0, retried: 0, exhausted: 0 });
});

test("23. cleanup retries are bounded and become exhausted", async () => {
  const owner = id(); const key = "private/evidence/ccccccccccccccccccccccccccccccccccccccccccc";
  setEvidenceStorageAdapter({ ...storage, headObject: async () => { throw new AppError("Evidence storage is temporarily unavailable", 503); } });
  await queueEvidenceCleanup({ taskType: "DELETE_ORPHAN", objectKey: key, actorId: owner });
  for (let count = 0; count < 5; count += 1) {
    await processEvidenceCleanupBatch({ limit: 1 });
    await EvidenceCleanupTask.updateOne({}, { $set: { nextAttemptAt: new Date(Date.now() - 1) } });
  }
  const task = await EvidenceCleanupTask.findOne();
  assert.equal(task.status, "EXHAUSTED");
  assert.equal(task.attempts, 5);
  assert.equal(await AuditLog.countDocuments({ action: "EVIDENCE_CLEANUP_EXHAUSTED" }), 1);
});

test("24. authorized evidence deletion is audited and finalizes retention state", async () => {
  const { owner, evidence } = await createUploadedOrderEvidence();
  const response = await request(app).delete(`/api/evidence/${evidence._id}`).set(auth(owner));
  assert.equal(response.status, 200);
  assert.equal((await Evidence.findById(evidence._id)).retentionState, "DELETED");
  assert.equal(await AuditLog.countDocuments({ action: "EVIDENCE_DELETE_REQUESTED" }), 1);
  assert.equal(await AuditLog.countDocuments({ action: "EVIDENCE_DELETED" }), 1);
});

test("25. evidence cannot be read through a different domain authorization path", async () => {
  const owner = id();
  const repair = await Repair.create({ customer: owner, device: { type: "phone", brand: "Sanfaani", model: "Evidence isolation" }, issueDescription: "Private", privacyAcknowledged: true });
  const key = "private/evidence/ddddddddddddddddddddddddddddddddddddddddddd";
  await storage.putObject({ key, body: jpeg, contentType: "image/jpeg" });
  const evidence = await Evidence.create({ subjectType: "order", subject: repair._id, owner, purpose: "order_receipt", displayName: "corrupt-link.jpg", objectKey: key, checksum: "d".repeat(64), detectedMimeType: "image/jpeg", size: jpeg.length, uploader: owner });
  const response = await request(app).get(`/api/evidence/${evidence._id}/download`).set(auth(owner));
  assert.equal(response.status, 404);
});

test("26. download enumeration uses the standard rate-limit envelope", async () => {
  const { owner, evidence } = await createUploadedOrderEvidence();
  let response;
  for (let count = 0; count < 61; count += 1) response = await request(app).get(`/api/evidence/${evidence._id}/download`).set(auth(owner));
  assert.equal(response.status, 429);
  assert.equal(response.body.success, false);
  assert.equal(response.body.errors[0].code, "evidence_download_rate_limited");
});

test("27. evidence audit records and client responses contain no buffer, key, URL, or provider secret", async () => {
  const { owner, response, evidence } = await createUploadedOrderEvidence();
  const download = await request(app).get(`/api/evidence/${evidence._id}/download`).set(auth(owner));
  const serial = JSON.stringify({ response: response.body, download: download.body, audits: await AuditLog.find().lean() });
  assert.equal(serial.includes(evidence.objectKey), false);
  assert.equal(serial.includes(jpeg.toString("base64")), false);
  assert.equal(serial.includes(process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY || "not-configured-secret"), false);
});

test("28. production configuration is validated and signing never contacts an S3 provider", async () => {
  const productionValues = {
    PORT: "5000", MONGO_URI: "mongodb://127.0.0.1:27017/sanfaani", JWT_SECRET: ACCESS_SECRET,
    JWT_REFRESH_SECRET: "different-evidence-refresh-secret-at-least-32-characters", SECURITY_AUDIT_HMAC_SECRET: "evidence-audit-hmac-secret-at-least-32-characters",
    REPAIR_TRACKING_TOKEN_SECRET: "evidence-tracking-secret-at-least-32-characters", GUIDANCE_TOKEN_SECRET: "evidence-guidance-secret-at-least-32-characters",
    PAYSTACK_MODE: "test", PAYSTACK_SECRET_KEY: "sk_test_evidence_storage", PAYSTACK_CALLBACK_URL: "https://example.test/paystack/callback", NODE_ENV: "production",
  };
  assert.equal(validateEnvironment(productionValues).success, false);
  const adapter = createS3CompatibleStorageAdapter({ endpoint: "https://object.example.test", region: "us-east-1", bucket: "private-evidence", accessKeyId: "test-access-key", secretAccessKey: "test-secret-key-material-at-least-16", forcePathStyle: true, signedUrlTtlSeconds: 300 });
  const signed = await adapter.getSignedDownloadUrl({ key: "private/evidence/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", expiresInSeconds: 300 });
  assert.match(signed.url, /^https:\/\/object\.example\.test\/private-evidence\//);
  assert.equal(signed.url.includes("test-secret-key-material"), false);
});
