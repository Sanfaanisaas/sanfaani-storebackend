import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

const ACCESS_SECRET = "be23-access-secret-32-characters-long";
const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
let app;
let User;
let Notification;
let NotificationDelivery;
let PushDevice;
let createCustomerNotification;
let processPendingDeliveries;
let setNotificationProviders;
let setNotificationDeliveryTestHooks;
let replicaSet;
let sequence = 0;

const unique = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;
const createUser = (role = "customer") => User.create({ name: "Notification Customer", email: `${unique("notify")}@example.test`, passwordHash: "$2b$12$STwmCXXAcG1juP88YSrvc.xvHyHZ6Kd.MLSEIDJg.cpO16B1PEc0K", role, status: "ACTIVE" });
const tokenFor = (user) => jwt.sign({ userId: user._id.toString(), role: user.role, authVersion: user.authVersion || 0, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" });
const auth = (user) => ({ Authorization: `Bearer ${tokenFor(user)}` });
const call = (method, path) => request(app)[method](path).set("X-Forwarded-For", new mongoose.Types.ObjectId().toString());
const notificationInput = (recipient, overrides = {}) => ({ recipient: recipient._id, type: "repair_status_changed", title: "Repair update", safePreview: "Your repair status changed.", resourceType: "repair", resourceId: new mongoose.Types.ObjectId(), mandatory: false, eventKey: unique("event"), ...overrides });
const registerDevice = (user, overrides = {}) => call("post", "/api/push-devices").set(auth(user)).set("Idempotency-Key", unique("device-key")).send({ deviceId: unique("install"), pushToken: unique("push-token"), platform: "android", label: "Customer phone", ...overrides });

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "be23-refresh-secret-32-characters-long";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "be23-audit-secret-32-characters-long";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "be23-tracking-secret-32-characters-long";
  process.env.GUIDANCE_TOKEN_SECRET = "be23-guidance-secret-32-characters-long";
  process.env.PUSH_TOKEN_ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_be23_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be23-mongo");
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `be23_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: User } = await import("../models/User.js"));
  ({ default: Notification } = await import("../models/Notification.js"));
  ({ default: NotificationDelivery } = await import("../models/NotificationDelivery.js"));
  ({ default: PushDevice } = await import("../models/PushDevice.js"));
  ({ createCustomerNotification } = await import("../services/notificationService.js"));
  ({ processPendingDeliveries, setNotificationDeliveryTestHooks, setNotificationProviders } = await import("../services/notificationDeliveryService.js"));
  await mongoose.syncIndexes();
});

test.beforeEach(async () => {
  setNotificationProviders({
    email: { send: async () => ({ messageId: unique("email-provider-id") }) },
    push: { send: async () => ({ messageId: unique("push-provider-id"), invalidTokens: [] }) },
  });
  setNotificationDeliveryTestHooks({});
  for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({});
});

test.after(async () => {
  setNotificationDeliveryTestHooks({});
  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test("1. channel preferences report persisted consent and transactional/security categories cannot be disabled", async () => {
  const user = await createUser();
  const updated = await call("patch", "/api/notification-preferences").set(auth(user)).send({ channels: { email: true, push: true }, optionalCategories: { repair_updates: false } });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.deepEqual(updated.body.data.channels, { inApp: true, email: true, sms: false, push: true });
  assert.equal(updated.body.data.optionalCategories.repair_updates, false);
  const mandatory = await call("patch", "/api/notification-preferences").set(auth(user)).send({ mandatoryCategories: { security: false } });
  assert.equal(mandatory.status, 422);
});

test("2. an optional category with withdrawn consent creates no inbox item or external delivery", async () => {
  const user = await createUser();
  await call("patch", "/api/notification-preferences").set(auth(user)).send({ channels: { email: true, push: true }, optionalCategories: { repair_updates: false } });
  const result = await createCustomerNotification(notificationInput(user));
  assert.equal(result.suppressed, true);
  assert.equal(await Notification.countDocuments({ recipient: user._id }), 0);
  assert.equal(await NotificationDelivery.countDocuments({ recipient: user._id }), 0);
});

test("3. mandatory notices override opt-outs and enqueue idempotent email and push work transactionally", async () => {
  const user = await createUser();
  await registerDevice(user);
  const input = notificationInput(user, { mandatory: true, type: "security_session_revoked" });
  const first = await createCustomerNotification(input);
  const replay = await createCustomerNotification(input);
  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(await Notification.countDocuments({ recipient: user._id }), 1);
  const channels = (await NotificationDelivery.find({ notification: first.notification._id }).sort({ channel: 1 })).map((item) => item.channel);
  assert.deepEqual(channels, ["email", "push"]);
});

test("4. push registration encrypts tokens, is payload-idempotent, and exposes only a safe owner DTO", async () => {
  const user = await createUser();
  const deviceId = unique("installation");
  const pushToken = unique("secret-push-token");
  const idempotencyKey = unique("register-device");
  const payload = { deviceId, pushToken, platform: "ios", label: "Personal iPhone" };
  const first = await call("post", "/api/push-devices").set(auth(user)).set("Idempotency-Key", idempotencyKey).send(payload);
  const replay = await call("post", "/api/push-devices").set(auth(user)).set("Idempotency-Key", idempotencyKey).send(payload);
  const drift = await call("post", "/api/push-devices").set(auth(user)).set("Idempotency-Key", idempotencyKey).send({ ...payload, pushToken: unique("changed-token") });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(replay.status, 200);
  assert.equal(first.body.data.id, replay.body.data.id);
  assert.equal(drift.status, 409);
  assert.deepEqual(Object.keys(first.body.data).sort(), ["active", "createdAt", "id", "label", "lastSeenAt", "platform", "updatedAt"].sort());
  const stored = await PushDevice.findById(first.body.data.id).select("+deviceIdDigest +tokenDigest +tokenCiphertext +tokenIv +tokenTag +idempotencyFingerprint").lean();
  assert.equal(JSON.stringify(stored).includes(pushToken), false);
  assert.equal(stored.tokenCiphertext.length > 0, true);
  assert.equal(await PushDevice.collection.countDocuments({ $or: [{ pushToken }, { deviceId }] }), 0);
});

test("5. push devices are owner-scoped, revocable, and foreign or malformed IDs are non-enumerating", async () => {
  const owner = await createUser();
  const other = await createUser();
  const created = await registerDevice(owner);
  const foreign = await call("delete", `/api/push-devices/${created.body.data.id}`).set(auth(other));
  const random = await call("delete", `/api/push-devices/${new mongoose.Types.ObjectId()}`).set(auth(other));
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, random.body);
  assert.equal((await call("delete", "/api/push-devices/not-an-id").set(auth(owner))).status, 422);
  const revoked = await call("delete", `/api/push-devices/${created.body.data.id}`).set(auth(owner));
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.data.active, false);
});

test("6. generated deep links are allowlisted paths with no query strings, fragments, or secrets", async () => {
  const user = await createUser();
  const resourceId = new mongoose.Types.ObjectId();
  const result = await createCustomerNotification(notificationInput(user, { resourceType: "support_ticket", resourceId }));
  assert.equal(result.notification.deepLink, `/support/${resourceId}`);
  assert.equal(/[?#]/.test(result.notification.deepLink), false);
  assert.equal(/token|secret|password/i.test(result.notification.deepLink), false);
});

test("7. the worker delivers through injected providers once and provider replay remains idempotent", async () => {
  const user = await createUser();
  await registerDevice(user);
  const calls = [];
  setNotificationProviders({
    email: { send: async (message) => { calls.push(["email", message]); return { messageId: "email-message-1" }; } },
    push: { send: async (message) => { calls.push(["push", message]); return { messageId: "push-message-1", invalidTokens: [] }; } },
  });
  await createCustomerNotification(notificationInput(user, { mandatory: true }));
  const first = await processPendingDeliveries({ limit: 10 });
  const replay = await processPendingDeliveries({ limit: 10 });
  assert.deepEqual(first, { claimed: 2, delivered: 2, retried: 0, deadLettered: 0, suppressed: 0 });
  assert.deepEqual(replay, { claimed: 0, delivered: 0, retried: 0, deadLettered: 0, suppressed: 0 });
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([, message]) => typeof message.idempotencyKey === "string" && !JSON.stringify(message).includes(ENCRYPTION_KEY)));
  assert.equal(await NotificationDelivery.countDocuments({ status: "DELIVERED" }), 2);
});

test("8. transient provider failures retry with a bounded schedule and then dead-letter safely", async () => {
  const user = await createUser();
  setNotificationProviders({ email: { send: async () => { throw Object.assign(new Error("raw provider outage secret"), { retryable: true }); } } });
  const created = await createCustomerNotification(notificationInput(user, { mandatory: true }));
  await NotificationDelivery.deleteMany({ notification: created.notification._id, channel: "push" });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await NotificationDelivery.updateMany({ status: "RETRY_SCHEDULED" }, { $set: { nextAttemptAt: new Date(0) } });
    await processPendingDeliveries({ limit: 1 });
  }
  const delivery = await NotificationDelivery.findOne({ notification: created.notification._id });
  assert.equal(delivery.status, "DEAD_LETTER");
  assert.equal(delivery.attempts, 5);
  assert.equal(JSON.stringify(delivery).includes("raw provider outage secret"), false);
  assert.equal(delivery.lastErrorCategory, "provider_unavailable");
});

test("9. provider invalid-token results revoke matching devices without persisting raw tokens", async () => {
  const user = await createUser();
  const pushToken = unique("invalid-token");
  await registerDevice(user, { pushToken });
  await call("patch", "/api/notification-preferences").set(auth(user)).send({ channels: { push: true } });
  setNotificationProviders({ push: { send: async () => ({ messageId: "push-invalid", invalidTokens: [pushToken] }) } });
  const created = await createCustomerNotification(notificationInput(user));
  await processPendingDeliveries({ limit: 10 });
  const device = await PushDevice.findOne({ owner: user._id });
  assert.equal(device.active, false);
  assert.ok(device.invalidatedAt);
  assert.equal(JSON.stringify(await NotificationDelivery.findOne({ notification: created.notification._id })).includes(pushToken), false);
});

test("10. logout revokes the explicitly identified owner push installation", async () => {
  const user = await createUser();
  const deviceId = unique("logout-device");
  await registerDevice(user, { deviceId });
  const response = await call("post", "/api/auth/logout").set(auth(user)).set("X-Push-Device-Id", deviceId);
  assert.equal(response.status, 200);
  assert.equal((await PushDevice.findOne({ owner: user._id })).active, false);
});

test("11. a required outbox write failure rolls back notification creation", async () => {
  const user = await createUser();
  setNotificationDeliveryTestHooks({ beforeEnqueue: () => { throw new Error("forced outbox failure"); } });
  await assert.rejects(() => createCustomerNotification(notificationInput(user, { mandatory: true })), /forced outbox failure/);
  assert.equal(await Notification.countDocuments({ recipient: user._id }), 0);
  assert.equal(await NotificationDelivery.countDocuments({ recipient: user._id }), 0);
});
