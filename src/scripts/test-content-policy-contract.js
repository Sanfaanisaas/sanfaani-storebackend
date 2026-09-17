import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

const ACCESS_SECRET = "be22-access-secret-32-characters-long";
let app;
let User;
let ContentPage;
let PolicyVersion;
let AuditLog;
let Repair;
let ServiceRequest;
let ProcurementRequest;
let Order;
let Warranty;
let ReturnRequest;
let Evidence;
let capturePolicyAcceptances;
let setAuditServiceTestHooks;
let replicaSet;
let sequence = 0;

const unique = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;
const call = (method, path) => request(app)[method](path).set("X-Forwarded-For", new mongoose.Types.ObjectId().toString());
const createUser = (role) => User.create({ name: `${role} account`, email: `${unique(role)}@example.test`, passwordHash: "$2b$12$STwmCXXAcG1juP88YSrvc.xvHyHZ6Kd.MLSEIDJg.cpO16B1PEc0K", role, status: "ACTIVE" });
const tokenFor = (user, overrides = {}) => jwt.sign({ userId: user._id.toString(), role: user.role, authVersion: user.authVersion || 0, type: "access", ...overrides }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" });
const auth = (user, overrides) => ({ Authorization: `Bearer ${tokenFor(user, overrides)}` });

const pagePayload = (slug) => ({ slug, locale: "en-NG", title: "About Sanfaani", summary: "How our service works", body: "Customer-safe approved content." });
const policyPayload = (key) => ({ key, locale: "en-NG", title: key.replaceAll("_", " "), summary: "Policy summary", body: `Approved ${key} terms.`, effectiveAt: "2026-09-15T00:00:00.000Z" });

const createDraft = async (kind, actor, payload) => call("post", `/api/content/admin/${kind}`).set(auth(actor)).set("Idempotency-Key", unique(`${kind}-create`)).send(payload);
const transition = async (kind, id, action, actor, expectedStateVersion) => call("post", `/api/content/admin/${kind}/${id}/${action}`).set(auth(actor)).send({ expectedStateVersion });
const publishPolicy = async (key, creator, approver) => {
  const draft = await createDraft("policies", creator, policyPayload(key));
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const id = draft.body.data.id;
  assert.equal((await transition("policies", id, "submit", creator, 0)).status, 200);
  assert.equal((await transition("policies", id, "approve", approver, 1)).status, 200);
  const published = await transition("policies", id, "publish", approver, 2);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  return published.body.data;
};

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "be22-refresh-secret-32-characters-long";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "be22-audit-secret-32-characters-long";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "be22-tracking-secret-32-characters-long";
  process.env.GUIDANCE_TOKEN_SECRET = "be22-guidance-secret-32-characters-long";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_be22_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be22-mongo");
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `be22_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: User } = await import("../models/User.js"));
  ({ default: ContentPage } = await import("../models/ContentPage.js"));
  ({ default: PolicyVersion } = await import("../models/PolicyVersion.js"));
  ({ default: AuditLog } = await import("../models/AuditLog.js"));
  ({ default: Repair } = await import("../models/Repair.js"));
  ({ default: ServiceRequest } = await import("../models/ServiceRequest.js"));
  ({ default: ProcurementRequest } = await import("../models/ProcurementRequest.js"));
  ({ default: Order } = await import("../models/Order.js"));
  ({ default: Warranty } = await import("../models/Warranty.js"));
  ({ default: ReturnRequest } = await import("../models/ReturnRequest.js"));
  ({ default: Evidence } = await import("../models/Evidence.js"));
  ({ capturePolicyAcceptances } = await import("../services/contentService.js"));
  ({ setAuditServiceTestHooks } = await import("../services/auditService.js"));
  await mongoose.syncIndexes();
});

test.beforeEach(async () => {
  setAuditServiceTestHooks({});
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
});

test.after(async () => {
  setAuditServiceTestHooks({});
  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test("1. drafts and preview routes never leak publicly and staff roles are constrained", async () => {
  const merchandiser = await createUser("merchandiser");
  const technician = await createUser("technician");
  const slug = unique("about").toLowerCase();
  const denied = await createDraft("pages", technician, pagePayload(slug));
  assert.equal(denied.status, 403);
  const draft = await createDraft("pages", merchandiser, pagePayload(slug));
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  assert.equal((await call("get", `/api/content/pages/${slug}`)).status, 404);
  assert.equal((await call("get", `/api/content/admin/pages/${draft.body.data.id}/preview`)).status, 401);
  assert.equal((await call("get", `/api/content/admin/pages/${draft.body.data.id}/preview`).set(auth(merchandiser))).status, 200);
});

test("2. page lifecycle is ordered, optimistic, separation-controlled, and audited", async () => {
  const merchandiser = await createUser("merchandiser");
  const productAdmin = await createUser("product_admin");
  const draft = await createDraft("pages", merchandiser, pagePayload(unique("lifecycle").toLowerCase()));
  const id = draft.body.data.id;
  assert.equal((await transition("pages", id, "publish", productAdmin, 0)).status, 409);
  const submitted = await transition("pages", id, "submit", merchandiser, 0);
  assert.equal(submitted.body.data.status, "IN_REVIEW");
  assert.equal((await transition("pages", id, "approve", merchandiser, 1)).status, 403);
  const approved = await transition("pages", id, "approve", productAdmin, 1);
  assert.equal(approved.body.data.status, "APPROVED");
  assert.equal((await transition("pages", id, "approve", productAdmin, 1)).status, 409);
  const published = await transition("pages", id, "publish", productAdmin, 2);
  assert.equal(published.body.data.status, "PUBLISHED");
  assert.equal(await AuditLog.countDocuments({ targetId: new mongoose.Types.ObjectId(id), action: { $in: ["CONTENT_SUBMITTED", "CONTENT_APPROVED", "CONTENT_PUBLISHED"] } }), 3);
});

test("3. public page reads use an exact allowlist and expose only the current published version", async () => {
  const merchandiser = await createUser("merchandiser");
  const productAdmin = await createUser("product_admin");
  const slug = unique("public-page").toLowerCase();
  const v1 = await createDraft("pages", merchandiser, pagePayload(slug));
  await transition("pages", v1.body.data.id, "submit", merchandiser, 0);
  await transition("pages", v1.body.data.id, "approve", productAdmin, 1);
  await transition("pages", v1.body.data.id, "publish", productAdmin, 2);
  const v2 = await createDraft("pages", merchandiser, { ...pagePayload(slug), title: "Updated page" });
  await transition("pages", v2.body.data.id, "submit", merchandiser, 0);
  await transition("pages", v2.body.data.id, "approve", productAdmin, 1);
  await transition("pages", v2.body.data.id, "publish", productAdmin, 2);
  const response = await call("get", `/api/content/pages/${slug}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(Object.keys(response.body.data).sort(), ["body", "id", "locale", "publishedAt", "slug", "summary", "title", "updatedAt", "version"].sort());
  assert.equal(response.body.data.version, 2);
  assert.equal(response.body.data.title, "Updated page");
  assert.equal((await ContentPage.findById(v1.body.data.id)).status, "SUPERSEDED");
});

