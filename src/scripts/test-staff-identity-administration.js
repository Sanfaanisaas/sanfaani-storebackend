import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

const ACCESS_SECRET = "be21-access-secret-32-characters-long";
let app;
let User;
let StaffInvitation;
let AuthSession;
let RefreshToken;
let AuditLog;
let setAuditServiceTestHooks;
let replicaSet;
let sequence = 0;

const unique = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;
const createUser = (role, overrides = {}) => User.create({ name: `${role} account`, email: `${unique(role)}@example.test`, passwordHash: "$2b$12$STwmCXXAcG1juP88YSrvc.xvHyHZ6Kd.MLSEIDJg.cpO16B1PEc0K", role, status: "ACTIVE", ...overrides });
const tokenFor = (user, overrides = {}) => jwt.sign({ userId: user._id.toString(), role: user.role, authVersion: user.authVersion || 0, type: "access", ...overrides }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" });
const auth = (user, overrides) => ({ Authorization: `Bearer ${tokenFor(user, overrides)}` });
const call = (method, url) => request(app)[method](url).set("X-Forwarded-For", new mongoose.Types.ObjectId().toString());
const invitePayload = (role = "technician") => ({ name: "Invited Staff", email: `${unique("invite")}@example.test`, role });

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "be21-refresh-secret-32-characters-long";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "be21-audit-secret-32-characters-long";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "be21-tracking-secret-32-characters-long";
  process.env.GUIDANCE_TOKEN_SECRET = "be21-guidance-secret-32-characters-long";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_be21_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be21-mongo");
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `be21_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: User } = await import("../models/User.js"));
  ({ default: StaffInvitation } = await import("../models/StaffInvitation.js"));
  ({ default: AuthSession } = await import("../models/AuthSession.js"));
  ({ default: RefreshToken } = await import("../models/RefreshToken.js"));
  ({ default: AuditLog } = await import("../models/AuditLog.js"));
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

test("1. public registration cannot self-assign staff role or status", async () => {
  const response = await call("post", "/api/auth/register").send({ name: "Customer", email: `${unique("register")}@example.test`, password: "StrongPassword123!", phone: "+2348000000000", role: "super_admin", status: "ACTIVE" });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const stored = await User.findById(response.body.data.id);
  assert.equal(stored.role, "customer");
  assert.equal(stored.status, "ACTIVE");
});

test("2. product administrators invite operational staff with a returned-once opaque token", async () => {
  const admin = await createUser("product_admin");
  const payload = invitePayload("technician");
  const response = await call("post", "/api/admin/staff/invitations").set(auth(admin)).set("Idempotency-Key", unique("invite-key")).send(payload);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.data.staff.status, "INVITED");
  assert.match(response.body.data.invitation.token, /^[A-Za-z0-9_-]{43,}$/);
  const raw = response.body.data.invitation.token;
  const stored = await StaffInvitation.findOne({ user: response.body.data.staff.id }).select("+tokenDigest").lean();
  assert.equal(stored.tokenDigest, createHash("sha256").update(raw).digest("hex"));
  assert.equal(JSON.stringify(stored).includes(raw), false);
  const list = await call("get", "/api/admin/staff").set(auth(admin));
  assert.equal(list.status, 200);
  assert.equal(JSON.stringify(list.body).includes(raw), false);
  assert.equal(JSON.stringify(list.body).includes("passwordHash"), false);
  assert.equal(JSON.stringify(list.body).includes("tokenDigest"), false);
});

test("3. staff invitation acceptance is one-time, expiring, and non-enumerating", async () => {
  const admin = await createUser("product_admin");
  const created = await call("post", "/api/admin/staff/invitations").set(auth(admin)).set("Idempotency-Key", unique("accept-key")).send(invitePayload("support_officer"));
  const raw = created.body.data.invitation.token;
  const accepted = await call("post", "/api/auth/staff-invitations/accept").set("X-Staff-Invitation-Token", raw).send({ password: "NewStrongPassword123!" });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.data.staff.status, "ACTIVE");
  const replay = await call("post", "/api/auth/staff-invitations/accept").set("X-Staff-Invitation-Token", raw).send({ password: "NewStrongPassword123!" });
  const random = await call("post", "/api/auth/staff-invitations/accept").set("X-Staff-Invitation-Token", unique("random-token")).send({ password: "NewStrongPassword123!" });
  assert.equal(replay.status, 404);
  assert.equal(random.status, 404);
  assert.deepEqual(replay.body, random.body);
  const expiring = await call("post", "/api/admin/staff/invitations").set(auth(admin)).set("Idempotency-Key", unique("expired-key")).send(invitePayload("store_operator"));
  await StaffInvitation.collection.updateOne({ user: new mongoose.Types.ObjectId(expiring.body.data.staff.id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await call("post", "/api/auth/staff-invitations/accept").set("X-Staff-Invitation-Token", expiring.body.data.invitation.token).send({ password: "NewStrongPassword123!" });
  assert.equal(expired.status, 404);
  assert.deepEqual(expired.body, random.body);
});

test("4. only super administrators can invite or assign privileged administrator roles", async () => {
  const productAdmin = await createUser("product_admin");
  const superAdmin = await createUser("super_admin");
  const technician = await createUser("technician");
  const denied = await call("post", "/api/admin/staff/invitations").set(auth(productAdmin)).set("Idempotency-Key", unique("priv-denied")).send(invitePayload("tech_admin"));
  assert.equal(denied.status, 403);
  const forgedRole = await call("get", "/api/admin/staff/roles").set(auth(technician, { role: "super_admin" }));
  assert.equal(forgedRole.status, 403);
  const allowed = await call("post", "/api/admin/staff/invitations").set(auth(superAdmin)).set("Idempotency-Key", unique("priv-allowed")).send(invitePayload("tech_admin"));
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
});

test("5. role changes use persisted state, optimistic concurrency, audit, and immediate session revocation", async () => {
  const superAdmin = await createUser("super_admin");
  const staff = await createUser("support_officer");
  await AuthSession.create({ sessionId: randomUUID(), familyId: randomUUID(), user: staff._id, currentJti: randomUUID(), expiresAt: new Date(Date.now() + 100000) });
  const session = await AuthSession.findOne({ user: staff._id });
  await RefreshToken.create({ jti: session.currentJti, sessionId: session.sessionId, familyId: session.familyId, user: staff._id, tokenDigest: "a".repeat(64), issuedAt: new Date(), expiresAt: new Date(Date.now() + 100000) });
  const staleAccess = tokenFor(staff);
  const changed = await call("patch", `/api/admin/staff/${staff._id}/role`).set(auth(superAdmin)).send({ expectedVersion: 0, role: "finance_officer", reason: "Finance team transfer" });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.data.role, "finance_officer");
  assert.equal(changed.body.data.version, 1);
  assert.ok((await AuthSession.findById(session._id)).revokedAt);
  assert.equal((await RefreshToken.findOne({ user: staff._id })).status, "revoked");
  assert.equal(await AuditLog.countDocuments({ action: "STAFF_ROLE_CHANGED", targetId: staff._id }), 1);
  const stale = await call("get", "/api/auth/sessions").set("Authorization", `Bearer ${staleAccess}`);
  assert.equal(stale.status, 401);
  const conflict = await call("patch", `/api/admin/staff/${staff._id}/role`).set(auth(superAdmin)).send({ expectedVersion: 0, role: "technician", reason: "Stale update" });
  assert.equal(conflict.status, 409);
});

test("6. suspension invalidates sessions immediately and reactivation never restores them", async () => {
  const superAdmin = await createUser("super_admin");
  const staff = await createUser("technician");
  const oldToken = tokenFor(staff);
  const suspended = await call("post", `/api/admin/staff/${staff._id}/suspend`).set(auth(superAdmin)).send({ expectedVersion: 0, reason: "Access review" });
  assert.equal(suspended.status, 200);
  assert.equal(suspended.body.data.status, "SUSPENDED");
  assert.equal((await call("get", "/api/auth/sessions").set("Authorization", `Bearer ${oldToken}`)).status, 401);
  const reactivated = await call("post", `/api/admin/staff/${staff._id}/reactivate`).set(auth(superAdmin)).send({ expectedVersion: 1, reason: "Review completed" });
  assert.equal(reactivated.status, 200);
  assert.equal(reactivated.body.data.status, "ACTIVE");
  assert.equal((await call("get", "/api/auth/sessions").set("Authorization", `Bearer ${oldToken}`)).status, 401);
});

test("7. administrators cannot change their own role or suspension state", async () => {
  const superAdmin = await createUser("super_admin");
  const role = await call("patch", `/api/admin/staff/${superAdmin._id}/role`).set(auth(superAdmin)).send({ expectedVersion: 0, role: "technician", reason: "Unsafe self demotion" });
  const suspend = await call("post", `/api/admin/staff/${superAdmin._id}/suspend`).set(auth(superAdmin)).send({ expectedVersion: 0, reason: "Unsafe self suspension" });
  assert.equal(role.status, 409);
  assert.equal(suspend.status, 409);
});

test("8. the permission register is explicit, immutable through the API, and least-privilege scoped", async () => {
  const productAdmin = await createUser("product_admin");
  const response = await call("get", "/api/admin/staff/roles").set(auth(productAdmin));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const roles = response.body.data.roles;
  const technician = roles.find((item) => item.role === "technician");
  const finance = roles.find((item) => item.role === "finance_officer");
  const superAdmin = roles.find((item) => item.role === "super_admin");
  assert.ok(technician.permissions.includes("repair.work"));
  assert.equal(technician.permissions.includes("finance.refund"), false);
  assert.ok(finance.permissions.includes("finance.refund"));
  assert.deepEqual(superAdmin.permissions, ["*"]);
  const mutate = await call("patch", "/api/admin/staff/roles/technician").set(auth(productAdmin)).send({ permissions: ["*"] });
  assert.equal(mutate.status, 404);
});

test("9. required audit failure rolls back invitation account creation", async () => {
  const admin = await createUser("product_admin");
  const payload = invitePayload("qc_officer");
  setAuditServiceTestHooks({ beforeWrite: ({ action }) => { if (action === "STAFF_INVITED") throw new Error("forced audit failure"); } });
  const response = await call("post", "/api/admin/staff/invitations").set(auth(admin)).set("Idempotency-Key", unique("audit-fail")).send(payload);
  assert.equal(response.status, 500);
  setAuditServiceTestHooks({});
  assert.equal(await User.countDocuments({ email: payload.email }), 0);
  assert.equal(await StaffInvitation.countDocuments({}), 0);
});

test("10. invitation idempotency replays exactly and rejects payload drift", async () => {
  const admin = await createUser("product_admin");
  const payload = invitePayload("store_operator");
  const idempotencyKey = unique("invite-replay");
  const first = await call("post", "/api/admin/staff/invitations").set(auth(admin)).set("Idempotency-Key", idempotencyKey).send(payload);
  const replay = await call("post", "/api/admin/staff/invitations").set(auth(admin)).set("Idempotency-Key", idempotencyKey).send(payload);
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.staff.id, first.body.data.staff.id);
  assert.equal(replay.body.data.invitation.token, undefined);
  const drift = await call("post", "/api/admin/staff/invitations").set(auth(admin)).set("Idempotency-Key", idempotencyKey).send({ ...payload, role: "technician" });
  assert.equal(drift.status, 409);
});

test("11. invitation rotation revokes the old token and returns the replacement once", async () => {
  const admin = await createUser("product_admin");
  const created = await call("post", "/api/admin/staff/invitations").set(auth(admin)).set("Idempotency-Key", unique("rotation-create")).send(invitePayload("technician"));
  const oldToken = created.body.data.invitation.token;
  const rotationKey = unique("rotation-key");
  const rotated = await call("post", `/api/admin/staff/${created.body.data.staff.id}/invitations`).set(auth(admin)).set("Idempotency-Key", rotationKey).send({});
  assert.equal(rotated.status, 201, JSON.stringify(rotated.body));
  assert.notEqual(rotated.body.data.invitation.token, oldToken);
  const replay = await call("post", `/api/admin/staff/${created.body.data.staff.id}/invitations`).set(auth(admin)).set("Idempotency-Key", rotationKey).send({});
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.invitation.token, undefined);
  const oldAttempt = await call("post", "/api/auth/staff-invitations/accept").set("X-Staff-Invitation-Token", oldToken).send({ password: "NewStrongPassword123!" });
  const replacement = await call("post", "/api/auth/staff-invitations/accept").set("X-Staff-Invitation-Token", rotated.body.data.invitation.token).send({ password: "NewStrongPassword123!" });
  assert.equal(oldAttempt.status, 404);
  assert.equal(replacement.status, 200);
});
