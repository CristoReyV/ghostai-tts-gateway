"use strict";
const core = require("../netlify/functions/lib/billingCore");
const {buildSyncPreview} = require("../netlify/functions/lib/billingSyncPreview");
const db = require("../netlify/functions/lib/db");
const store = require("../netlify/functions/lib/billingStore");
const {handler} = require("../netlify/functions/admin-billing");
const {buildAdminSessionCookie} = require("../netlify/functions/lib/adminAuth");
const owner={id:"system_owner",role:"owner",name:"QA Owner",email:"owner@qa.invalid"};
const original="Nombre,Correo,Plan,VALOR USD\nA,a@qa.invalid,Mensual,10\nB,b@qa.invalid,Anual,89\nC,c@qa.invalid,Mensual,14";
const members=[{id:"a",name:"A",email:"a@qa.invalid",access_plan:"monthly",status:"active"},{id:"b",name:"B",email:"b@qa.invalid",access_plan:"annual",status:"active"},{id:"c",name:"C",email:"c@qa.invalid",access_plan:"monthly",status:"pending"},{id:"outside",name:"Outside",email:"outside@qa.invalid",access_plan:"monthly",status:"revoked"}];
const seed=()=>({profiles:core.reconcileSheet(core.parseCsv(original),members,"qa-source").records.map(r=>({...r,revision:1})),transactions:[],goals:[],sync:null});
const event=body=>({httpMethod:"POST",headers:{cookie:buildAdminSessionCookie(process.env.GHOSTAI_ADMIN_AUTH_TOKEN,owner).split(";")[0]},body:JSON.stringify(body)});
let liveCsv;
beforeEach(()=>{process.env.GHOSTAI_ADMIN_AUTH_TOKEN="preview-unit-only";process.env.GHOSTAI_BILLING_SHEET_ID="qa-source";db._setMemoryStoreEnabled(true);db._resetMemoryStore();store._reset();liveCsv=original;jest.spyOn(db,"listMembers").mockImplementation(async()=>members);jest.spyOn(global,"fetch").mockImplementation(async()=>({ok:true,headers:{get:()=>"text/csv"},text:async()=>liveCsv}));});
afterEach(()=>jest.restoreAllMocks());afterAll(()=>db._setMemoryStoreEnabled(false));

