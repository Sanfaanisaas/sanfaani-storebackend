import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app;
let AuditLog;
let FinancialDocument;
let Organisation;
let OrganisationMember;
let Order;
let ProcurementQuotation;
let ProcurementRequest;
let replicaSet;
let setAuditServiceTestHooks;
let sequence = 0;

const ACCESS_SECRET = "b2b-conversion-access-secret-32-chars";
const objectId = () => new mongoose.Types.ObjectId();
const unique = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;
const auth = (userId, role = "customer") => ({
  Authorization: `Bearer ${jwt.sign(
    { userId: userId.toString(), role, type: "access" },
    ACCESS_SECRET,
    { algorithm: "HS256", expiresIn: "15m" },
  )}`,
});
const api = (method, url) => request(app)[method](url).set("X-Forwarded-For", objectId().toString());
const address = (street = "12 Procurement Road") => ({
  street,
  city: "Ibadan",
  state: "Oyo",
  postalCode: "200001",
  country: "Nigeria",
});

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "b2b-conversion-refresh-secret-32-chars";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "b2b-conversion-audit-secret-32-chars";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "b2b-conversion-tracking-secret-32-chars";
  process.env.GUIDANCE_TOKEN_SECRET = "b2b-conversion-guidance-secret-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_b2b_conversion";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be19-mongo");

  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: `b2b_conversion_${process.pid}_${Date.now()}`,
  });

  ({ default: app } = await import("../app.js"));
  ({ default: AuditLog } = await import("../models/AuditLog.js"));
  ({ default: FinancialDocument } = await import("../models/FinancialDocument.js"));
  ({ default: Organisation } = await import("../models/Organisation.js"));
  ({ default: OrganisationMember } = await import("../models/OrganisationMember.js"));
  ({ default: Order } = await import("../models/Order.js"));
  ({ default: ProcurementQuotation } = await import("../models/ProcurementQuotation.js"));
  ({ default: ProcurementRequest } = await import("../models/ProcurementRequest.js"));
  ({ setAuditServiceTestHooks } = await import("../services/auditService.js"));
  await mongoose.syncIndexes();
});

test.beforeEach(async () => {
  setAuditServiceTestHooks({});
  for (const collection of Object.values(mongoose.connection.collections)) {
    await collection.deleteMany({});
  }
});

test.after(async () => {
  setAuditServiceTestHooks({});
  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (replicaSet) await replicaSet.stop();
});

const createOrganisation = async (owner) => {
  const response = await api("post", "/api/organisations")
    .set(auth(owner))
    .set("Idempotency-Key", unique("org"))
    .send({
      name: `Sanfaani Business ${sequence}`,
      type: "business",
      billingEmail: `billing-${sequence}@example.test`,
    });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data;
};

const createApprovedQuotation = async ({ customer = objectId(), staff = objectId() } = {}) => {
  const organisation = await createOrganisation(customer);
  const procurement = await api("post", "/api/procurement/requests")
    .set(auth(customer))
    .set("Idempotency-Key", unique("request"))
    .send({
      organisationId: organisation.id,
      organisationName: organisation.name,
      organisationType: organisation.type,
      contactName: "Ada Buyer",
      contactEmail: "ada.buyer@example.test",
      contactPhone: "08012345678",
      fulfilmentMode: "delivery",
      fulfilmentLocation: "12 Procurement Road, Ibadan",
      requirements: [{
        category: "Laptop computers",
        quantity: 4,
        minimumSpecifications: "16GB RAM and 512GB SSD",
      }],
    });
  assert.equal(procurement.status, 201, JSON.stringify(procurement.body));

  const issued = await api("post", `/api/procurement/requests/${procurement.body.data.id}/quotations`)
    .set(auth(staff, "sales_advisor"))
    .send({
      lineItems: [{
        description: "Business laptop bundle",
        quantity: 4,
        unitPrice: 450000,
        totalAmount: 1800000,
      }],
      subtotal: 1800000,
      tax: 135000,
      fees: 25000,
      fulfilmentCharge: 40000,
      totalAmount: 2000000,
      validUntil: new Date(Date.now() + 7 * 86400000).toISOString(),
      termsVersion: "b2b-2026-09",
      warrantySummary: "Twelve month limited warranty",
      supportSummary: "Business-hours remote support",
    });
  assert.equal(issued.status, 201, JSON.stringify(issued.body));

  const approved = await api("post", `/api/procurement/quotations/${issued.body.data.id}/approve`)
    .set(auth(customer))
    .set("Idempotency-Key", unique("approve"))
    .send({ version: issued.body.data.version });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return {
    customer,
    organisation,
    request: procurement.body.data,
    quote: approved.body.data,
  };
};

