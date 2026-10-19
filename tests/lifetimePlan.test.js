"use strict";
const db=require("../netlify/functions/lib/db");
const members=require("../netlify/functions/lib/memberService");
const store=require("../netlify/functions/lib/billingStore");
const core=require("../netlify/functions/lib/billingCore");
const {authenticateGhostAIRequest}=require("../netlify/functions/lib/auth");
const {normalizeAccessPlan}=require("../netlify/functions/lib/accessPlans");
const {formatPlanLabel}=require("../netlify/functions/lib/emailTemplates");
const {handler}=require("../netlify/functions/admin-billing");
const {buildAdminSessionCookie}=require("../netlify/functions/lib/adminAuth");
const leases=require("../netlify/functions/lib/sheetSyncLease");
const owner={id:"system_owner",role:"owner",name:"QA Owner",email:"owner@qa.invalid"};
const event=(body,actor=owner)=>({httpMethod:"POST",headers:{cookie:buildAdminSessionCookie(process.env.GHOSTAI_ADMIN_AUTH_TOKEN,actor).split(";")[0]},body:JSON.stringify(body)});
beforeEach(()=>{process.env.GHOSTAI_ADMIN_AUTH_TOKEN="lifetime-unit-owner";process.env.GHOSTAI_TOKEN_HASH_PEPPER="lifetime-unit-pepper";process.env.GHOSTAI_BILLING_SHEET_ID="lifetime-unit-sheet";db._setMemoryStoreEnabled(true);db._resetMemoryStore();store._reset();leases._reset();});
afterEach(()=>jest.restoreAllMocks());afterAll(()=>db._setMemoryStoreEnabled(false));

test.each(["lifetime","De por vida","  DE   POR VIDA  ","Vitalicio"])("normalizes %s and labels invitation correctly",plan=>{expect(normalizeAccessPlan(plan)).toBe("lifetime");expect(formatPlanLabel(plan)).toBe("De por vida");});

test("lifetime activates once without member or key expiration, remains usable years later and can be revoked",async()=>{
  const created=await members.createMemberWithAccess({name:"Lifetime QA",email:"lifetime@qa.invalid",accessPlan:"De por vida"});
  expect(created.member).toMatchObject({access_plan:"lifetime",status:"pending",activated_at:null,expires_at:null});expect(created.emailPayload.plan).toBe("De por vida");
  const activated=await members.activateMemberAccess(created.activationToken);
  expect(activated).toMatchObject({accessPlan:"lifetime",expiresAt:null});expect(activated.activatedAt).toBeTruthy();
  expect((await db.listTokens()).find(t=>t.id===created.member.key_id).expiresAt).toBeNull();
  await expect(members.activateMemberAccess(created.activationToken)).rejects.toMatchObject({code:"TOKEN_ALREADY_USED"});
  jest.spyOn(Date,"now").mockReturnValue(Date.parse("2056-10-19T12:00:00Z"));
  expect((await authenticateGhostAIRequest({headers:{authorization:"Bearer "+activated.accessKey}})).ok).toBe(true);
  await members.revokeMemberAccess(created.member.id);
  expect((await authenticateGhostAIRequest({headers:{authorization:"Bearer "+activated.accessKey}})).ok).toBe(false);
});

test("renewal cannot add a date to lifetime, including an explicit monthly extension",async()=>{
  const {member}=await members.createMemberWithAccess({name:"Lifetime QA",email:"lifetime@qa.invalid",accessPlan:"lifetime"});
  for(const extension of [null,"monthly","annual"])await expect(members.renewMemberAccess(member.id,extension)).rejects.toMatchObject({code:"LIFETIME_NO_RENEWAL",statusCode:409});
  expect(await db.getMemberById(member.id)).toMatchObject({access_plan:"lifetime",status:"pending",expires_at:null});
});

