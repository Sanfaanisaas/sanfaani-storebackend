import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app;
let SupportTicket;
let Order;
let Notification;
let NotificationPreference;
let replicaSet;
let sequence = 0;

const ACCESS_SECRET = "support-notif-access-secret-32-chars";
const id = () => new mongoose.Types.ObjectId();
const next = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;

const auth = (userId, role = "customer") => ({
  Authorization: `Bearer ${jwt.sign({ userId: userId.toString(), role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}`,
});

const req = (method, url) =>
  request(app)[method](url).set("X-Forwarded-For", id().toString());

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "support-notif-refresh-secret-32-chars";
  process.env.SECURITY_AUDIT_HMAC_SECRET =
    "support-notif-audit-secret-32-chars";
  process.env.REPAIR_TRACKING_TOKEN_SECRET =
    "support-notif-tracking-secret-32-chars";
  process.env.GUIDANCE_TOKEN_SECRET = "support-notif-guidance-secret-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_support_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be11-mongo");

  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: `support_test_${process.pid}_${Date.now()}`,
  });

  ({ default: app } = await import("../app.js"));
  ({ default: SupportTicket } = await import("../models/SupportTicket.js"));
  ({ default: Order } = await import("../models/Order.js"));
  ({ default: Notification } = await import("../models/Notification.js"));
  ({ default: NotificationPreference } =
    await import("../models/NotificationPreference.js"));

  await mongoose.syncIndexes();
});

test.beforeEach(async () => {
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }
});

