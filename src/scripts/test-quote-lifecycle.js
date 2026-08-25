import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app;
let Quote;
let Repair;
let createNewQuoteVersion;
let replicaSet;
const ACCESS_SECRET = "quote-lifecycle-access-secret-at-least-32-characters";
const id = () => new mongoose.Types.ObjectId().toString();
const auth = (userId, role) => ({ Authorization: `Bearer ${jwt.sign({ userId, role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}` });
const createRepair = async (owner) => (await request(app).post("/api/repairs").set(auth(owner, "customer")).send({ device: { type: "phone", brand: "Sanfaani", model: "Quote fixture" }, issueDescription: "The battery drains unexpectedly during normal use", privacyAcknowledged: true })).body.data.repair;
const createQuote = (repairId, tech, suffix = "labour") => request(app).post(`/api/repairs/${repairId}/quote`).set(auth(tech, "technician")).send({ lineItems: [{ description: suffix, amount: 12500 }] });

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "quote-lifecycle-refresh-secret-at-least-32-characters";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "quote-lifecycle-audit-secret-at-least-32-characters";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "quote-lifecycle-hmac-secret-at-least-32-characters";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_quote_lifecycle_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be04-be10-mongo");
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `quote_lifecycle_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: Quote } = await import("../models/Quote.js"));
  ({ default: Repair } = await import("../models/Repair.js"));
  ({ createNewQuoteVersion } = await import("../services/quoteService.js"));
  await mongoose.syncIndexes();
});
test.beforeEach(async () => { for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({}); });
test.after(async () => { if (mongoose.connection.readyState) await mongoose.disconnect(); if (replicaSet) await replicaSet.stop(); });

test("latest sent quote accepts once, retains the decision and is idempotent", async () => {
  const owner = id(); const tech = id(); const repair = await createRepair(owner);
  const quote = (await createQuote(repair._id, tech)).body.data;
  const first = await request(app).patch(`/api/repairs/${repair._id}/quote/${quote._id}/approve`).set(auth(owner, "customer"));
  const repeated = await request(app).patch(`/api/repairs/${repair._id}/quote/${quote._id}/approve`).set(auth(owner, "customer"));
  assert.equal(first.status, 200); assert.equal(repeated.status, 200);
  const persisted = await Quote.findById(quote._id).lean();
  assert.equal(persisted.status, "ACCEPTED"); assert.equal(persisted.totalAmount, 12500);
  assert.equal(persisted.decision.type, "ACCEPTED"); assert.equal(persisted.decision.actor.toString(), owner);
  assert.equal((await Repair.findById(repair._id)).status, "APPROVED");
});

test("latest sent quote declines once, and a conflicting decision cannot overwrite it", async () => {
  const owner = id(); const repair = await createRepair(owner); const quote = (await createQuote(repair._id, id())).body.data;
  assert.equal((await request(app).patch(`/api/repairs/${repair._id}/quote/${quote._id}/decline`).set(auth(owner, "customer")).send({ reason: "Not within budget" })).status, 200);
  const conflict = await request(app).patch(`/api/repairs/${repair._id}/quote/${quote._id}/approve`).set(auth(owner, "customer"));
  assert.equal(conflict.status, 409); assert.equal((await Quote.findById(quote._id)).status, "DECLINED");
});

test("older, foreign, and expired quotes cannot be newly decided", async () => {
  const owner = id(); const repair = await createRepair(owner); const older = (await createQuote(repair._id, id(), "first")).body.data; const latest = (await createQuote(repair._id, id(), "second")).body.data;
  assert.equal((await request(app).patch(`/api/repairs/${repair._id}/quote/${older._id}/approve`).set(auth(owner, "customer"))).status, 409);
  assert.equal((await request(app).patch(`/api/repairs/${repair._id}/quote/${latest._id}/approve`).set(auth(id(), "customer"))).status, 404);
  await Quote.updateOne({ _id: latest._id }, { $set: { expiresAt: new Date(Date.now() - 1) } });
  assert.equal((await request(app).patch(`/api/repairs/${repair._id}/quote/${latest._id}/approve`).set(auth(owner, "customer"))).status, 409);
});

test("concurrent version creation preserves one actionable quote and monotonically unique versions", async () => {
  const repair = await createRepair(id()); const technician = id();
  await Promise.all(Array.from({ length: 5 }, (_, index) => createNewQuoteVersion(repair._id.toString(), [{ description: `work ${index}`, amount: 1000 + index }], technician)));
  const quotes = await Quote.find({ repair: repair._id }).sort({ version: 1 }).lean();
  assert.equal(quotes.length, 5); assert.deepEqual(quotes.map((quote) => quote.version), [1, 2, 3, 4, 5]);
  assert.equal(quotes.filter((quote) => quote.isActionable).length, 1);
});
