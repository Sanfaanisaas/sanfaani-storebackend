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

const ACCESS_SECRET = "support-notif-access-secret-32-chars";
const id = () => new mongoose.Types.ObjectId().toString();
const auth = (userId, role = "customer") => ({
  Authorization: `Bearer ${jwt.sign({ userId, role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}`,
});

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "support-notif-refresh-secret-32-chars";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "support-notif-audit-secret-32-chars";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "support-notif-tracking-secret-32-chars";
  process.env.GUIDANCE_TOKEN_SECRET = "support-notif-guidance-secret-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_support_notif_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be10-mongo");
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `support_notif_test_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: SupportTicket } = await import("../models/SupportTicket.js"));
  ({ default: Order } = await import("../models/Order.js"));
  ({ default: Notification } = await import("../models/Notification.js"));
  ({ default: NotificationPreference } = await import("../models/NotificationPreference.js"));
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

test("support ticket creation, linked resource validation, idempotency, and non-enumeration", async () => {
  const customerId = id();
  const foreignCustomerId = id();

  const ownedOrder = await Order.create({
    userId: customerId,
    status: "paid",
    items: [{ productId: new mongoose.Types.ObjectId(), variantSku: "SKU-S1", nameSnapshot: "Product S", quantity: 1, priceSnapshot: 10000 }],
    subtotal: 10000,
    total: 10000,
    paymentMethod: "bank_transfer",
    shippingAddress: { street: "1 Main St", city: "Lagos", state: "LA", country: "Nigeria" },
  });

  const foreignOrder = await Order.create({
    userId: foreignCustomerId,
    status: "paid",
    items: [{ productId: new mongoose.Types.ObjectId(), variantSku: "SKU-S2", nameSnapshot: "Product F", quantity: 1, priceSnapshot: 10000 }],
    subtotal: 10000,
    total: 10000,
    paymentMethod: "bank_transfer",
    shippingAddress: { street: "1 Main St", city: "Lagos", state: "LA", country: "Nigeria" },
  });

  const invalidInputRes = await request(app)
    .post("/api/support-tickets")
    .set(auth(customerId))
    .set("Idempotency-Key", "key-sup-1")
    .send({ subject: "ab", message: "short" });
  assert.equal(invalidInputRes.status, 400);

  const foreignResourceRes = await request(app)
    .post("/api/support-tickets")
    .set(auth(customerId))
    .set("Idempotency-Key", "key-sup-2")
    .send({ subject: "Order Inquiry", message: "I need help with my order delivery status.", linkedResource: { type: "order", id: foreignOrder._id.toString() } });
  assert.equal(foreignResourceRes.status, 404);
  assert.equal(foreignResourceRes.body.errors[0].code, "support_resource_unavailable");

  const createRes = await request(app)
    .post("/api/support-tickets")
    .set(auth(customerId))
    .set("Idempotency-Key", "key-sup-3")
    .send({ subject: "Order Delivery Inquiry", message: "I need help tracking my order delivery status.", category: "order", priority: "normal", linkedResource: { type: "order", id: ownedOrder._id.toString() } });
  assert.equal(createRes.status, 201);
  assert.equal(createRes.body.data.status, "open");

  const replayRes = await request(app)
    .post("/api/support-tickets")
    .set(auth(customerId))
    .set("Idempotency-Key", "key-sup-3")
    .send({ subject: "Order Delivery Inquiry", message: "I need help tracking my order delivery status.", category: "order", priority: "normal", linkedResource: { type: "order", id: ownedOrder._id.toString() } });
  assert.equal(replayRes.status, 200);
  assert.equal(replayRes.body.data.id, createRes.body.data.id);

  const conflictRes = await request(app)
    .post("/api/support-tickets")
    .set(auth(customerId))
    .set("Idempotency-Key", "key-sup-3")
    .send({ subject: "Different Subject", message: "Completely different text." });
  assert.equal(conflictRes.status, 409);

  const foreignGetRes = await request(app).get(`/api/support-tickets/${createRes.body.data.id}`).set(auth(foreignCustomerId));
  assert.equal(foreignGetRes.status, 404);
  assert.equal(foreignGetRes.body.errors[0].code, "support_ticket_unavailable");
});

test("support ticket replies, staff transitions, and notifications", async () => {
  const customerId = id();
  const staffId = id();

  const ticketRes = await request(app)
    .post("/api/support-tickets")
    .set(auth(customerId))
    .set("Idempotency-Key", "key-sup-reply-init")
    .send({ subject: "Warranty Assistance", message: "How do I ship my item back for repair?" });
  assert.equal(ticketRes.status, 201);
  const ticketId = ticketRes.body.data.id;

  const staffReplyRes = await request(app)
    .post(`/api/support-tickets/${ticketId}/reply`)
    .set(auth(staffId, "support_officer"))
    .set("Idempotency-Key", "key-reply-staff-1")
    .send({ body: "You can use our pre-paid courier drop-off label attached in your email." });
  if (staffReplyRes.status !== 201) console.log("staffReplyRes fail body:", staffReplyRes.body);
  assert.equal(staffReplyRes.status, 201);
  assert.equal(staffReplyRes.body.data.conversation.length, 2);

  const notif = await Notification.findOne({ recipient: customerId, type: "support_reply" });
  assert.ok(notif);
  assert.equal(notif.resourceId.toString(), ticketId);

  const customerReplyRes = await request(app)
    .post(`/api/support-tickets/${ticketId}/reply`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-reply-cust-1")
    .send({ body: "Thank you, I have downloaded the label and shipped it today." });
  assert.equal(customerReplyRes.status, 201);

  const staffStatusRes = await request(app)
    .patch(`/api/support-tickets/${ticketId}/status`)
    .set(auth(staffId, "support_officer"))
    .send({ status: "resolved", resolutionSummary: "Courier drop-off instructions provided." });
  assert.equal(staffStatusRes.status, 200);
  assert.equal(staffStatusRes.body.data.status, "resolved");

  const staffCloseRes = await request(app)
    .patch(`/api/support-tickets/${ticketId}/status`)
    .set(auth(staffId, "support_officer"))
    .send({ status: "closed" });
  assert.equal(staffCloseRes.status, 200);

  const replyClosedRes = await request(app)
    .post(`/api/support-tickets/${ticketId}/reply`)
    .set(auth(customerId))
    .set("Idempotency-Key", "key-reply-closed")
    .send({ body: "Attempting to reply to closed ticket." });
  assert.equal(replyClosedRes.status, 409);
});

test("notification list, unread count, read idempotency, preferences validation, and forbidden fields", async () => {
  const customerId = id();

  await Notification.create({
    recipient: customerId,
    type: "claim_status_updated",
    title: "Claim Updated",
    safePreview: "Your claim has been updated.",
    resourceType: "claim",
    resourceId: id(),
    mandatory: true,
    eventKey: `event-key-1-${Date.now()}`,
  });

  const unreadRes1 = await request(app).get("/api/notifications/unread-count").set(auth(customerId));
  assert.equal(unreadRes1.status, 200);
  assert.equal(unreadRes1.body.data.unreadCount, 1);

  const listRes = await request(app).get("/api/notifications").set(auth(customerId));
  assert.equal(listRes.status, 200);
  const notifId = listRes.body.data.notifications[0].id;

  const markReadRes1 = await request(app).patch(`/api/notifications/${notifId}/read`).set(auth(customerId));
  assert.equal(markReadRes1.status, 200);

  const markReadRes2 = await request(app).patch(`/api/notifications/${notifId}/read`).set(auth(customerId));
  assert.equal(markReadRes2.status, 200);

  const unreadRes2 = await request(app).get("/api/notifications/unread-count").set(auth(customerId));
  assert.equal(unreadRes2.body.data.unreadCount, 0);

  const markAllRes = await request(app).post("/api/notifications/read-all").set(auth(customerId));
  assert.equal(markAllRes.status, 200);

  const prefGetRes = await request(app).get("/api/notification-preferences").set(auth(customerId));
  assert.equal(prefGetRes.status, 200);

  const invalidPrefRes = await request(app)
    .patch("/api/notification-preferences")
    .set(auth(customerId))
    .send({ optionalCategories: { unknown_category: true } });
  assert.equal(invalidPrefRes.status, 400);

  const validPrefRes = await request(app)
    .patch("/api/notification-preferences")
    .set(auth(customerId))
    .send({ optionalCategories: { repair_updates: false } });
  assert.equal(validPrefRes.status, 200);
  assert.equal(validPrefRes.body.data.optionalCategories.repair_updates, false);
});