const convert = ({ customer, organisationId, quoteId, key, body = {} }) =>
  api("post", `/api/procurement/quotations/${quoteId}/convert`)
    .set(auth(customer))
    .set("Idempotency-Key", key)
    .send({
      organisationId,
      expectedVersion: 1,
      paymentMethod: "bank_transfer",
      shippingAddress: address(),
      purchaseOrderReference: "PO-ACME-2026-001",
      ...body,
    });

test("1. organisation creation atomically grants the creator owner purchasing authority", async () => {
  const owner = objectId();
  const organisation = await createOrganisation(owner);
  const stored = await Organisation.findById(organisation.id).lean();
  const membership = await OrganisationMember.findOne({ organisation: organisation.id, user: owner }).lean();

  assert.equal(stored.status, "ACTIVE");
  assert.equal(membership.role, "OWNER");
  assert.equal(membership.status, "ACTIVE");
  assert.equal(membership.canPurchase, true);
});

test("2. approved current quotation converts to one owner-visible immutable order snapshot", async () => {
  const fixture = await createApprovedQuotation();
  const response = await convert({
    customer: fixture.customer,
    organisationId: fixture.organisation.id,
    quoteId: fixture.quote.id,
    key: unique("convert"),
  });

  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.deepEqual(Object.keys(response.body.data.order.procurementSnapshot).sort(), [
    "approvedAt", "currency", "fees", "fulfilmentCharge", "lineItems", "organisationId",
    "purchaseOrderReference", "quotationId", "quotationVersion", "requestId", "subtotal",
    "supportSummary", "tax", "termsVersion", "totalAmount", "validUntil", "warrantySummary",
  ].sort());
  assert.equal(response.body.data.order.procurementSnapshot.totalAmount, 2000000);
  assert.equal(response.body.data.order.total, 2000000);
  assert.equal(response.body.data.order.userId, fixture.customer.toString());
  assert.equal("procurementConversion" in response.body.data.order, false);

  await ProcurementQuotation.updateOne(
    { _id: fixture.quote.id },
    { $set: { totalAmount: 9999999, termsVersion: "mutated" } },
  );
  const ownerOrder = await api("get", `/api/orders/${response.body.data.order.id}`).set(auth(fixture.customer));
  assert.equal(ownerOrder.status, 200);
  assert.equal("procurementConversion" in ownerOrder.body.data, false);
  assert.equal(ownerOrder.body.data.procurementSnapshot.totalAmount, 2000000);
  assert.equal(ownerOrder.body.data.procurementSnapshot.termsVersion, "b2b-2026-09");
});

test("3. identical replay returns the same order while payload drift conflicts", async () => {
  const fixture = await createApprovedQuotation();
  const key = unique("conversion-replay");
  const first = await convert({ customer: fixture.customer, organisationId: fixture.organisation.id, quoteId: fixture.quote.id, key });
  const replay = await convert({ customer: fixture.customer, organisationId: fixture.organisation.id, quoteId: fixture.quote.id, key });
  const drift = await convert({
    customer: fixture.customer,
    organisationId: fixture.organisation.id,
    quoteId: fixture.quote.id,
    key,
    body: { shippingAddress: address("99 Changed Street") },
  });

  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers["idempotency-replayed"], "true");
  assert.equal(replay.body.data.order.id, first.body.data.order.id);
  assert.equal(drift.status, 409);
  assert.equal(drift.body.errors[0].code, "procurement_conversion_idempotency_conflict");
  assert.equal(await Order.countDocuments({ "procurementSnapshot.quotationId": fixture.quote.id }), 1);
});

test("4. a different key cannot convert an already converted quotation again", async () => {
  const fixture = await createApprovedQuotation();
  const first = await convert({ customer: fixture.customer, organisationId: fixture.organisation.id, quoteId: fixture.quote.id, key: unique("first") });
  const second = await convert({ customer: fixture.customer, organisationId: fixture.organisation.id, quoteId: fixture.quote.id, key: unique("second") });
  assert.equal(first.status, 201);
  assert.equal(second.status, 409);
  assert.equal(second.body.errors[0].code, "procurement_quote_already_converted");
});

