"use strict";
const db = require("./db");
const BUCKET = "ghostai-personal-keys";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function path(adminId, keyId) {
  if (!UUID.test(adminId) || !UUID.test(keyId)) throw new Error("PERSONAL_KEY_INVALID_ID");
  return `${adminId}/${keyId}.txt`;
}
const bucket = () => db.getSupabaseClient().storage.from(BUCKET);
async function get(adminId, keyId) {
  const { data, error } = await bucket().download(path(adminId, keyId));
  if (error) {
    if (["404", "400"].includes(String(error.statusCode)) && /not found/i.test(error.message)) return null;
    throw new Error("PERSONAL_KEY_STORAGE_FAILED");
  }
  return data.text();
}
async function list(adminId) {
  if (!UUID.test(adminId)) return [];
  const { data, error } = await bucket().list(adminId, { limit: 1000, sortBy: { column: "name", order: "asc" } });
  if (error) throw new Error("PERSONAL_KEY_STORAGE_FAILED");
  return (data || []).filter(item => UUID.test(item.name.replace(/\.txt$/, "")) && item.name.endsWith(".txt")).map(item => item.name.slice(0, -4));
}
async function put(adminId, keyId, ciphertext) {
  const { error } = await bucket().upload(path(adminId, keyId), Buffer.from(ciphertext, "utf8"), { contentType: "text/plain", cacheControl: "0", upsert: true });
  if (error) throw new Error("PERSONAL_KEY_STORAGE_FAILED");
}
module.exports = { get, list, put, UUID, BUCKET };
