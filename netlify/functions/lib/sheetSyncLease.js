"use strict";
const crypto=require("crypto");
const db=require("./db");
const memory=new Map();
async function acquireLease(sourceId) {
  const token=crypto.randomUUID();
  async function call(mode) {
    if(db.isMemoryMode()) {
      const current=memory.get(sourceId),now=Date.now();
      if(mode==="acquire") {if(current&&current.expires>now)return false;memory.set(sourceId,{token,expires:now+120000});return true;}
      if(!current||current.token!==token)return false;
      if(mode==="release"){memory.delete(sourceId);return true;}
      if(current.expires<=now)return false;current.expires=now+120000;return true;
    }
    const {data,error}=await db.getSupabaseClient().rpc("ghostai_sheet_sync_lease",{p_source_id:sourceId,p_token:token,p_mode:mode});
    if(error)throw new Error("SHEET_SYNC_LEASE_UNAVAILABLE");return data===true;
  }
  if(!await call("acquire"))throw Object.assign(new Error("Ya hay una sincronización en curso. Espera y vuelve a previsualizar."),{statusCode:409});
  return {renew:async()=>{if(!await call("renew"))throw Object.assign(new Error("SHEET_SYNC_LEASE_EXPIRED"),{statusCode:409});},release:async()=>{await call("release");}};
}
module.exports={acquireLease,_reset:()=>memory.clear()};
