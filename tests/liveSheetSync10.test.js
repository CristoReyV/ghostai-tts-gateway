"use strict";
const db=require("../netlify/functions/lib/db");
const store=require("../netlify/functions/lib/billingStore");
const core=require("../netlify/functions/lib/billingCore");
const memberService=require("../netlify/functions/lib/memberService");
const leases=require("../netlify/functions/lib/sheetSyncLease");
const {handler}=require("../netlify/functions/admin-billing");
const {buildAdminSessionCookie}=require("../netlify/functions/lib/adminAuth");
const owner={id:"system_owner",role:"owner",name:"QA Owner",email:"owner@qa.invalid"};
const initial="Nombre,Correo,Plan,VALOR USD\nPending,pending@qa.invalid,Mensual,10\nActive,active@qa.invalid,Anual,89";
let csv,pending,active;
const event=(body,actor=owner)=>({httpMethod:"POST",headers:{cookie:buildAdminSessionCookie(process.env.GHOSTAI_ADMIN_AUTH_TOKEN,actor).split(";")[0]},body:JSON.stringify(body)});
const preview=async()=>{const r=await handler(event({action:"sync-preview"}));expect(r.statusCode).toBe(200);return JSON.parse(r.body).preview;};
const apply=token=>handler(event({action:"sync",previewToken:token}));
beforeEach(async()=>{
  process.env.GHOSTAI_ADMIN_AUTH_TOKEN="sheet-sync-10-unit-only";process.env.GHOSTAI_TOKEN_HASH_PEPPER="sheet-sync-10-pepper-unit-only";process.env.GHOSTAI_BILLING_SHEET_ID="sheet-unit-only";
  db._setMemoryStoreEnabled(true);db._resetMemoryStore();store._reset();leases._reset();csv=initial;
  pending=(await memberService.createMemberWithAccess({name:"Pending",email:"pending@qa.invalid",accessPlan:"monthly"})).member;
  active=(await memberService.createMemberWithAccess({name:"Active",email:"active@qa.invalid",accessPlan:"annual"})).member;
  active=await db.updateMember(active.id,{status:"active",activated_at:"2026-10-16T12:00:00Z",expires_at:"2027-10-16T12:00:00Z"});
  await store.write("sync",core.reconcileSheet(core.parseCsv(initial),await db.listMembers(),"sheet-unit-only"),owner);
  jest.spyOn(global,"fetch").mockImplementation(async()=>({ok:true,headers:{get:()=>"text/csv"},text:async()=>csv}));
});
afterEach(()=>jest.restoreAllMocks());afterAll(()=>db._setMemoryStoreEnabled(false));