test("5. an owner can grant persisted BUYER authority and that buyer can convert for the organisation", async () => {
  const fixture = await createApprovedQuotation();
  const buyer = objectId();
  const membership = await api("post", `/api/organisations/${fixture.organisation.id}/members`)
    .set(auth(fixture.customer))
    .send({ userId: buyer.toString(), role: "BUYER" });
  assert.equal(membership.status, 201, JSON.stringify(membership.body));
  assert.equal(membership.body.data.canPurchase, true);

  const converted = await convert({ customer: buyer, organisationId: fixture.organisation.id, quoteId: fixture.quote.id, key: unique("buyer") });
  assert.equal(converted.status, 201, JSON.stringify(converted.body));
  assert.equal(converted.body.data.order.userId, buyer.toString());
});

test("6. outsider, viewer, revoked member, and suspended organisation cannot purchase", async () => {
  const fixture = await createApprovedQuotation();
  const outsider = objectId();
  const viewer = objectId();
  const revoked = objectId();
  await OrganisationMember.create([
    { organisation: fixture.organisation.id, user: viewer, role: "VIEWER", status: "ACTIVE", canPurchase: false, invitedBy: fixture.customer },
    { organisation: fixture.organisation.id, user: revoked, role: "BUYER", status: "REVOKED", canPurchase: true, invitedBy: fixture.customer },
  ]);

  for (const actor of [outsider, viewer, revoked]) {
    const denied = await convert({ customer: actor, organisationId: fixture.organisation.id, quoteId: fixture.quote.id, key: unique("denied") });
    assert.equal(denied.status, 404);
    assert.equal(denied.body.errors[0].code, "procurement_quotation_unavailable");
  }

  await Organisation.updateOne({ _id: fixture.organisation.id }, { $set: { status: "SUSPENDED" } });
  const suspended = await convert({ customer: fixture.customer, organisationId: fixture.organisation.id, quoteId: fixture.quote.id, key: unique("suspended") });
  assert.equal(suspended.status, 409);
  assert.equal(suspended.body.errors[0].code, "organisation_inactive");
});

test("7. expired, superseded, non-current, wrong-version, and organisation-mismatched quotations cannot convert", async () => {
  for (const mode of ["expired", "superseded", "not-latest", "wrong-version", "wrong-organisation"]) {
    const fixture = await createApprovedQuotation();
    const body = {};
    let organisationId = fixture.organisation.id;
    if (mode === "expired") await ProcurementQuotation.updateOne({ _id: fixture.quote.id }, { $set: { validUntil: new Date(Date.now() - 1000) } });
    if (mode === "superseded") await ProcurementQuotation.updateOne({ _id: fixture.quote.id }, { $set: { superseded: true, status: "SUPERSEDED" } });
    if (mode === "not-latest") await ProcurementQuotation.create({
      request: fixture.request.id,
      customer: fixture.customer,
      organisation: fixture.organisation.id,
      version: 2,
      lineItems: [{ description: "Replacement quote", quantity: 1, unitPrice: 2100000, totalAmount: 2100000 }],
      subtotal: 2100000,
      totalAmount: 2100000,
      validUntil: new Date(Date.now() + 86400000),
      termsVersion: "b2b-2026-10",
      status: "ISSUED",
    });
    if (mode === "wrong-version") body.expectedVersion = 2;
    if (mode === "wrong-organisation") organisationId = (await createOrganisation(fixture.customer)).id;

    const denied = await convert({ customer: fixture.customer, organisationId, quoteId: fixture.quote.id, key: unique(mode), body });
    assert.equal([404, 409].includes(denied.status), true, `${mode}: ${JSON.stringify(denied.body)}`);
    assert.equal(await Order.countDocuments({ "procurementSnapshot.quotationId": fixture.quote.id }), 0);
  }
});