test("4. create idempotency replays the same draft and rejects payload drift", async () => {
  const merchandiser = await createUser("merchandiser");
  const key = unique("content-idempotency");
  const payload = pagePayload(unique("idempotent-page").toLowerCase());
  const first = await call("post", "/api/content/admin/pages").set(auth(merchandiser)).set("Idempotency-Key", key).send(payload);
  const replay = await call("post", "/api/content/admin/pages").set(auth(merchandiser)).set("Idempotency-Key", key).send(payload);
  const drift = await call("post", "/api/content/admin/pages").set(auth(merchandiser)).set("Idempotency-Key", key).send({ ...payload, title: "Changed" });
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.id, first.body.data.id);
  assert.equal(drift.status, 409);
});

test("5. all nine launch policies have stable keys and public policy DTOs are allowlisted", async () => {
  const merchandiser = await createUser("merchandiser");
  const productAdmin = await createUser("product_admin");
  const expected = ["b2b_quotation_terms", "cookie_analytics_notice", "delivery_pickup_policy", "device_data_backup_acknowledgement", "privacy_notice", "repair_custody_terms", "returns_refund_policy", "terms_of_sale", "warranty_policy"].sort();
  const { REQUIRED_LAUNCH_POLICY_KEYS } = await import("../services/contentService.js");
  assert.deepEqual([...REQUIRED_LAUNCH_POLICY_KEYS].sort(), expected);
  await publishPolicy("privacy_notice", merchandiser, productAdmin);
  const response = await call("get", "/api/content/policies/privacy_notice");
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(Object.keys(response.body.data).sort(), ["body", "effectiveAt", "id", "key", "locale", "publishedAt", "summary", "title", "updatedAt", "version"].sort());
  assert.equal(JSON.stringify(response.body).includes("createdBy"), false);
});

