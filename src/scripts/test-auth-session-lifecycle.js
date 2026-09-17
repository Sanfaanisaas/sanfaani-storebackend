import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app;
let AuthSession;
let RefreshToken;
let SecurityAuditEvent;
let User;
let runtimeEnv;
let tokenService;
let auditService;
let validateEnvironment;
let authController;
let originService;
let setAuthSessionTestHooks;
let replSet;
let sequence = 0;

const trustedOrigin = "https://a.example";
const secondTrustedOrigin = "https://b.example";
const cookieValue = (response) => {
  const header = response.headers["set-cookie"]?.find((value) => value.startsWith("refreshToken="));
  return header?.split(";")[0];
};
const cookieToken = (cookie) => cookie?.slice("refreshToken=".length);
const assertEnvelope = (response, status = 401) => {
  assert.equal(response.status, status, JSON.stringify(response.body));
  assert.equal(response.body.success, false);
  assert.equal(typeof response.body.message, "string");
  assert.ok(Array.isArray(response.body.errors));
  const text = JSON.stringify(response.body);
  for (const forbidden of ["stack", "JsonWebTokenError", "TokenExpiredError", "MongoServerError"]) {
    assert.equal(text.includes(forbidden), false);
  }
};
const createUser = async (suffix = ++sequence) => User.create({
  name: `Session User ${suffix}`,
  email: `session-${suffix}@example.test`,
  passwordHash: await bcrypt.hash("password123", 4),
  role: "customer",
});
const login = async ({ user, agent = request.agent(app), origin = trustedOrigin } = {}) => {
  const account = user || await createUser();
  sequence += 1;
  const response = await agent.post("/api/auth/login")
    .set("Origin", origin)
    .set("X-Forwarded-For", `127.0.0.${(sequence % 240) + 1}`)
    .set("User-Agent", `BE03 Browser ${sequence}`)
    .send({ email: account.email, password: "password123" });
  return { user: account, agent, response, cookie: cookieValue(response) };
};
const bearer = (response) => ({ Authorization: `Bearer ${response.body.data.accessToken}` });
const refreshWith = (cookie, headers = {}) => request(app).post("/api/auth/refresh")
  .set("Origin", trustedOrigin).set("Cookie", cookie).set(headers);

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "be03-access-secret-for-isolated-tests";
  process.env.JWT_REFRESH_SECRET = "be03-refresh-secret-for-isolated-tests";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "be03-audit-hmac-secret-for-isolated-tests";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_be03_sessions";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.CORS_ORIGIN = `${trustedOrigin}, ${secondTrustedOrigin}`;
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-mongodb-binaries");
  delete process.env.TEST_MONGO_URI;
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `auth_session_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: AuthSession } = await import("../models/AuthSession.js"));
  ({ default: RefreshToken } = await import("../models/RefreshToken.js"));
  ({ default: SecurityAuditEvent } = await import("../models/SecurityAuditEvent.js"));
  ({ default: User } = await import("../models/User.js"));
  ({ env: runtimeEnv, validateEnvironment } = await import("../config/env.js"));
  tokenService = await import("../services/tokenService.js");
  auditService = await import("../services/securityAuditService.js");
  authController = await import("../controllers/authController.js");
  originService = await import("../config/trustedOrigins.js");
  ({ setAuthSessionTestHooks } = await import("../services/authSessionService.js"));
  await mongoose.syncIndexes();
});

test.beforeEach(async () => {
  setAuthSessionTestHooks({});
  runtimeEnv.nodeEnv = "test";
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
});

test.after(async () => {
  setAuthSessionTestHooks({});
  if (mongoose.connection.readyState) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  await replSet?.stop();
});

test("1. Login creates a server-side session", async () => {
  const result = await login();
  assert.equal(result.response.status, 200);
  assert.equal(await AuthSession.countDocuments({ user: result.user._id }), 1);
  assert.equal(await RefreshToken.countDocuments({ user: result.user._id }), 1);
});

test("2. Raw refresh tokens are never stored", async () => {
  const { cookie } = await login();
  const raw = cookieToken(cookie);
  const record = await RefreshToken.findOne().select("+tokenDigest").lean();
  assert.notEqual(record.tokenDigest, raw);
  assert.equal(JSON.stringify(record).includes(raw), false);
});

test("3. Login sets an HttpOnly refresh cookie", async () => {
  const { response } = await login();
  assert.match(response.headers["set-cookie"][0], /HttpOnly/i);
  assert.equal("refreshToken" in response.body.data, false);
});

test("4. Production cookie is Secure, SameSite=None, and path-scoped", async () => {
  runtimeEnv.nodeEnv = "production";
  const { response } = await login();
  const header = response.headers["set-cookie"][0];
  assert.match(header, /Secure/i); assert.match(header, /SameSite=None/i); assert.match(header, /Path=\/api\/auth/i);
});

test("5. Development cookie uses non-secure SameSite=Lax", async () => {
  runtimeEnv.nodeEnv = "development";
  const { response } = await login();
  const header = response.headers["set-cookie"][0];
  assert.match(header, /SameSite=Lax/i); assert.doesNotMatch(header, /; Secure/i);
});

test("6. Refresh works without Authorization", async () => {
  const { cookie } = await login();
  assert.equal((await refreshWith(cookie)).status, 200);
});

test("7. Expired bearer token does not block refresh", async () => {
  const { cookie } = await login();
  const expired = jwt.sign({ userId: new mongoose.Types.ObjectId(), role: "customer" }, process.env.JWT_SECRET, { expiresIn: -1 });
  assert.equal((await refreshWith(cookie, { Authorization: `Bearer ${expired}` })).status, 200);
});

test("8. Malformed bearer token does not block refresh", async () => {
  const { cookie } = await login();
  assert.equal((await refreshWith(cookie, { Authorization: "Bearer malformed" })).status, 200);
});

test("9. Successful refresh rotates cookie and access token", async () => {
  const { cookie, response } = await login();
  const refreshed = await refreshWith(cookie);
  assert.equal(refreshed.status, 200);
  assert.notEqual(cookieValue(refreshed), cookie);
  assert.notEqual(refreshed.body.data.accessToken, response.body.data.accessToken);
});

test("10. Old generation is marked rotated", async () => {
  const { cookie } = await login();
  await refreshWith(cookie);
  assert.equal((await RefreshToken.findOne({ status: "rotated" })).status, "rotated");
});

test("11. Replaying an old token revokes its family", async () => {
  const { cookie } = await login();
  await refreshWith(cookie);
  const replay = await refreshWith(cookie);
  assertEnvelope(replay); assert.equal(replay.body.errors[0].code, "refresh_token_reuse_detected");
  assert.equal((await AuthSession.findOne()).revokedAt instanceof Date, true);
});

test("12. Successor fails after family reuse detection", async () => {
  const { cookie } = await login();
  const first = await refreshWith(cookie); const successor = cookieValue(first);
  await refreshWith(cookie);
  assertEnvelope(await refreshWith(successor));
});

test("13. Explicitly revoked session cannot refresh", async () => {
  const { cookie, response } = await login();
  const session = await AuthSession.findOne();
  await request(app).delete(`/api/auth/sessions/${session.sessionId}`).set(bearer(response));
  assertEnvelope(await refreshWith(cookie));
});

test("14. Missing refresh cookie is controlled", async () => assertEnvelope(
  await request(app).post("/api/auth/refresh").set("Origin", trustedOrigin),
));

test("15. Invalid-signature refresh token is controlled", async () => {
  const bad = jwt.sign({ type: "refresh", userId: "x", sessionId: "x", familyId: "x", jti: "x" }, "different-secret");
  assertEnvelope(await refreshWith(`refreshToken=${bad}`));
});

test("16. Expired refresh token is controlled", async () => {
  const expired = jwt.sign({ type: "refresh", userId: "x", sessionId: "x", familyId: "x", jti: "x" }, process.env.JWT_REFRESH_SECRET, { expiresIn: -1 });
  const response = await refreshWith(`refreshToken=${expired}`);
  assertEnvelope(response); assert.equal(response.body.errors[0].code, "refresh_token_expired");
});

test("17. Unknown-session token is controlled", async () => {
  const token = tokenService.generateRefreshToken({ userId: new mongoose.Types.ObjectId().toString(), sessionId: crypto.randomUUID(), familyId: crypto.randomUUID(), jti: crypto.randomUUID() });
  assertEnvelope(await refreshWith(`refreshToken=${token}`));
});

test("18. Deleted-user session cannot refresh", async () => {
  const { cookie, user } = await login(); await User.deleteOne({ _id: user._id });
  assertEnvelope(await refreshWith(cookie));
});

test("19. Concurrent refresh creates no two valid successors", async () => {
  const { cookie } = await login();
  const responses = await Promise.all([refreshWith(cookie), refreshWith(cookie)]);
  assert.ok(responses.every(({ status }) => [200, 401].includes(status)), JSON.stringify(responses.map(({ status, body }) => ({ status, body }))));
  assert.ok(responses.filter(({ status }) => status === 200).length <= 1);
  assert.ok(responses.some(({ body }) => body.errors?.[0]?.code === "refresh_token_reuse_detected"));
  assert.ok(await RefreshToken.countDocuments({ status: "active" }) <= 1);
  const winner = responses.find(({ status }) => status === 200);
  if (winner) assertEnvelope(await refreshWith(cookieValue(winner)));
});

test("20. Logout works without Authorization", async () => {
  const { cookie } = await login();
  assert.equal((await request(app).post("/api/auth/logout").set("Origin", trustedOrigin).set("Cookie", cookie)).status, 200);
});

test("21. Logout ignores expired and malformed bearer tokens", async () => {
  const expiredLogin = await login();
  const expired = jwt.sign(
    { userId: expiredLogin.user._id, role: "customer" },
    process.env.JWT_SECRET,
    { expiresIn: -1 },
  );
  const expiredResponse = await request(app).post("/api/auth/logout")
    .set("Origin", trustedOrigin).set("Cookie", expiredLogin.cookie)
    .set("Authorization", `Bearer ${expired}`);
  const malformedLogin = await login();
  const malformedResponse = await request(app).post("/api/auth/logout")
    .set("Origin", trustedOrigin).set("Cookie", malformedLogin.cookie)
    .set("Authorization", "Bearer bad");
  assert.equal(expiredResponse.status, 200);
  assert.equal(malformedResponse.status, 200);
});

test("22. Logout always clears with compatible cookie attributes", async () => {
  runtimeEnv.nodeEnv = "production";
  const response = await request(app).post("/api/auth/logout").set("Origin", trustedOrigin);
  const header = response.headers["set-cookie"][0];
  assert.match(header, /Path=\/api\/auth/i); assert.match(header, /SameSite=None/i); assert.match(header, /Secure/i);
});

test("23. Logout revokes a recognized session server-side", async () => {
  const { cookie } = await login();
  await request(app).post("/api/auth/logout").set("Origin", trustedOrigin).set("Cookie", cookie);
  assert.ok((await AuthSession.findOne()).revokedAt);
});

test("24. Repeated logout is idempotent", async () => {
  const { cookie } = await login();
  const one = await request(app).post("/api/auth/logout").set("Origin", trustedOrigin).set("Cookie", cookie);
  const two = await request(app).post("/api/auth/logout").set("Origin", trustedOrigin).set("Cookie", cookie);
  assert.equal(one.status, 200); assert.equal(two.status, 200);
});

test("25. Session listing is account-scoped and safe", async () => {
  const first = await login(); await login();
  const listed = await request(app).get("/api/auth/sessions").set(bearer(first.response)).set("Cookie", first.cookie);
  assert.equal(listed.body.data.sessions.length, 1);
  const text = JSON.stringify(listed.body); for (const key of ["tokenDigest", "jti", "familyId", "createdIp", "lastUsedIp", "__v"]) assert.equal(text.includes(key), false);
});

test("26. One account can hold multiple sessions", async () => {
  const user = await createUser(); const first = await login({ user }); await login({ user });
  const listed = await request(app).get("/api/auth/sessions").set(bearer(first.response)).set("Cookie", first.cookie);
  assert.equal(listed.body.data.sessions.length, 2);
});

test("27. Revoking one session leaves another valid", async () => {
  const user = await createUser(); const first = await login({ user }); const second = await login({ user });
  const firstSession = await AuthSession.findOne({ currentJti: tokenService.verifyRefreshToken(cookieToken(first.cookie)).jti });
  await request(app).delete(`/api/auth/sessions/${firstSession.sessionId}`).set(bearer(second.response));
  assert.equal((await refreshWith(second.cookie)).status, 200);
});

test("28. User cannot revoke another account session", async () => {
  const first = await login(); const second = await login(); const target = await AuthSession.findOne({ user: second.user._id });
  const response = await request(app).delete(`/api/auth/sessions/${target.sessionId}`).set(bearer(first.response));
  assertEnvelope(response, 404); assert.equal((await AuthSession.findById(target._id)).revokedAt, null);
});

test("29. Revoke-all revokes every account session", async () => {
  const user = await createUser(); const first = await login({ user }); await login({ user });
  const response = await request(app).delete("/api/auth/sessions").set(bearer(first.response)).set("Cookie", first.cookie);
  assert.equal(response.status, 200); assert.equal(await AuthSession.countDocuments({ user: user._id, revokedAt: null }), 0);
});

test("30. Security audit events cover refresh, reuse, logout, and revocation", async () => {
  const one = await login(); const refreshed = await refreshWith(one.cookie); await refreshWith(one.cookie);
  const two = await login(); await request(app).post("/api/auth/logout").set("Origin", trustedOrigin).set("Cookie", two.cookie);
  const three = await login(); const session = await AuthSession.findOne({ user: three.user._id });
  await request(app).delete(`/api/auth/sessions/${session.sessionId}`).set(bearer(three.response));
  const events = await SecurityAuditEvent.distinct("event");
  for (const event of ["refresh_succeeded", "refresh_reuse_detected", "logout", "session_revoked"]) assert.ok(events.includes(event));
  assert.ok(refreshed);
});

test("31. Audit metadata excludes secrets", async () => {
  const { cookie } = await login(); await refreshWith(cookie); const text = JSON.stringify(await SecurityAuditEvent.find().lean());
  assert.equal(text.includes(cookieToken(cookie)), false);
  for (const key of ["authorization", "password", "cookie", "tokenDigest"]) assert.equal(text.toLowerCase().includes(key.toLowerCase()), false);
});

test("32. Trusted Origin is accepted", async () => {
  const { cookie } = await login(); assert.equal((await refreshWith(cookie)).status, 200);
});

test("33. Untrusted Origin is rejected with standard envelope", async () => {
  const { cookie } = await login();
  assertEnvelope(await request(app).post("/api/auth/refresh").set("Origin", "https://evil.example").set("Cookie", cookie), 403);
});

test("34. Failed login persistence returns no usable cookie", async () => {
  const user = await createUser(); setAuthSessionTestHooks({ beforeLoginPersistence: () => { throw new Error("injected"); } });
  const original = console.error; console.error = () => {};
  try {
    const response = await request(app).post("/api/auth/login").set("Origin", trustedOrigin).send({ email: user.email, password: "password123" });
    assert.equal(response.status, 503); assert.equal(cookieValue(response), undefined); assert.equal(await AuthSession.countDocuments(), 0);
  } finally { console.error = original; }
});

test("35. Failed rotation rolls back and returns no cookie", async () => {
  const { cookie } = await login(); setAuthSessionTestHooks({ beforeSuccessorPersistence: () => { throw new Error("injected"); } });
  const original = console.error; console.error = () => {};
  try {
    const response = await refreshWith(cookie); assert.equal(response.status, 503); assert.equal(cookieValue(response), undefined);
    assert.equal(await RefreshToken.countDocuments({ status: "active" }), 1);
  } finally { console.error = original; }
});

test("36. Session indexes include lookup, uniqueness, and TTL policies", async () => {
  const sessionIndexes = await AuthSession.collection.indexes(); const tokenIndexes = await RefreshToken.collection.indexes();
  assert.ok(sessionIndexes.some((index) => index.key.expiresAt === 1 && index.expireAfterSeconds === 0));
  assert.ok(sessionIndexes.some((index) => index.key.sessionId === 1 && index.unique));
  assert.ok(tokenIndexes.some((index) => index.key.jti === 1 && index.unique));
  assert.ok(tokenIndexes.some((index) => index.key.expiresAt === 1 && index.expireAfterSeconds === 0));
});

const validEnvironment = () => ({
  PORT: "5000",
  MONGO_URI: "mongodb://127.0.0.1:27017/validation-only",
  JWT_SECRET: "a".repeat(32),
  JWT_REFRESH_SECRET: "b".repeat(32),
  SECURITY_AUDIT_HMAC_SECRET: "c".repeat(32),
  PAYSTACK_MODE: "test",
  PAYSTACK_SECRET_KEY: "sk_test_documentation_placeholder",
  PAYSTACK_CALLBACK_URL: "https://example.test/payment/callback",
  NODE_ENV: "test",
});

test("37. Environment rejects a short access secret", () => {
  assert.equal(validateEnvironment({ ...validEnvironment(), JWT_SECRET: "short" }).success, false);
});

test("38. Environment rejects a short refresh secret", () => {
  assert.equal(validateEnvironment({ ...validEnvironment(), JWT_REFRESH_SECRET: "short" }).success, false);
});

test("39. Environment rejects identical access and refresh secrets", () => {
  const values = validEnvironment();
  values.JWT_REFRESH_SECRET = values.JWT_SECRET;
  assert.equal(validateEnvironment(values).success, false);
});

test("40. Environment accepts three distinct 32+ character security secrets", () => {
  assert.equal(validateEnvironment(validEnvironment()).success, true);
});

test("41. Environment rejects a short or JWT-reused audit HMAC secret", () => {
  const values = validEnvironment();
  assert.equal(validateEnvironment({ ...values, SECURITY_AUDIT_HMAC_SECRET: "short" }).success, false);
  assert.equal(validateEnvironment({
    ...values,
    SECURITY_AUDIT_HMAC_SECRET: values.JWT_SECRET,
  }).success, false);
});

test("42. Access tokens contain the access type and explicitly use HS256", () => {
  const token = tokenService.generateAccessToken({
    _id: new mongoose.Types.ObjectId(),
    role: "customer",
  });
  assert.equal(jwt.decode(token).type, "access");
  assert.equal(jwt.decode(token, { complete: true }).header.alg, "HS256");
  assert.equal(tokenService.verifyAccessToken(token).type, "access");
});

test("43. Refresh tokens cannot authenticate as access tokens", () => {
  const token = tokenService.generateRefreshToken({
    userId: new mongoose.Types.ObjectId().toString(),
    sessionId: randomUUID(),
    familyId: randomUUID(),
    jti: randomUUID(),
  });
  assert.throws(() => tokenService.verifyAccessToken(token));

  const refreshTypedWithAccessKey = jwt.sign(
    { type: "refresh", userId: "x" },
    process.env.JWT_SECRET,
    { algorithm: "HS256" },
  );
  assert.throws(() => tokenService.verifyAccessToken(refreshTypedWithAccessKey));
});

test("44. Access tokens cannot authenticate as refresh tokens", () => {
  const token = tokenService.generateAccessToken({
    _id: new mongoose.Types.ObjectId(),
    role: "customer",
  });
  assert.throws(() => tokenService.verifyRefreshToken(token));

  const accessTypedWithRefreshKey = jwt.sign(
    { type: "access", userId: "x" },
    process.env.JWT_REFRESH_SECRET,
    { algorithm: "HS256" },
  );
  assert.throws(() => tokenService.verifyRefreshToken(accessTypedWithRefreshKey));
});

test("45. Tokens missing the access type are rejected", () => {
  const legacy = jwt.sign(
    { userId: new mongoose.Types.ObjectId().toString(), role: "customer" },
    process.env.JWT_SECRET,
    { algorithm: "HS256", expiresIn: "15m" },
  );
  assert.throws(() => tokenService.verifyAccessToken(legacy));
});

test("46. HS384 access and refresh tokens are rejected", () => {
  const access = jwt.sign(
    { type: "access", userId: "x", role: "customer" },
    process.env.JWT_SECRET,
    { algorithm: "HS384" },
  );
  const refresh = jwt.sign(
    { type: "refresh", userId: "x", sessionId: "x", familyId: "x", jti: "x" },
    process.env.JWT_REFRESH_SECRET,
    { algorithm: "HS384" },
  );
  assert.throws(() => tokenService.verifyAccessToken(access));
  assert.throws(() => tokenService.verifyRefreshToken(refresh));
  assert.throws(() => tokenService.verifyRefreshTokenIgnoringExpiry(refresh));
});

test("47. Valid HS256 access and refresh verification remains supported", () => {
  const access = tokenService.generateAccessToken({
    _id: new mongoose.Types.ObjectId(),
    role: "customer",
  });
  const refresh = tokenService.generateRefreshToken({
    userId: new mongoose.Types.ObjectId().toString(),
    sessionId: randomUUID(),
    familyId: randomUUID(),
    jti: randomUUID(),
  });
  assert.equal(tokenService.verifyAccessToken(access).type, "access");
  assert.equal(tokenService.verifyRefreshToken(refresh).type, "refresh");
  assert.equal(tokenService.verifyRefreshTokenIgnoringExpiry(refresh).type, "refresh");
});

test("48. Audit IP pseudonyms are keyed, deterministic, and not plain SHA-256", () => {
  const ip = "203.0.113.42";
  const firstKey = "first-audit-test-key-that-is-at-least-32-characters";
  const secondKey = "second-audit-test-key-that-is-at-least-32-characters";
  const first = auditService.digestAuditIp(ip, firstKey);
  assert.equal(first, auditService.digestAuditIp(ip, firstKey));
  assert.notEqual(first, auditService.digestAuditIp(ip, secondKey));
  assert.notEqual(first, createHash("sha256").update(ip).digest("hex"));
});

test("49. Audit and session documents contain IP pseudonyms but never the raw IP", async () => {
  const ip = "203.0.113.77";
  const user = await createUser();
  const response = await request(app).post("/api/auth/login")
    .set("Origin", trustedOrigin)
    .set("X-Forwarded-For", ip)
    .send({ email: user.email, password: "password123" });
  assert.equal(response.status, 200);

  const audit = await SecurityAuditEvent.findOne({ event: "login_succeeded" }).lean();
  const session = await AuthSession.findOne()
    .select("+createdIpDigest +lastUsedIpDigest")
    .lean();
  assert.equal(audit.ipDigest, auditService.digestAuditIp(ip));
  assert.equal(session.createdIpDigest, audit.ipDigest);
  assert.equal(session.lastUsedIpDigest, audit.ipDigest);
  assert.equal(JSON.stringify([audit, session]).includes(ip), false);
  assert.equal(Object.hasOwn(session, "createdIp"), false);
  assert.equal(Object.hasOwn(session, "lastUsedIp"), false);
});

test("50. Audit metadata rejects nested, array, case-varied, unexpected, and complex values", () => {
  const sanitize = auditService.sanitizeSecurityAuditMetadata;
  assert.throws(() => sanitize("login_failed", { reason: { token: "secret" } }));
  assert.throws(() => sanitize("login_failed", { reason: ["secret"] }));
  assert.throws(() => sanitize("login_failed", { Authorization: "secret" }));
  assert.throws(() => sanitize("login_failed", { Reason: "invalid_credentials" }));
  assert.throws(() => sanitize("login_failed", { note: "invalid_credentials" }));
  assert.throws(() => sanitize("login_failed", { reason: "x".repeat(201) }));
  assert.throws(() => sanitize("login_failed", { reason: () => "invalid_credentials" }));
  assert.throws(() => sanitize("login_failed", { reason: Symbol("invalid_credentials") }));
  assert.throws(() => sanitize("LOGIN_FAILED", { reason: "invalid_credentials" }));
  assert.throws(() => sanitize("login_failed", { reason: "header.payload.signature" }));
});

test("51. Audit metadata retains only valid per-event reasons and counts", () => {
  assert.deepEqual(
    auditService.sanitizeSecurityAuditMetadata("login_failed", { reason: "invalid_credentials" }),
    { reason: "invalid_credentials" },
  );
  assert.deepEqual(
    auditService.sanitizeSecurityAuditMetadata("refresh_failed", { reason: "expired" }),
    { reason: "expired" },
  );
  assert.deepEqual(
    auditService.sanitizeSecurityAuditMetadata("all_sessions_revoked", { count: 2 }),
    { count: 2 },
  );
  assert.throws(() => auditService.sanitizeSecurityAuditMetadata(
    "all_sessions_revoked",
    { count: 1.5 },
  ));
});

test("52. Dummy login hash is valid and uses the registration cost factor", () => {
  assert.equal(bcrypt.getRounds(authController.DUMMY_PASSWORD_HASH), 12);
  assert.equal(bcrypt.getRounds(authController.DUMMY_PASSWORD_HASH), authController.PASSWORD_HASH_COST);
});

test("53. Unknown-email and wrong-password login failures are publicly indistinguishable", async () => {
  const user = await createUser();
  const wrongPassword = await request(app).post("/api/auth/login")
    .set("Origin", trustedOrigin)
    .set("X-Forwarded-For", "203.0.113.91")
    .send({ email: user.email, password: "incorrect-password" });
  const unknownEmail = await request(app).post("/api/auth/login")
    .set("Origin", trustedOrigin)
    .set("X-Forwarded-For", "203.0.113.92")
    .send({ email: "unknown@example.test", password: "incorrect-password" });

  assert.equal(wrongPassword.status, 401);
  assert.equal(unknownEmail.status, wrongPassword.status);
  assert.deepEqual(unknownEmail.body, wrongPassword.body);
  assert.equal(cookieValue(wrongPassword), undefined);
  assert.equal(cookieValue(unknownEmail), undefined);
  assert.equal(await AuthSession.countDocuments(), 0);
  assert.equal(await RefreshToken.countDocuments(), 0);

  const events = await SecurityAuditEvent.find({ event: "login_failed" }).lean();
  assert.equal(events.length, 2);
  assert.ok(events.every(({ metadata }) => (
    Object.keys(metadata).length === 1 && metadata.reason === "invalid_credentials"
  )));
});

test("54. Spaced trusted-origin configuration passes CORS and CSRF for both origins", async () => {
  for (const origin of [trustedOrigin, secondTrustedOrigin]) {
    const result = await login({ origin });
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers["access-control-allow-origin"], origin);
    assert.equal(result.response.headers["access-control-allow-credentials"], "true");
    assert.notEqual(result.response.headers["access-control-allow-origin"], "*");

    const refreshed = await request(app).post("/api/auth/refresh")
      .set("Origin", origin)
      .set("Cookie", result.cookie);
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.headers["access-control-allow-origin"], origin);
  }
});

test("55. Trusted-origin parsing normalizes trailing slashes and rejects unsafe configuration", () => {
  assert.deepEqual(
    [...originService.parseTrustedOrigins("https://a.example/, https://b.example")],
    [trustedOrigin, secondTrustedOrigin],
  );
  for (const configured of [
    "*",
    "https://user:pass@a.example",
    "https://a.example/path",
    "https://a.example?query=1",
    "https://a.example#fragment",
    "ftp://a.example",
  ]) {
    assert.throws(() => originService.parseTrustedOrigins(configured));
  }
});

test("56. Null, malformed, and malicious-suffix origins are rejected", async () => {
  for (const origin of ["null", "not a url", "https://a.example.evil.test"]) {
    const response = await request(app).post("/api/auth/logout").set("Origin", origin);
    assertEnvelope(response, 403);
  }
});

test("57. Valid Referer origins pass while malformed Referer values fail", async () => {
  const accepted = await request(app).post("/api/auth/logout")
    .set("Referer", `${secondTrustedOrigin}/account/sessions?from=settings`);
  assert.equal(accepted.status, 200);
  assertEnvelope(
    await request(app).post("/api/auth/logout").set("Referer", "not a url"),
    403,
  );
});

test("58. Cookie-auth routes preserve non-browser clients without Origin or Referer", async () => {
  assert.equal((await request(app).post("/api/auth/logout")).status, 200);
});

test("59. Logout with a malformed refresh cookie is idempotent and controlled", async () => {
  const response = await request(app).post("/api/auth/logout")
    .set("Origin", trustedOrigin)
    .set("Cookie", "refreshToken=malformed");
  assert.equal(response.status, 200);
  assert.equal(response.body.success, true);
  assert.match(response.headers["set-cookie"][0], /^refreshToken=;/);
});

test("60. Logout recognizes an expired signed refresh cookie and revokes its session", async () => {
  const { cookie } = await login();
  const originalClaims = tokenService.verifyRefreshToken(cookieToken(cookie));
  const expired = jwt.sign({
    type: "refresh",
    userId: originalClaims.userId,
    sessionId: originalClaims.sessionId,
    familyId: originalClaims.familyId,
    jti: originalClaims.jti,
  }, process.env.JWT_REFRESH_SECRET, { algorithm: "HS256", expiresIn: -1 });
  await RefreshToken.collection.updateOne(
    { jti: originalClaims.jti },
    { $set: { tokenDigest: tokenService.digestRefreshToken(expired) } },
  );

  const response = await request(app).post("/api/auth/logout")
    .set("Origin", trustedOrigin)
    .set("Cookie", `refreshToken=${expired}`);
  assert.equal(response.status, 200);
  assert.ok((await AuthSession.findOne()).revokedAt);
  assert.match(response.headers["set-cookie"][0], /^refreshToken=;/);
});

test("61. Logout with an already-revoked refresh cookie remains idempotent", async () => {
  const { cookie } = await login();
  const first = await request(app).post("/api/auth/logout")
    .set("Origin", trustedOrigin).set("Cookie", cookie);
  const second = await request(app).post("/api/auth/logout")
    .set("Origin", trustedOrigin).set("Cookie", cookie);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.match(second.headers["set-cookie"][0], /^refreshToken=;/);
});

test("62. Identifiable refresh record with a stored digest mismatch is detected", async () => {
  const { cookie } = await login();
  const claims = tokenService.verifyRefreshToken(cookieToken(cookie));
  await RefreshToken.collection.updateOne(
    { jti: claims.jti },
    { $set: { tokenDigest: "0".repeat(64) } },
  );
  const response = await refreshWith(cookie);
  assertEnvelope(response);
  assert.equal(response.body.errors[0].code, "refresh_token_reuse_detected");
});

test("63. Digest mismatch revokes the family and returns the controlled reuse response", async () => {
  const { cookie } = await login();
  const claims = tokenService.verifyRefreshToken(cookieToken(cookie));
  await RefreshToken.collection.updateOne(
    { jti: claims.jti },
    { $set: { tokenDigest: "f".repeat(64) } },
  );
  const response = await refreshWith(cookie);
  assertEnvelope(response);
  assert.equal(response.body.message, "Session is no longer valid");
  assert.equal(response.body.errors[0].code, "refresh_token_reuse_detected");
  assert.ok((await AuthSession.findOne()).revokedAt);
  assert.equal(await RefreshToken.countDocuments({ status: "active" }), 0);
});

test("64. Active successor is unusable after digest-mismatch reuse detection", async () => {
  const { cookie } = await login();
  const rotated = await refreshWith(cookie);
  const successor = cookieValue(rotated);
  const oldClaims = tokenService.verifyRefreshToken(cookieToken(cookie));
  const forgedIdentifiableToken = jwt.sign({
    type: "refresh",
    userId: oldClaims.userId,
    sessionId: oldClaims.sessionId,
    familyId: oldClaims.familyId,
    jti: oldClaims.jti,
  }, process.env.JWT_REFRESH_SECRET, { algorithm: "HS256", expiresIn: "30d" });

  const detection = await refreshWith(`refreshToken=${forgedIdentifiableToken}`);
  assertEnvelope(detection);
  assert.equal(detection.body.errors[0].code, "refresh_token_reuse_detected");
  const successorResponse = await refreshWith(successor);
  assertEnvelope(successorResponse);
  assert.equal(successorResponse.body.errors[0].code, "refresh_token_reuse_detected");
});

test("65. Negative session responses expose no raw token, digest, JWT, or database detail", async () => {
  const { cookie } = await login();
  const token = cookieToken(cookie);
  const claims = tokenService.verifyRefreshToken(token);
  const record = await RefreshToken.findOne({ jti: claims.jti }).select("+tokenDigest").lean();
  await RefreshToken.collection.updateOne(
    { jti: claims.jti },
    { $set: { tokenDigest: "a".repeat(64) } },
  );
  const response = await refreshWith(cookie);
  assertEnvelope(response);
  const publicText = JSON.stringify(response.body);
  for (const forbidden of [
    token,
    record.tokenDigest,
    "tokenDigest",
    "JsonWebTokenError",
    "TokenExpiredError",
    "MongoServerError",
    "collection",
    "database",
  ]) {
    assert.equal(publicText.includes(forbidden), false);
  }
});
