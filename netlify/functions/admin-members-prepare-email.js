"use strict";
const db = require("./lib/db");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { authorizeAdmin } = require("./lib/adminAuthorization");
const { prepareMemberDelivery } = require("./lib/memberDelivery");
exports.handler = async event => {
 const origin = event.headers?.origin || event.headers?.Origin;
 if (event.httpMethod === "OPTIONS") return preflightResponse(origin);
 const reply = (statusCode, body) => ({statusCode, headers:{...corsHeaders(origin), "Content-Type":"application/json", "Cache-Control":"no-store"}, body:JSON.stringify(body)});
 const auth = await authorizeAdmin(event, "", "member.invitation.preview");
 if (!auth.ok) return reply(auth.statusCode, {error:auth.error});
 if (event.httpMethod !== "POST") return reply(405, {error:{message:"Solo POST."}});
 let body;
 try {body=JSON.parse(event.body||"{}");} catch (_) {return reply(400,{error:{message:"JSON inválido."}});}
 if(typeof body.memberId!=="string" || !body.memberId.trim()) return reply(400,{error:{message:"Miembro requerido."}});
 try {
  const preview=await prepareMemberDelivery(body.memberId.trim());
  await db.logAdminAuditEvent({adminId:auth.admin.id,adminEmail:auth.admin.email,adminRole:auth.admin.role,action:"invite_preview",targetId:body.memberId.trim(),metadata:{deliveryType:preview.deliveryType,keyRedacted:true}});
  return reply(200,{ok:true,zeroRealEmailsSent:true,preview});
 } catch(err) {return reply(err.statusCode||500,{error:{code:err.code||"DELIVERY_UNAVAILABLE",message:err.statusCode?err.message:"No se pudo preparar la entrega segura."}});}
};