test("sheet lifetime sync, editable per-member prices, append-only history and OPERATOR restrictions",async()=>{
  const csv="Nombre,Correo,Plan,VALOR USD\nLifetime QA,lifetime@qa.invalid,De por vida,150";
  jest.spyOn(global,"fetch").mockResolvedValue({ok:true,headers:{get:()=>"text/csv"},text:async()=>csv});
  const p=JSON.parse((await handler(event({action:"sync-preview"}))).body).preview;
  expect(p).toMatchObject({rows:1,validRows:1,monthly:0,annual:0,lifetime:1,counts:{newMembers:1,invalid:0}});
  expect((await handler(event({action:"sync",previewToken:p.previewToken}))).statusCode).toBe(200);
  const [member]=await db.listMembers();const before=await store.read();
  expect(member).toMatchObject({access_plan:"lifetime",status:"pending",activated_at:null,expires_at:null});expect(member.last_email_sent_at??null).toBeNull();
  const operator=await db.createAdminUserRecord({name:"QA Operator",role:"operator",status:"active"});
  const price={action:"price",memberId:member.id,amountMinor:17525,currency:"USD",expectedRevision:1,reason:"Precio individual autorizado"};
  expect((await handler(event(price,operator))).statusCode).toBe(403);
  expect((await handler(event(price))).statusCode).toBe(200);
  const after=await store.read();expect(after.profiles[0].amount_minor).toBe(17525);expect(after.transactions).toEqual(before.transactions);expect(after.transactions[0].amount_minor).toBe(15000);expect(after.transactions[0].status).toBe("unknown");
  expect(core.dashboard(after,await db.listMembers(),{month:"2026-10",currency:"USD"}).commercial.total).toBe(17525);
  const repeat=JSON.parse((await handler(event({action:"sync-preview"}))).body).preview;
  expect(repeat.counts).toMatchObject({newMembers:0,amountsUpdated:1,plansChanged:0}); // The sheet difference must be previewed before replacing an OWNER price.
  expect(await db.listTokens()).toHaveLength(1);
});

test("lifetime revenue is reported but excluded from MRR and renewal forecasts",()=>{
  const member={id:"life",name:"QA",email:"qa@qa.invalid",access_plan:"lifetime",status:"active",expires_at:null};
  const state={profiles:[{member_id:"life",amount_minor:15000,currency:"USD",revision:1}],transactions:[{id:"charge",entry_key:"charge",revision:1,member_id:"life",access_plan:"lifetime",amount_minor:15000,currency:"USD",status:"paid",paid_at:"2026-10-19",billing_period:"2026-10",created_at:"2026-10-19T12:00:00Z"}],goals:[],sync:null};
  const d=core.dashboard(state,[member],{month:"2026-10",currency:"USD"},new Date("2026-10-19T12:00:00Z"));
  expect(d.summary.collected).toBe(15000);expect(d.summary.mrr).toBeNull();expect(d.renewals).toEqual([]);expect(d.breakdown.find(b=>b.plan==="lifetime")).toMatchObject({members:1,collected:15000});
});

test("sheet changes pending access to lifetime but preserves an activated member's dated plan",async()=>{
  const pending=(await members.createMemberWithAccess({name:"Pending",email:"pending@qa.invalid",accessPlan:"monthly"})).member;
  const activeCreation=await members.createMemberWithAccess({name:"Active",email:"active@qa.invalid",accessPlan:"annual"});
  await members.activateMemberAccess(activeCreation.activationToken);const active=await db.getMemberById(activeCreation.member.id);
  const csv="Nombre,Correo,Plan,VALOR USD\nPending,pending@qa.invalid,De por vida,150\nActive,active@qa.invalid,De por vida,150";
  jest.spyOn(global,"fetch").mockResolvedValue({ok:true,headers:{get:()=>"text/csv"},text:async()=>csv});
  const p=JSON.parse((await handler(event({action:"sync-preview"}))).body).preview;
  expect(p).toMatchObject({safePlanChanges:1,counts:{plansChanged:2,needsReview:1}});
  expect((await handler(event({action:"sync",previewToken:p.previewToken}))).statusCode).toBe(200);
  expect(await db.getMemberById(pending.id)).toMatchObject({key_id:pending.key_id,access_plan:"lifetime",status:"pending",activated_at:null,expires_at:null});
  expect(await db.getMemberById(active.id)).toMatchObject({key_id:active.key_id,access_plan:"annual",status:"active",activated_at:active.activated_at,expires_at:active.expires_at});
});

test("invalid plans fail before creating clients or keys",async()=>{
  await expect(members.createMemberWithAccess({name:"QA",email:"qa@qa.invalid",accessPlan:"unsupported"})).rejects.toMatchObject({code:"VALIDATION_INVALID_PLAN"});
  expect(await db.listClients()).toHaveLength(0);expect(await db.listTokens()).toHaveLength(0);
});
