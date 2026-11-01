"use strict";
const db = require("./db");
const memory = new Map();
async function read(sourceId) {
  if (db.isMemoryMode()) return memory.get(sourceId) || null;
  const { data, error } = await db.getSupabaseClient().from("ghostai_skool_sync").select("*").eq("source_id", sourceId).maybeSingle();
  if (error) throw new Error("SKOOL_SYNC_STORAGE_UNAVAILABLE");
  return data;
}
async function write(sourceId, metadata) {
  const record = { source_id: sourceId, synced_at: new Date().toISOString(), metadata };
  if (db.isMemoryMode()) { memory.set(sourceId, record); return record; }
  const { error } = await db.getSupabaseClient().from("ghostai_skool_sync").upsert(record, { onConflict: "source_id" });
  if (error) throw new Error("SKOOL_SYNC_STORAGE_UNAVAILABLE");
  return record;
}
module.exports = { read, write, _reset: () => memory.clear() };
