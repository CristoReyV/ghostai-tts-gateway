"use strict";

const PLAN_LABELS = Object.freeze({monthly:"Mensual",annual:"Anual",lifetime:"De por vida"});
function normalizeAccessPlan(value) {
  const plan=String(value||"").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/\s+/g," ");
  if (["monthly","mensual","mes","1 mes"].includes(plan)) return "monthly";
  if (["annual","anual","ano","1 ano"].includes(plan)) return "annual";
  if (["lifetime","de por vida","vitalicio","vitalicia"].includes(plan)) return "lifetime";
  return null;
}
function requireAccessPlan(value) {
  const plan=normalizeAccessPlan(value);
  if (!plan) throw Object.assign(new Error("Plan inválido. Usa Mensual, Anual o De por vida."),{code:"VALIDATION_INVALID_PLAN",statusCode:400});
  return plan;
}
function accessPlanLabel(value) { return PLAN_LABELS[normalizeAccessPlan(value)]||"Plan desconocido"; }
module.exports={normalizeAccessPlan,requireAccessPlan,accessPlanLabel};