test("8. required audit failure rolls back order, quotation, and request conversion state", async () => {
  const fixture = await createApprovedQuotation();
  setAuditServiceTestHooks({ beforeWrite: async ({ action }) => {
    if (action === "B2B_QUOTATION_CONVERTED") throw new Error("forced audit failure");
  } });

  const response = await convert({ customer: fixture.customer, organisationId: fixture.organisation.id, quoteId: fixture.quote.id, key: unique("rollback") });
  assert.equal(response.status, 500);
  assert.equal(await Order.countDocuments({ "procurementSnapshot.quotationId": fixture.quote.id }), 0);
  assert.equal((await ProcurementQuotation.findById(fixture.quote.id)).conversionStatus, "NOT_STARTED");
  assert.equal((await ProcurementRequest.findById(fixture.request.id)).status, "CONVERSION_PENDING");
});

test("9. concurrent conversion creates exactly one order and one audit event", async () => {
  const fixture = await createApprovedQuotation();
  const key = unique("concurrent");
  const [left, right] = await Promise.all([
    convert({ customer: fixture.customer, organisationId: fixture.organisation.id, quoteId: fixture.quote.id, key }),
    convert({ customer: fixture.customer, organisationId: fixture.organisation.id, quoteId: fixture.quote.id, key }),
  ]);
  assert.deepEqual([left.status, right.status].sort(), [200, 201]);
  assert.equal(left.body.data.order.id, right.body.data.order.id);
  assert.equal(await Order.countDocuments({ "procurementSnapshot.quotationId": fixture.quote.id }), 1);
  assert.equal(await AuditLog.countDocuments({ action: "B2B_QUOTATION_CONVERTED", targetId: fixture.quote.id }), 1);
});

test("10. tracking or forged role claims cannot replace organisation membership", async () => {
  const fixture = await createApprovedQuotation();
  const forged = objectId();
  const denied = await api("post", `/api/procurement/quotations/${fixture.quote.id}/convert`)
    .set(auth(forged, "super_admin"))
    .set("Idempotency-Key", unique("forged"))
    .send({
      organisationId: fixture.organisation.id,
      expectedVersion: 1,
      paymentMethod: "bank_transfer",
      shippingAddress: address(),
    });
  assert.equal(denied.status, 404);
  assert.equal(await Order.countDocuments({ "procurementSnapshot.quotationId": fixture.quote.id }), 0);
});

test("11. converted order totals and identity are derived from the quotation, not client fields", async () => {
  const fixture = await createApprovedQuotation();
  const response = await convert({
    customer: fixture.customer,
    organisationId: fixture.organisation.id,
    quoteId: fixture.quote.id,
    key: unique("server-truth"),
    body: { total: 1, subtotal: 1, currency: "USD", quotationId: objectId().toString() },
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.data.order.total, 2000000);
  assert.equal(response.body.data.order.procurementSnapshot.currency, "NGN");
  assert.equal(response.body.data.order.procurementSnapshot.quotationId, fixture.quote.id);
});

test("12. B2B invoices use the immutable quotation snapshot and never require mutable catalogue rows", async () => {
  const fixture = await createApprovedQuotation();
  const converted = await convert({ customer: fixture.customer, organisationId: fixture.organisation.id, quoteId: fixture.quote.id, key: unique("invoice") });
  assert.equal(converted.status, 201);

  const invoice = await api("get", `/api/orders/${converted.body.data.order.id}/invoice`).set(auth(fixture.customer));
  assert.equal(invoice.status, 200);
  assert.match(invoice.headers["content-type"], /^application\/pdf/);
  const stored = await FinancialDocument.findOne({ order: converted.body.data.order.id, kind: "INVOICE" }).lean();
  assert.equal(stored.snapshot.items.length, 1);
  assert.equal(stored.snapshot.items[0].name, "Business laptop bundle");
  assert.equal(stored.snapshot.items[0].lineTotal, 1800000);
  assert.equal(stored.snapshot.total, 2000000);

  await assert.rejects(
    Order.updateOne(
      { _id: converted.body.data.order.id },
      { $set: { "procurementSnapshot.totalAmount": 1, total: 1 } },
    ),
    /snapshots are immutable/,
  );
  const immutableOrder = await Order.findById(converted.body.data.order.id).lean();
  assert.equal(immutableOrder.procurementSnapshot.totalAmount, 2000000);
  assert.equal(immutableOrder.total, 2000000);
  assert.equal((await FinancialDocument.findById(stored._id)).snapshot.total, 2000000);
});
