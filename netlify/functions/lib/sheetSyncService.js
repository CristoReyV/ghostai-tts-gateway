"use strict";
const db=require("./db");
const store=require("./billingStore");
const core=require("./billingCore");
const {buildSyncPreview}=require("./billingSyncPreview");
const {acquireLease}=require("./sheetSyncLease");
const membersService=require("./memberService");
const {getPepper}=require("./tokenService");
const normalizedActor=admin=>({...admin,id:["system_owner","00000000-0000-0000-0000-000000000000"].includes(admin.id)?null:admin.id});
const owner=admin=>{if(admin?.role!=="owner")throw Object.assign(new Error("Acceso no autorizado."),{statusCode:403});};
async function readSource() {
  const sourceId=process.env.GHOSTAI_BILLING_SHEET_ID;
  if(!sourceId||!/^[\w-]+$/.test(sourceId))throw Object.assign(new Error("Configura la fuente Google Sheet en el servidor."),{statusCode:503});
  try {
    const response=await fetch("https://docs.google.com/spreadsheets/d/"+sourceId+"/export?format=csv&gid=0",{signal:AbortSignal.timeout(12000),headers:{"Cache-Control":"no-cache"}});
    if(!response.ok||!response.headers.get("content-type")?.includes("csv"))throw new Error("SOURCE_UNAVAILABLE");
    const csv=await response.text();if(csv.length>500000)throw new Error("SOURCE_TOO_LARGE");
    return {sourceId,rows:core.parseCsv(csv)};
  } catch (_) {throw Object.assign(new Error("No se pudo leer la tabla. No se realizaron cambios."),{statusCode:503});}
}
async function audit(admin,action,metadata,targetId=null) {
  const actor=normalizedActor(admin);
  return db.logAdminAuditEvent({adminId:actor.id,adminEmail:actor.email,adminRole:actor.role,action,targetId,metadata:{...metadata,adminId:admin.id}});
}
const safeCounts=p=>({rows:p.rows,validRows:p.validRows,newMembers:p.counts.newMembers,amountChanges:p.counts.amountsUpdated,planChanges:p.counts.plansChanged,needsReview:p.counts.needsReview,sourceFingerprint:p.sourceFingerprint});
async function previewSheetSync(admin) {
  owner(admin);
  const [source,members,state]=await Promise.all([readSource(),db.listMembers(),store.read()]);
  const {preview}=buildSyncPreview(source.rows,members,state,source.sourceId);
  await audit(admin,"sheet_sync_previewed",safeCounts(preview));
  return preview;
}
async function applySheetSync(admin,previewToken) {
  owner(admin);
  if(typeof previewToken!=="string"||!/^[a-f0-9]{64}$/.test(previewToken))throw Object.assign(new Error("Abre la vista previa antes de aplicar la sincronización."),{statusCode:400});
  // A failed source read occurs before any lease or business mutation.
  const source=await readSource();
  const lease=await acquireLease(source.sourceId);
  try {
    const [members,state]=await Promise.all([db.listMembers(),store.read()]);
    const planned=buildSyncPreview(source.rows,members,state,source.sourceId),preview=planned.preview;
    if(preview.previewToken!==previewToken)throw Object.assign(new Error("SHEET_SYNC_PREVIEW_CHANGED"),{statusCode:409});
    if(!preview.canApply)throw Object.assign(new Error("No hay filas aplicables o se supera el límite de 1,000 miembros. Revisa la hoja."),{statusCode:400});
    if(preview.counts.newMembers)getPepper();
    let newMembers=0,planChanges=0;
    for(const row of planned.operations.filter(o=>o.willApply)) {
      if(!row.member||row.safePlan)await lease.renew();
      if(!row.member) {
        const result=await membersService.createMemberWithAccess({name:row.name,email:row.email,accessPlan:row.plan});
        // Never return or persist plaintext keys, activation tokens or prepared mail.
        row.member=result.member;newMembers++;
        await audit(admin,"sheet_sync_member_created",{row:row.row,plan:row.plan},result.member.id);
      } else if(row.safePlan) {
        const oldPlan=row.member.access_plan;
        row.member=await membersService.updatePendingMemberAccessPlan(row.member.id,oldPlan,row.plan);planChanges++;
        await audit(admin,"sheet_sync_plan_updated",{oldPlan,newPlan:row.plan},row.member.id);
      }
    }
    await lease.renew();
    const freshMembers=await db.listMembers();
    const allowed=new Set(planned.operations.filter(o=>o.willApply).map(o=>o.email));
    const reconciled=core.reconcileSheet(source.rows,freshMembers,source.sourceId);
    const selected=new Set(freshMembers.filter(m=>allowed.has(m.email.trim().toLowerCase())).map(m=>m.id));
    const records=reconciled.records.filter(r=>selected.has(r.member_id)).map(r=>({...r,expectedProfileRevision:state.profiles.find(p=>p.member_id===r.member_id)?.revision||0}));
    const by=normalizedActor(admin);
    const metadata={...reconciled.metadata,matched:records.length,lastSheetSyncAt:new Date().toISOString(),lastSheetSyncBy:{adminId:by.id,role:"owner"},sourceFingerprint:preview.sourceFingerprint,rowsProcessed:preview.rows,notInSheetMemberIds:planned.notInSheetMemberIds,lastChanges:{newMembers,amountChanges:preview.counts.amountsUpdated,planChanges,needsReview:preview.counts.needsReview},reviews:preview.details.filter(d=>d.classification==="INVALID"||d.reason).map(d=>({row:d.row,classification:d.classification,reason:d.reason}))};
    const result=await store.write("sync",{records,metadata,applyCurrentValues:true,confirmedPreview:true},admin);
    await audit(admin,"sheet_sync_applied",{...safeCounts(preview),newMembers,planChanges});
    return {ok:true,...result,newMembers,planChanges,reconciliation:metadata};
  } finally {try{await lease.release();}catch(_){console.warn("SHEET_SYNC_LEASE_RELEASE_FAILED");}}
}
module.exports={readSource,previewSheetSync,applySheetSync};