test("6. policy versions supersede deterministically and public drafts never replace approved content", async () => {
  const merchandiser = await createUser("merchandiser");
  const productAdmin = await createUser("product_admin");
  const v1 = await publishPolicy("terms_of_sale", merchandiser, productAdmin);
  const v2 = await createDraft("policies", merchandiser, { ...policyPayload("terms_of_sale"), title: "Future terms" });
  assert.equal(v2.body.data.version, 2);
  assert.equal((await call("get", "/api/content/policies/terms_of_sale")).body.data.id, v1.id);
  await transition("policies", v2.body.data.id, "submit", merchandiser, 0);
  await transition("policies", v2.body.data.id, "approve", productAdmin, 1);
  await transition("policies", v2.body.data.id, "publish", productAdmin, 2);
  assert.equal((await call("get", "/api/content/policies/terms_of_sale")).body.data.id, v2.body.data.id);
  assert.equal((await PolicyVersion.findById(v1.id)).status, "SUPERSEDED");
});

test("7. every protected domain maps to explicit current policy/version identifiers", async () => {
  const merchandiser = await createUser("merchandiser");
  const productAdmin = await createUser("product_admin");
  for (const key of ["terms_of_sale", "warranty_policy", "returns_refund_policy", "repair_custody_terms", "device_data_backup_acknowledgement", "privacy_notice", "cookie_analytics_notice", "delivery_pickup_policy", "b2b_quotation_terms"]) {
    await publishPolicy(key, merchandiser, productAdmin);
  }
  const expectations = {
    checkout: ["delivery_pickup_policy", "terms_of_sale"],
    repair_intake: ["device_data_backup_acknowledgement", "privacy_notice", "repair_custody_terms"],
    warranty: ["warranty_policy"],
    return: ["returns_refund_policy"],
    evidence: ["privacy_notice"],
    b2b: ["b2b_quotation_terms"],
    service: ["device_data_backup_acknowledgement", "repair_custody_terms"],
  };
  for (const [domain, keys] of Object.entries(expectations)) {
    const refs = await capturePolicyAcceptances(domain);
    assert.deepEqual(refs.map((item) => item.key).sort(), keys.sort());
    assert.ok(refs.every((item) => mongoose.isObjectIdOrHexString(item.policyVersionId) && item.version === 1 && item.acceptedAt instanceof Date));
  }
});

test("8. checkout, repair, warranty, return, evidence, B2B, and service records retain immutable policy snapshots", async () => {
  const merchandiser = await createUser("merchandiser");
  const productAdmin = await createUser("product_admin");
  const customer = await createUser("customer");
  for (const key of ["terms_of_sale", "delivery_pickup_policy", "warranty_policy", "returns_refund_policy", "repair_custody_terms", "device_data_backup_acknowledgement", "privacy_notice", "b2b_quotation_terms"]) await publishPolicy(key, merchandiser, productAdmin);
  const repair = await call("post", "/api/repairs").set(auth(customer)).send({ device: { type: "phone", brand: "Sanfaani", model: "One" }, issueDescription: "Screen needs repair", privacyAcknowledged: true });
  assert.equal(repair.status, 201, JSON.stringify(repair.body));
  const storedRepair = await Repair.findById(repair.body.data.repair.id || repair.body.data.repair._id);
  assert.deepEqual(storedRepair.policyAcceptances.map((item) => item.key).sort(), ["device_data_backup_acknowledgement", "privacy_notice", "repair_custody_terms"]);
  const service = await call("post", "/api/services/requests").set(auth(customer)).set("Idempotency-Key", unique("service")).send({ serviceType: "DEVICE_SETUP", deviceCategory: "Laptop", desiredOutcome: "Secure setup", licenceOwnershipAcknowledgement: true, backupAcknowledgement: true });
  assert.equal(service.status, 201, JSON.stringify(service.body));
  assert.deepEqual((await ServiceRequest.findById(service.body.data.id)).policyAcceptances.map((item) => item.key).sort(), ["device_data_backup_acknowledgement", "repair_custody_terms"]);
  const procurement = await call("post", "/api/procurement/requests").set(auth(customer)).set("Idempotency-Key", unique("b2b")).send({ organisationName: "Example School", organisationType: "school", contactName: "Buyer", contactEmail: "buyer@example.test", contactPhone: "+2348000000000", requirements: [{ category: "Laptop", quantity: 2, minimumSpecifications: "16GB RAM" }] });
  assert.equal(procurement.status, 201, JSON.stringify(procurement.body));
  assert.deepEqual((await ProcurementRequest.findById(procurement.body.data.id)).policyAcceptances.map((item) => item.key), ["b2b_quotation_terms"]);

  const order = await Order.create({ userId: customer._id, items: [], shippingAddress: { street: "1 Test Street", city: "Lagos", state: "Lagos", country: "NG" }, subtotal: 0, tax: 0, shippingCost: 0, total: 0, paymentMethod: "paystack", policyAcceptances: await capturePolicyAcceptances("checkout") });
  assert.deepEqual(order.policyAcceptances.map((item) => item.key).sort(), ["delivery_pickup_policy", "terms_of_sale"]);
  const warranty = await Warranty.create({ repair: storedRepair._id, customer: customer._id, deviceSummary: "Phone", expiresAt: new Date(Date.now() + 86400000), policyAcceptances: await capturePolicyAcceptances("warranty") });
  assert.deepEqual(warranty.policyAcceptances.map((item) => item.key), ["warranty_policy"]);
  const returned = await ReturnRequest.create({ order: order._id, owner: customer._id, items: [{ variantSku: "TEST-SKU", quantity: 1 }], reason: "No longer required", idempotencyKey: unique("return"), idempotencyFingerprint: "a".repeat(64), policyAcceptances: await capturePolicyAcceptances("return") });
  assert.deepEqual(returned.policyAcceptances.map((item) => item.key), ["returns_refund_policy"]);
  const evidence = await Evidence.create({ subjectType: "order", subject: order._id, owner: customer._id, purpose: "order_receipt", displayName: "receipt.jpg", objectKey: unique("object-key"), checksum: "b".repeat(64), detectedMimeType: "image/jpeg", size: 10, uploader: customer._id, policyAcceptances: await capturePolicyAcceptances("evidence") });
  assert.deepEqual(evidence.policyAcceptances.map((item) => item.key), ["privacy_notice"]);
  evidence.policyAcceptances = [];
  await evidence.save();
  assert.deepEqual((await Evidence.findById(evidence._id)).policyAcceptances.map((item) => item.key), ["privacy_notice"]);
});