test("preview classifies mutually exclusive changes and separates source totals from applicable totals and currencies",()=>{
  const state=seed();state.profiles.push({member_id:"outside",amount_minor:500,currency:"MXN",revision:1});
  const csv="Nombre,Correo,Plan,VALOR USD\nA,a@qa.invalid,Mensual,12\nB,b@qa.invalid,Mensual,10\nC,c@qa.invalid,Mensual,14\nNew1,new1@qa.invalid,Mensual,10\nNew2,new2@qa.invalid,Anual,10\n,,Total,56";
  const snapshot=JSON.stringify(state);const {preview,payload}=buildSyncPreview(core.parseCsv(csv),members,state,"qa-source");
  expect(preview).toMatchObject({rows:5,counts:{newMembers:2,amountsUpdated:1,plansChanged:1,unchanged:1,invalid:0,needsReview:1},applicableRows:4,canApply:true,existingNotInSheet:1});
  expect(preview.totals).toEqual([{currency:"MXN",beforeMinor:500,afterMinor:500,sheetMinor:0},{currency:"USD",beforeMinor:11300,afterMinor:13500,sheetMinor:5600}]);
  expect(payload.records.map(r=>r.member_id)).toEqual(["a","c"]);expect(JSON.stringify(state)).toBe(snapshot);
});
test("duplicates, ambiguous members and malformed amounts are reviewed without erasing known prices",()=>{
  const csv="Nombre,Correo,Plan,VALOR USD\nA,a@qa.invalid,Mensual,wrong\nC,c@qa.invalid,Mensual,14\nC duplicate,C@qa.invalid,Mensual,14\nBad,invalid,Mensual,10";
  const {preview,payload}=buildSyncPreview(core.parseCsv(csv),members,seed(),"qa-source");
  expect(preview.counts).toMatchObject({newMembers:0,amountsUpdated:0,plansChanged:0,unchanged:0,invalid:4,needsReview:4});
  expect(payload.records).toEqual([]);expect(preview.canApply).toBe(false);expect(preview.totals[0]).toMatchObject({beforeMinor:11300,afterMinor:11300});
  const ambiguous=[...members,{...members[0],id:"duplicate-db"}];
  expect(buildSyncPreview(core.parseCsv(original),ambiguous,seed(),"qa-source").preview.counts.invalid).toBe(1);
});
test("OWNER sees manual price differences before explicitly applying current sheet values",()=>{
  const state=seed();state.profiles[0].amount_minor=1200;state.profiles[0].source="OWNER";state.profiles[0].revision=2;
  let result=buildSyncPreview(core.parseCsv(original),members,state,"qa-source");
  expect(result.preview.counts).toMatchObject({amountsUpdated:1,unchanged:2});expect(result.preview.totals[0]).toMatchObject({beforeMinor:11500,afterMinor:11300,sheetMinor:11300});
  result=buildSyncPreview(core.parseCsv(original.replace("Mensual,10","Mensual,13")),members,state,"qa-source");
  expect(result.preview.counts.amountsUpdated).toBe(1);expect(result.preview.totals[0].afterMinor).toBe(11600);
});
test("reading a preview performs no financial or member writes and records only a safe OWNER preview audit",async()=>{
  const before=JSON.stringify(await store.read());const write=jest.spyOn(store,"write");
  const response=await handler(event({action:"sync-preview"}));expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body).preview.previewToken).toMatch(/^[a-f0-9]{64}$/);expect(write).not.toHaveBeenCalled();
  expect(JSON.stringify(await store.read())).toBe(before);expect((await db.listAdminAuditLogs()).map(a=>[a.action,a.admin_role])).toEqual([["sheet_sync_previewed","owner"]]);expect(await db.listMembers()).toEqual(members);
});
test("apply without a preview is rejected before reading the source or changing data",async()=>{
  expect((await handler(event({action:"sync"}))).statusCode).toBe(400);expect(global.fetch).not.toHaveBeenCalled();expect((await store.read()).profiles).toEqual([]);
});
test.each(["sheet","commercial price","member plan","ledger"])("a changed %s invalidates the preview before writes",async kind=>{
  await store.write("sync",core.reconcileSheet(core.parseCsv(original),members,"qa-source"),owner);
  const preview=JSON.parse((await handler(event({action:"sync-preview"}))).body).preview;
  if(kind==="sheet")liveCsv=original.replace("Mensual,10","Mensual,12");
  if(kind==="commercial price")await store.write("price",{memberId:"a",amountMinor:1200,currency:"USD",expectedRevision:1,reason:"Owner correction"},owner);
  if(kind==="member plan")jest.spyOn(db,"listMembers").mockResolvedValue(members.map(m=>m.id==="a"?{...m,access_plan:"annual"}:m));
  if(kind==="ledger")await store.write("payment",{memberId:"a",plan:"monthly",amountMinor:1000,currency:"USD",entryId:null,status:"paid",period:"2026-10",type:"NEW_ACCESS",paidAt:"2026-10-16",reason:"Confirmed fixture"},owner);
  const before=JSON.stringify(await store.read());const audits=(await db.listAdminAuditLogs()).length;
  expect((await handler(event({action:"sync",previewToken:preview.previewToken}))).statusCode).toBe(409);
  expect(JSON.stringify(await store.read())).toBe(before);expect((await db.listAdminAuditLogs()).length).toBe(audits);
});
test("applying price changes retains confirmed payments, original ledger entries and member access",async()=>{
  await store.write("sync",core.reconcileSheet(core.parseCsv(original),members,"qa-source"),owner);
  const entry=(await store.read()).transactions.find(t=>t.member_id==="a");
  await store.write("payment",{memberId:"a",plan:"monthly",amountMinor:1000,currency:"USD",entryId:entry.id,status:"paid",period:"2026-10",type:"NEW_ACCESS",paidAt:"2026-10-16",reason:"Owner confirmed fixture"},owner);
  const before=await store.read();liveCsv=original.replace("Mensual,10","Mensual,12");
  const preview=JSON.parse((await handler(event({action:"sync-preview"}))).body).preview;
  expect(preview.counts.amountsUpdated).toBe(1);
  expect((await handler(event({action:"sync",previewToken:preview.previewToken,records:[{fake:true}]}))).statusCode).toBe(200);
  const after=await store.read();expect(after.transactions).toEqual(before.transactions);expect(after.profiles.find(p=>p.member_id==="a").amount_minor).toBe(1200);
  expect(core.dashboard(after,members,{month:"2026-10",currency:"USD"}).summary.collected).toBe(1000);expect(await db.listMembers()).toEqual(members);
});
