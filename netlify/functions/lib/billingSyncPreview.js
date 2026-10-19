"use strict";
const core = require("./billingCore");
const supported = c => /^(USD|MXN)$/.test(c || "");
const minor = p => p?.amount_minor === null || p?.amount_minor === undefined ? null : Number(p.amount_minor);
const known = p => minor(p) !== null && Number.isSafeInteger(minor(p)) && supported(p.currency);
const sorted = rows => rows.sort((a,b) => String(a[0]).localeCompare(String(b[0])));
function buildSyncPreview(rows, members, state, sourceId) {
  const inspected=[];
  const reconciled=core.reconcileSheet(rows,members,sourceId,r=>inspected.push(r));
  const counts={newMembers:0,amountsUpdated:0,plansChanged:0,unchanged:0,invalid:0,missingAmounts:0,needsReview:0};
  const operations=[],details=[],sourceValues=[];
  const before=members.map(m=>state.profiles.find(p=>p.member_id===m.id)||{member_id:m.id,amount_minor:null,currency:null});
  const projected=new Map(before.map(p=>[p.member_id,{...p}]));
  let validRows=0,existingMembers=0,monthly=0,annual=0,lifetime=0,safePlanChanges=0;
  for(const row of inspected) {
    const emailValid=/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email);
    if(row.name&&emailValid&&!row.duplicate&&row.matches.length<=1&&row.amount!==null&&row.currency) sourceValues.push({amount_minor:row.amount,currency:row.currency});
    const member=row.matches.length===1?row.matches[0]:null;
    const profile=member?state.profiles.find(p=>p.member_id===member.id):null;
    let reason=!row.name?"Nombre ausente":!emailValid?"Correo inválido":row.duplicate?"Correo duplicado en la hoja":row.matches.length>1?"Más de un miembro coincide con el correo":!row.plan?"Plan no soportado: "+(row.rawPlan||"sin plan"):!row.currency?"Moneda no indicada o no soportada":row.amount===null&&!row.amountMissing?"Monto inválido":null;
    const detail={row:row.row,name:row.name||"Fila "+row.row,classification:"INVALID",reason,oldPlan:member?.access_plan||null,newPlan:row.plan||row.rawPlan||null,oldAmountMinor:minor(profile),newAmountMinor:row.amount,currency:row.currency,willApply:false};
    if(reason) {counts.invalid++;counts.needsReview++;details.push(detail);continue;}
    validRows++;if(row.plan==="monthly")monthly++;else if(row.plan==="annual")annual++;else lifetime++;
    if(member)existingMembers++;
    const missing=row.amountMissing;if(missing)counts.missingAmounts++;
    const planChanged=!!member&&member.access_plan!==row.plan;
    const safePlan=planChanged&&member.status==="pending"&&!member.activated_at&&!member.expires_at;
    const willApply=!planChanged||safePlan;
    const amountChanged=!!member&&willApply&&(!profile||minor(profile)!==row.amount||profile.currency!==row.currency);
    if(!member){counts.newMembers++;detail.classification="NEW_MEMBER";}
    else if(planChanged){counts.plansChanged++;detail.classification="PLAN_CHANGED";if(safePlan)safePlanChanges++;}
    else if(missing)detail.classification="MISSING_AMOUNT";
    else if(amountChanged)detail.classification="AMOUNT_CHANGED";
    else {counts.unchanged++;detail.classification="EXISTING_OK";}
    if(amountChanged)counts.amountsUpdated++;
    if(planChanged&&!safePlan){counts.needsReview++;detail.reason="NEEDS_OWNER_REVIEW: el acceso ya no está PENDING. Se conservan plan, monto y vigencia.";}
    else if(missing){counts.needsReview++;detail.reason="SIN MONTO: se excluye del total; no se convierte a cero.";}
    detail.willApply=willApply;
    if(detail.classification!=="EXISTING_OK")details.push(detail);
    operations.push({row:row.row,name:row.name,email:row.email,plan:row.plan,amount:row.amount,currency:row.currency,member,willApply,safePlan});
    if(willApply) {
      const id=member?.id||"new:"+core.digest(row.email);
      projected.set(id,{...(profile||{}),member_id:id,amount_minor:row.amount,currency:row.currency});
    }
  }
  const sheetEmails=new Set(inspected.map(r=>r.email));
  const notInSheet=members.filter(m=>!sheetEmails.has(m.email?.trim().toLowerCase()));
  for(const m of notInSheet)details.push({row:null,name:m.name,classification:"EXISTING_NOT_IN_SHEET",reason:"NO ESTÁ EN TABLA ACTUAL; se conserva el acceso.",oldPlan:m.access_plan,newPlan:null,oldAmountMinor:minor(state.profiles.find(p=>p.member_id===m.id)),newAmountMinor:null,currency:null,willApply:false});
  const after=[...projected.values()];
  const currencies=[...new Set([...before,...after,...sourceValues].map(p=>p.currency).filter(supported))].sort();
  const total=(values,c)=>values.filter(p=>known(p)&&p.currency===c).reduce((sum,p)=>sum+minor(p),0);
  const sourceFingerprint=core.digest({sourceId,rows});
  const previewToken=core.digest({sourceFingerprint,members:sorted(members.map(m=>[m.id,m.email?.trim().toLowerCase(),m.access_plan,m.status,m.activated_at,m.expires_at])),profiles:sorted(state.profiles.map(p=>[p.member_id,p.amount_minor,p.currency,p.revision,p.source_hash])),transactions:sorted(state.transactions.map(t=>[t.id,t.entry_key,t.revision]))});
  const applicable=operations.filter(o=>o.willApply);
  const applicableMemberIds=new Set(applicable.filter(o=>o.member).map(o=>o.member.id));
  const records=reconciled.records.filter(r=>applicableMemberIds.has(r.member_id));
  return {
    preview:{previewToken,sourceFingerprint,rows:reconciled.metadata.rows,validRows,existingMembers,monthly,annual,lifetime,counts,safePlanChanges,applicableRows:applicable.length,canApply:applicable.length>0&&applicable.length<=1000,existingNotInSheet:notInSheet.length,details,lastSync:state.sync||null,totals:currencies.map(currency=>({currency,beforeMinor:total(before,currency),afterMinor:total(after,currency),sheetMinor:total(sourceValues,currency)})),unknownAmounts:{before:before.filter(p=>!known(p)).length,after:after.filter(p=>!known(p)).length}},
    operations,notInSheetMemberIds:notInSheet.map(m=>m.id),
    payload:{records,metadata:{...reconciled.metadata,matched:records.length}},
  };
}
module.exports={buildSyncPreview};