test("9. referenced required policy versions cannot be deleted and no public delete route exists", async () => {
  const merchandiser = await createUser("merchandiser");
  const productAdmin = await createUser("product_admin");
  const policy = await publishPolicy("privacy_notice", merchandiser, productAdmin);
  const refs = await capturePolicyAcceptances("evidence");
  await Repair.create({ customer: productAdmin._id, device: { type: "phone", brand: "A", model: "B" }, issueDescription: "Long enough issue", privacyAcknowledged: true, policyAcceptances: refs });
  const replacement = await createDraft("policies", merchandiser, { ...policyPayload("privacy_notice"), title: "Replacement privacy notice" });
  await transition("policies", replacement.body.data.id, "submit", merchandiser, 0);
  await transition("policies", replacement.body.data.id, "approve", productAdmin, 1);
  await transition("policies", replacement.body.data.id, "publish", productAdmin, 2);
  const denied = await call("delete", `/api/content/admin/policies/${policy.id}`).set(auth(productAdmin));
  assert.equal(denied.status, 409);
  assert.equal(denied.body.errors[0].code, "policy_version_referenced");
  assert.equal((await call("delete", `/api/content/policies/${policy.id}`)).status, 404);
});

test("10. malformed identifiers and unknown public content use controlled envelopes", async () => {
  const productAdmin = await createUser("product_admin");
  const malformed = await call("get", "/api/content/admin/pages/not-an-object-id/preview").set(auth(productAdmin));
  assert.equal(malformed.status, 422);
  assert.equal(malformed.body.success, false);
  const missing = await call("get", "/api/content/pages/unknown-page");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.success, false);
  assert.equal(JSON.stringify(missing.body).includes("CastError"), false);
});

test("11. required publication audit failure rolls back both supersession and publication", async () => {
  const merchandiser = await createUser("merchandiser");
  const productAdmin = await createUser("product_admin");
  const current = await publishPolicy("warranty_policy", merchandiser, productAdmin);
  const replacement = await createDraft("policies", merchandiser, { ...policyPayload("warranty_policy"), title: "Replacement warranty" });
  await transition("policies", replacement.body.data.id, "submit", merchandiser, 0);
  await transition("policies", replacement.body.data.id, "approve", productAdmin, 1);
  setAuditServiceTestHooks({ beforeWrite: ({ action }) => { if (action === "POLICY_PUBLISHED") throw new Error("forced publication audit failure"); } });
  const failed = await transition("policies", replacement.body.data.id, "publish", productAdmin, 2);
  assert.equal(failed.status, 500);
  setAuditServiceTestHooks({});
  assert.equal((await PolicyVersion.findById(current.id)).status, "PUBLISHED");
  assert.equal((await PolicyVersion.findById(replacement.body.data.id)).status, "APPROVED");
});