test("official new-member lifecycle, no leaked credentials, refresh metadata and a second identical sync creates nothing",async()=>{
  csv+="\nNew,new@qa.invalid,Mensual,14\nUnsupported,unsupported@qa.invalid,Trimestral,150";
  const originalMembers=await db.listMembers(),originalLedger=(await store.read()).transactions;
  const p=await preview();expect(p).toMatchObject({rows:4,validRows:3,counts:{newMembers:1,invalid:1,needsReview:1}});expect(p.totals[0]).toEqual({currency:"USD",beforeMinor:9900,afterMinor:11300,sheetMinor:26300});
  const response=await apply(p.previewToken);expect(response.statusCode).toBe(200);expect(/gai_(live|act|admin)_/.test(response.body)).toBe(false);
  const newMember=await db.getMemberByEmail("new@qa.invalid");expect(newMember).toMatchObject({status:"pending",activated_at:null,expires_at:null});expect(newMember.last_email_sent_at??null).toBeNull();expect(newMember.key_id).toBeTruthy();
  expect(await db.getMemberByEmail("unsupported@qa.invalid")).toBeNull();expect(await db.listClients()).toHaveLength(3);expect(await db.listTokens()).toHaveLength(3);
  for(const old of originalMembers)expect(await db.getMemberById(old.id)).toMatchObject({key_id:old.key_id,status:old.status,activated_at:old.activated_at,expires_at:old.expires_at,access_plan:old.access_plan});
  const state=await store.read();expect(state.transactions.filter(t=>originalLedger.some(o=>o.id===t.id))).toEqual(originalLedger);expect(state.sync.metadata).toMatchObject({lastSheetSyncBy:{adminId:null,role:"owner"},rowsProcessed:4,lastChanges:{newMembers:1,amountChanges:0,planChanges:0,needsReview:1}});expect(state.sync.metadata.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/);
  const again=await preview();expect(again.counts).toMatchObject({newMembers:0,amountsUpdated:0,plansChanged:0});expect((await apply(again.previewToken)).statusCode).toBe(200);expect((await store.read()).transactions).toEqual(state.transactions);expect(await db.listClients()).toHaveLength(3);expect(await db.listTokens()).toHaveLength(3);
  const audit=await db.listAdminAuditLogs();expect(audit.filter(a=>a.action==="sheet_sync_applied")).toHaveLength(2);expect(audit.every(a=>a.admin_role==="owner")).toBe(true);
});
test("only clean PENDING plans change; active plan, key, price and expiration remain under owner review",async()=>{
  csv=initial.replace("pending@qa.invalid,Mensual,10","pending@qa.invalid,Anual,89").replace("active@qa.invalid,Anual,89","active@qa.invalid,Mensual,14");
  const p=await preview();expect(p).toMatchObject({safePlanChanges:1,counts:{plansChanged:2,needsReview:1}});
  expect((await apply(p.previewToken)).statusCode).toBe(200);
  expect(await db.getMemberById(pending.id)).toMatchObject({access_plan:"annual",key_id:pending.key_id,status:"pending",activated_at:null,expires_at:null});
  expect(await db.getMemberById(active.id)).toMatchObject({access_plan:"annual",key_id:active.key_id,status:"active",activated_at:active.activated_at,expires_at:active.expires_at});
  expect((await store.read()).profiles.find(p=>p.member_id===active.id).amount_minor).toBe(8900);
});
test("an activation racing a pending-plan update cannot have its plan or period changed",async()=>{
  csv=initial.replace("pending@qa.invalid,Mensual,10","pending@qa.invalid,Anual,89");const p=await preview();
  const guarded=db.updatePendingMemberPlan;
  jest.spyOn(db,"updatePendingMemberPlan").mockImplementationOnce(async(...args)=>{await db.updateMember(pending.id,{status:"active",activated_at:"2026-10-19T12:00:00Z",expires_at:"2026-11-18T12:00:00Z"});return guarded(...args);});
  expect((await apply(p.previewToken)).statusCode).toBe(409);
  expect(await db.getMemberById(pending.id)).toMatchObject({access_plan:"monthly",key_id:pending.key_id,status:"active",expires_at:"2026-11-18T12:00:00Z"});
  expect((await store.read()).profiles.find(p=>p.member_id===pending.id).amount_minor).toBe(1000);
});
test("simultaneous sync requests share one lease and never duplicate members, clients or keys",async()=>{
  csv+="\nNew,new@qa.invalid,Mensual,14";const p=await preview();
  const responses=await Promise.all([apply(p.previewToken),apply(p.previewToken)]);expect(responses.map(r=>r.statusCode).sort()).toEqual([200,409]);
  expect((await db.listMembers()).filter(m=>m.email==="new@qa.invalid")).toHaveLength(1);expect(await db.listClients()).toHaveLength(3);expect(await db.listTokens()).toHaveLength(3);
});
test("a failed Google read never changes business data and returns the actionable no-changes message",async()=>{
  const state=JSON.stringify(await store.read()),members=await db.listMembers(),audits=(await db.listAdminAuditLogs()).length;
  global.fetch.mockRejectedValue(new Error("unavailable"));
  for(const body of [{action:"sync-preview"},{action:"sync",previewToken:"a".repeat(64)}]){const r=await handler(event(body));expect(r.statusCode).toBe(503);expect(JSON.parse(r.body).error.message).toBe("No se pudo leer la tabla. No se realizaron cambios.");}
  expect(JSON.stringify(await store.read())).toBe(state);expect(await db.listMembers()).toEqual(members);expect((await db.listAdminAuditLogs()).length).toBe(audits);
});
test("blank amounts remain NULL for existing and new members, while past transactions survive",async()=>{
  csv=initial.replace("pending@qa.invalid,Mensual,10","pending@qa.invalid,Mensual,")+"\nMissing,missing@qa.invalid,Mensual,";
  const before=await store.read(),p=await preview();expect(p.counts.missingAmounts).toBe(2);expect(p.totals[0].afterMinor).toBe(8900);
  expect((await apply(p.previewToken)).statusCode).toBe(200);
  const after=await store.read(),newMember=await db.getMemberByEmail("missing@qa.invalid");
  expect(after.profiles.find(p=>p.member_id===pending.id).amount_minor).toBeNull();expect(after.profiles.find(p=>p.member_id===newMember.id).amount_minor).toBeNull();
  expect(after.transactions.filter(t=>before.transactions.some(b=>b.id===t.id))).toEqual(before.transactions);expect(newMember.status).toBe("pending");
});
test("a manual price edit between preview validation and the financial commit causes a guarded conflict",async()=>{
  csv=initial.replace("pending@qa.invalid,Mensual,10","pending@qa.invalid,Mensual,12");const p=await preview();const write=store.write;
  jest.spyOn(store,"write").mockImplementationOnce(async(action,payload,actor)=>{await write("price",{memberId:pending.id,amountMinor:1300,currency:"USD",expectedRevision:1,reason:"Concurrent owner edit"},owner);return write(action,payload,actor);});
  expect((await apply(p.previewToken)).statusCode).toBe(409);expect((await store.read()).profiles.find(p=>p.member_id===pending.id).amount_minor).toBe(1300);
  expect((await db.listAdminAuditLogs()).filter(a=>a.action==="sheet_sync_applied")).toHaveLength(0);
});
test("OPERATOR can read last sync but preview and apply both return 403 without source access",async()=>{
  const operator=await db.createAdminUserRecord({name:"QA Operator",role:"operator",status:"active"});
  for(const action of ["sync-preview","sync"])expect((await handler(event({action,previewToken:"a".repeat(64)},operator))).statusCode).toBe(403);
  const status=await handler({...event(null,operator),httpMethod:"GET",body:null,queryStringParameters:{sync:"status"}});expect(status.statusCode).toBe(200);expect(JSON.parse(status.body).sync.synced_at).toBeTruthy();expect(global.fetch).not.toHaveBeenCalled();
});
