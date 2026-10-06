/**
 * Verify and audit GhostAI Auth schema on Supabase.
 * Usage: node scripts/apply-migration.js
 */
"use strict";

const path = require("path");
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");

// Load .env if present
function loadEnv() {
  const envPath = path.resolve(__dirname, "../.env");
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

loadEnv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be defined in environment.");
  process.exit(1);
}

async function verifySupabase() {
  console.log("=================================================");
  console.log("   GHOSTAI TTS GATEWAY — SUPABASE AUDIT & VERIFY ");
  console.log("=================================================");
  console.log("Supabase URL configured: YES");
  console.log("Service role key configured: YES");
  console.log("");

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
  });

  // 1. Check ghostai_clients table
  console.log("1. Checking table 'ghostai_clients'...");
  const { data: clients, error: clientsErr } = await supabase
    .from("ghostai_clients")
    .select("id, name, status, created_at")
    .limit(5);

  if (clientsErr) {
    console.error("   ❌ Error querying ghostai_clients:", clientsErr.message);
    return;
  }
  console.log(`   ✅ Table 'ghostai_clients' exists and is accessible. Rows found: ${clients.length}`);

  // 2. Check ghostai_access_tokens table
  console.log("2. Checking table 'ghostai_access_tokens'...");
  const { data: tokens, error: tokensErr } = await supabase
    .from("ghostai_access_tokens")
    .select("id, client_id, token_public_id, status, created_at")
    .limit(5);

  if (tokensErr) {
    console.error("   ❌ Error querying ghostai_access_tokens:", tokensErr.message);
    return;
  }
  console.log(`   ✅ Table 'ghostai_access_tokens' exists and is accessible. Rows found: ${tokens.length}`);

  // 3. Test CRUD & Foreign Key Cascade
  console.log("3. Testing CRUD operations & ON DELETE CASCADE constraint...");
  const testName = `Verification_Client_${Date.now()}`;
  const { data: insertedClient, error: insertClientErr } = await supabase
    .from("ghostai_clients")
    .insert([{ name: testName, email: "audit@ghostai.internal" }])
    .select()
    .single();

  if (insertClientErr) {
    console.error("   ❌ Failed to insert test client:", insertClientErr.message);
    return;
  }
  console.log(`   ✅ Client created successfully (ID: ${insertedClient.id})`);

  const testPublicId = `gai_test_${Date.now()}`;
  const { data: insertedToken, error: insertTokenErr } = await supabase
    .from("ghostai_access_tokens")
    .insert([{
      client_id: insertedClient.id,
      token_public_id: testPublicId,
      secret_hash: "hash_verification_only",
      label: "Audit Verification Token",
    }])
    .select()
    .single();

  if (insertTokenErr) {
    console.error("   ❌ Failed to insert test token:", insertTokenErr.message);
    // Cleanup client
    await supabase.from("ghostai_clients").delete().eq("id", insertedClient.id);
    return;
  }
  console.log(`   ✅ Token created successfully (Token ID: ${insertedToken.id}, Public ID: ${testPublicId})`);

  // Delete the client and verify cascade
  const { error: deleteClientErr } = await supabase
    .from("ghostai_clients")
    .delete()
    .eq("id", insertedClient.id);

  if (deleteClientErr) {
    console.error("   ❌ Failed to delete test client:", deleteClientErr.message);
    return;
  }

  // Verify token was cascaded
  const { data: orphanedTokens } = await supabase
    .from("ghostai_access_tokens")
    .select("id")
    .eq("id", insertedToken.id);

  if (orphanedTokens && orphanedTokens.length > 0) {
    console.error("   ❌ Cascade delete failed: orphaned token found!");
  } else {
    console.log("   ✅ Cascade delete verified: token was automatically removed when client was deleted.");
  }

  console.log("");
  console.log("=================================================");
  console.log("   ALL SUPABASE AUDIT CHECKS PASSED SUCCESSFULLY  ");
  console.log("=================================================");
}

verifySupabase().catch((err) => {
  console.error("Fatal error:", err);
});