test.after(async () => {
  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

test("1. Ticket creation validates inputs, enforces polymorphic links, and guarantees idempotency", async () => {
  const customerId = id();
  const hackerId = id();

  const order = await Order.create({
    userId: customerId,
    status: "delivered",
    items: [
      {
        productId: id(),
        variantSku: "SKU-A",
        nameSnapshot: "Product",
        quantity: 1,
        priceSnapshot: 1000,
      },
    ],
    subtotal: 1000,
    total: 1000,
    paymentMethod: "paystack",
    shippingAddress: {
      street: "1 Main",
      city: "Lagos",
      state: "LA",
      country: "NG",
    },
  });

  const payload = {
    subject: "Where is my order?",
    message: "I cannot find the tracking link.",
    category: "order",
    linkedResource: { type: "order", id: order._id.toString() },
  };

  const idempotencyKey = next("ticket");

  // Invalid Input -> Zod throws 422 (or 400 depending on middleware)
  const invalidInputRes = await req("post", "/api/support-tickets")
    .set(auth(customerId))
    .set("Idempotency-Key", next("invalid"))
    .send({ subject: "ab", message: "short" });
  assert.equal(
    [400, 422].includes(invalidInputRes.status),
    true,
    `Expected validation error, got ${invalidInputRes.status}`,
  );

  // Hacker tries to link customerId's order -> 404 Not Found (Prevent Enumeration/Data Leakage)
  const foreignLink = await req("post", "/api/support-tickets")
    .set(auth(hackerId))
    .set("Idempotency-Key", next("hack"))
    .send(payload);
  assert.equal(foreignLink.status, 404);
  assert.equal(foreignLink.body.errors[0].code, "support_resource_unavailable");

  // Valid Customer Creation -> 201
  const validRes = await req("post", "/api/support-tickets")
    .set(auth(customerId))
    .set("Idempotency-Key", idempotencyKey)
    .send(payload);
  assert.equal(validRes.status, 201);
  assert.equal(validRes.body.data.linkedResource.id, order._id.toString());

  // Idempotent Replay -> 200/201
  const replay = await req("post", "/api/support-tickets")
    .set(auth(customerId))
    .set("Idempotency-Key", idempotencyKey)
    .send(payload);
  assert.equal([200, 201].includes(replay.status), true);
  assert.equal(replay.body.data.id, validRes.body.data.id);

  // Fingerprint Conflict -> 409
  const conflict = await req("post", "/api/support-tickets")
    .set(auth(customerId))
    .set("Idempotency-Key", idempotencyKey)
    .send({ ...payload, message: "A different message entirely." });
  assert.equal(conflict.status, 409);
});

test("2. Concurrent ticket creations correctly catch Duplicate Keys and resolve safely", async () => {
  const customerId = id();
  const idempotencyKey = next("concurrent");

  const payload = {
    subject: "Race condition test",
    message: "Concurrent ticket creation",
  };

  // Two clicks at the exact same millisecond
  const [res1, res2] = await Promise.all([
    req("post", "/api/support-tickets")
      .set(auth(customerId))
      .set("Idempotency-Key", idempotencyKey)
      .send(payload),
    req("post", "/api/support-tickets")
      .set(auth(customerId))
      .set("Idempotency-Key", idempotencyKey)
      .send(payload),
  ]);

  // Because the backend explicitly catches 11000 and finds the existing ticket to return it, BOTH should return the exact same ticket data successfully.
  assert.equal([200, 201].includes(res1.status), true);
  assert.equal([200, 201].includes(res2.status), true);
  assert.equal(res1.body.data.id, res2.body.data.id);

  const dbCount = await SupportTicket.countDocuments({ customer: customerId });
  assert.equal(dbCount, 1);
});

test("3. Replies enforce message-level idempotency and customer/staff role gates", async () => {
  const customerId = id();
  const staffId = id();

  const ticket = await SupportTicket.create({
    customer: customerId,
    subject: "Help",
    status: "open",
    category: "general",
    idempotencyKey: next("tkt"),
    idempotencyFingerprint: "a".repeat(64),
    messages: [
      {
        author: customerId,
        authorType: "customer",
        body: "Initial msg",
        idempotencyKey: next("init"),
      },
    ],
  });

  const replyKey = next("reply");

  // Customer reply sets status to in_progress
  const firstReply = await req(
    "post",
    `/api/support-tickets/${ticket._id}/reply`,
  )
    .set(auth(customerId))
    .set("Idempotency-Key", replyKey)
    .send({ body: "Please hurry!" });
  assert.equal(firstReply.status, 201);
  assert.equal(firstReply.body.data.status, "in_progress");

  // Exactly repeating the key adds 0 extra messages (Idempotency)
  const replayReply = await req(
    "post",
    `/api/support-tickets/${ticket._id}/reply`,
  )
    .set(auth(customerId))
    .set("Idempotency-Key", replyKey)
    .send({ body: "Please hurry!" });
  assert.equal([200, 201].includes(replayReply.status), true);

  const dbTicket = await SupportTicket.findById(ticket._id);
  assert.equal(dbTicket.messages.length, 2); // 1 initial + 1 valid reply

  // Close the ticket
  await SupportTicket.updateOne(
    { _id: ticket._id },
    { $set: { status: "closed" } },
  );

  // Customer cannot reply to closed ticket -> 409
  const closedReply = await req(
    "post",
    `/api/support-tickets/${ticket._id}/reply`,
  )
    .set(auth(customerId))
    .set("Idempotency-Key", next("fail"))
    .send({ body: "Wait, I have another question!" });
  assert.equal(closedReply.status, 409);
  assert.equal(closedReply.body.errors[0].code, "support_reply_unavailable");

  // Staff CANNOT reply to closed ticket -> 409
  const staffClosedReply = await req(
    "post",
    `/api/support-tickets/${ticket._id}/reply`,
  )
    .set(auth(staffId, "support_officer"))
    .set("Idempotency-Key", next("fail2"))
    .send({ body: "Closing remark." });
  assert.equal(staffClosedReply.status, 409);
});

test("4. Optimistic Concurrency Control (OCC) and strict FSM for staff ticket transitions", async () => {
  const customerId = id();

  const ticket = await SupportTicket.create({
    customer: customerId,
    subject: "Need help",
    status: "open",
    category: "general",
    idempotencyKey: next("tkt2"),
    idempotencyFingerprint: "b".repeat(64),
  });

  const staffAuth = auth(id(), "support_officer");

  // Invalid jump: closed -> in_progress (closed transitions are empty: [])
  await SupportTicket.updateOne(
    { _id: ticket._id },
    { $set: { status: "closed" } },
  );

  const badJump = await req(
    "patch",
    `/api/support-tickets/${ticket._id}/status`,
  )
    .set(staffAuth)
    .send({ status: "in_progress" });
  assert.equal(badJump.status, 409);
  assert.equal(
    badJump.body.errors[0].code,
    "support_ticket_transition_invalid",
  );

  // Restore to open
  await SupportTicket.updateOne(
    { _id: ticket._id },
    { $set: { status: "open" } },
  );

  // Concurrent Staff Status Updates (OCC Test)
  const [res1, res2] = await Promise.all([
    req("patch", `/api/support-tickets/${ticket._id}/status`)
      .set(staffAuth)
      .send({ status: "in_progress" }),
    req("patch", `/api/support-tickets/${ticket._id}/status`)
      .set(staffAuth)
      .send({ status: "resolved", resolutionSummary: "Fixed it" }),
  ]);

  // One MUST win (200), one MUST hit the OCC lock (409)
  const statuses = [res1.status, res2.status].sort();
  assert.deepEqual(statuses, [200, 409]);

  // Database must accurately reflect the winner
  const dbTicket = await SupportTicket.findById(ticket._id);
  assert.equal(["in_progress", "resolved"].includes(dbTicket.status), true);
});

test("5. Customer isolation: Foreign and malformed identifiers return non-enumerating 404s", async () => {
  const customerId = id();
  const hackerId = id();

  const ticket = await SupportTicket.create({
    customer: customerId,
    subject: "Private Ticket",
    status: "open",
    category: "general",
    idempotencyKey: next("priv"),
    idempotencyFingerprint: "c".repeat(64),
  });

  // Fetch details
  const foreignGet = await req("get", `/api/support-tickets/${ticket._id}`).set(
    auth(hackerId),
  );
  assert.equal(foreignGet.status, 404);
  assert.equal(foreignGet.body.errors[0].code.includes("unavailable"), true);

  // Reply
  const foreignReply = await req(
    "post",
    `/api/support-tickets/${ticket._id}/reply`,
  )
    .set(auth(hackerId))
    .set("Idempotency-Key", next("r"))
    .send({ body: "Injecting reply" });
  assert.equal(foreignReply.status, 404);
});

test("6. Notification lifecycle: staff actions, unread checks, read idempotency, and preference validation", async () => {
  const customerId = id();
  const staffId = id();

  const ticket = await SupportTicket.create({
    customer: customerId,
    subject: "Alerting test",
    status: "open",
    category: "general",
    idempotencyKey: next("alert"),
    idempotencyFingerprint: "d".repeat(64),
    messages: [
      {
        author: customerId,
        authorType: "customer",
        body: "Initial msg",
        idempotencyKey: next("init"),
      },
    ],
  });

  // Staff replies -> Creates Notification
  await req("post", `/api/support-tickets/${ticket._id}/reply`)
    .set(auth(staffId, "support_officer"))
    .set("Idempotency-Key", next("rep"))
    .send({ body: "We are looking into it." });

  // 1. Check Unread Count
  const countRes = await req("get", "/api/notifications/unread-count").set(
    auth(customerId),
  );
  assert.equal(countRes.status, 200);
  assert.equal(countRes.body.data.unreadCount >= 1, true);

  // 2. Fetch Notifications List
  const listRes = await req("get", "/api/notifications").set(auth(customerId));
  assert.equal(listRes.status, 200);

  const notificationId = listRes.body.data.notifications[0].id;

  // 3. Mark Read
  const readRes = await req(
    "patch",
    `/api/notifications/${notificationId}/read`,
  ).set(auth(customerId));
  assert.equal(readRes.status, 200);

  // Idempotent Read Check
  const readRes2 = await req(
    "patch",
    `/api/notifications/${notificationId}/read`,
  ).set(auth(customerId));
  assert.equal(readRes2.status, 200);

  // 4. Unread count should drop
  const newCountRes = await req("get", "/api/notifications/unread-count").set(
    auth(customerId),
  );
  assert.equal(
    newCountRes.body.data.unreadCount,
    countRes.body.data.unreadCount - 1,
  );

  // 5. Mark All Read
  const markAllRes = await req("post", "/api/notifications/read-all").set(
    auth(customerId),
  );
  assert.equal(markAllRes.status, 200);

  // 6. Preferences Validation
  const invalidPrefRes = await req("patch", "/api/notification-preferences")
    .set(auth(customerId))
    .send({ optionalCategories: { unknown_category: true } });
  assert.equal([400, 422].includes(invalidPrefRes.status), true); // Caught by Zod

  const validPrefRes = await req("patch", "/api/notification-preferences")
    .set(auth(customerId))
    .send({ optionalCategories: { repair_updates: false } });
  assert.equal(validPrefRes.status, 200);
});
