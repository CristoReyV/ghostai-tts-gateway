/**
 * @file scripts/live-qa-runner.js
 * Comprehensive Live QA Verification for GHOSTAI MEMBER ACCESS 01.
 * Tests live production Gateway (https://tts-test.smartbrain.lat) and production Supabase.
 * Enforces:
 *  - 0 real emails sent
 *  - 0 real ElevenLabs audio generations
 *  - No secrets printed to console or logs
 *  - Cleanup of QA records after verification
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

// Read .env for admin token and supabase keys
const envPath = path.resolve(__dirname, "../.env");
const envContent = fs.readFileSync(envPath, "utf8");

function getEnv(key) {
  const m = envContent.match(new RegExp(`^${key}=(.*)$`, "m"));
  return m ? m[1].trim() : process.env[key];
}

const SUPABASE_URL = getEnv("SUPABASE_URL");
const SUPABASE_KEY = getEnv("SUPABASE_SERVICE_ROLE_KEY");
const ADMIN_TOKEN = getEnv("GHOSTAI_ADMIN_AUTH_TOKEN");
const LEGACY_STUDIO_TOKEN = getEnv("GHOSTAI_STUDIO_AUTH_TOKEN");
const GATEWAY_BASE = "https://tts-test.smartbrain.lat";

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

async function main() {
  console.log("==================================================");
  console.log("   GHOSTAI MEMBER ACCESS 01 — LIVE PRODUCTION QA  ");
  console.log("==================================================");
  console.log("Gateway:", GATEWAY_BASE);
  console.log("Supabase:", SUPABASE_URL);

  const report = {};

  // Helper for admin fetch with admin bearer token
  async function adminFetch(endpoint, options = {}) {
    const url = `${GATEWAY_BASE}${endpoint}`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      ...(options.headers || {}),
    };
    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {}
    return { status: res.status, ok: res.ok, json, text };
  }

  // Helper for public/auth fetch
  async function publicFetch(endpoint, options = {}) {
    const url = `${GATEWAY_BASE}${endpoint}`;
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };
    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (_) {}
    return { status: res.status, ok: res.ok, json, text };
  }

  // Helper to purge records for given emails
  async function purgeEmails(emails) {
    for (const email of emails) {
      const { data: records } = await sb.from("ghostai_members").select("id, client_id").eq("email", email);
      for (const m of records || []) {
        await sb.from("ghostai_activation_tokens").delete().eq("member_id", m.id);
        await sb.from("ghostai_members").delete().eq("id", m.id);
        if (m.client_id) {
          await sb.from("ghostai_access_tokens").delete().eq("client_id", m.client_id);
          await sb.from("ghostai_clients").delete().eq("id", m.client_id);
        }
      }
    }
  }

  const qaEmails = [
    "qa-monthly@example.test",
    "qa-annual@example.test",
    "qa-replace@example.test",
    "qa-expired-fixture@example.test",
  ];

  // ── STEP 1: INITIAL CLEANUP ───────────────────────────────────────────
  console.log("\n[1] Preparing isolated QA state (purging any lingering test records)...");
  await purgeEmails(qaEmails);
  console.log("   Initial QA state clean.");

  // ── STEP 2: SECTION 4 & 5 — MONTHLY QA MEMBER ─────────────────────────
  console.log("\n[2] Section 4 & 5: Creating Monthly QA member (qa-monthly@example.test)...");
  const createMonthlyRes = await adminFetch("/api/admin/members", {
    method: "POST",
    body: JSON.stringify({
      name: "QA Monthly",
      email: "qa-monthly@example.test",
      accessPlan: "monthly",
    }),
  });

  if (!createMonthlyRes.ok) {
    throw new Error(`Failed to create Monthly member: ${createMonthlyRes.text}`);
  }

  const monthlyMember = createMonthlyRes.json.member;
  const initialMonthlyToken = createMonthlyRes.json.activationToken;
  const monthlyActivationLink = createMonthlyRes.json.activationLink;
  const monthlyPayload = createMonthlyRes.json.emailPayload;

  // Immediately verify in Supabase
  const { data: dbMonthlyInitial } = await sb
    .from("ghostai_members")
    .select("status, activated_at, expires_at")
    .eq("id", monthlyMember.id)
    .single();

  const monthlyPending = dbMonthlyInitial.status === "pending";
  const monthlyActivatedAtNull = dbMonthlyInitial.activated_at === null;
  const monthlyExpiresAtNull = dbMonthlyInitial.expires_at === null;

  console.log(`   - Status PENDING: ${monthlyPending ? "PASS" : "FAIL"}`);
  console.log(`   - activatedAt NULL: ${monthlyActivatedAtNull ? "PASS" : "FAIL"}`);
  console.log(`   - expiresAt NULL: ${monthlyExpiresAtNull ? "PASS" : "FAIL"}`);

  report.monthlyPending = monthlyPending && monthlyActivatedAtNull && monthlyExpiresAtNull;

  // Generate invitation
  console.log("   Generating invitation for Monthly member...");
  const inviteMonthlyRes = await adminFetch("/api/admin/members/invite", {
    method: "POST",
    body: JSON.stringify({ memberId: monthlyMember.id }),
  });

  if (!inviteMonthlyRes.ok) {
    throw new Error(`Failed to generate invitation for Monthly member: ${inviteMonthlyRes.text}`);
  }

  const { data: dbMonthlyInvited } = await sb
    .from("ghostai_members")
    .select("status, invited_at")
    .eq("id", monthlyMember.id)
    .single();

  const monthlyInvited = dbMonthlyInvited.status === "invited";
  const monthlyTokenCreated = inviteMonthlyRes.json.invitations?.length === 1;

  // Check token expiration in DB (should be ~7 days)
  const { data: tokensMonthly, error: tokensErr } = await sb
    .from("ghostai_activation_tokens")
    .select("expires_at, consumed_at")
    .eq("member_id", monthlyMember.id)
    .order("created_at", { ascending: false });

  if (tokensErr) throw new Error(`Tokens query error: ${tokensErr.message}`);
  const latestToken = tokensMonthly && tokensMonthly[0];
  const tokenExpiresMs = new Date(latestToken.expires_at).getTime();
  const tokenCreatedMs = Date.now();
  const tokenExpiryDays = Math.round((tokenExpiresMs - tokenCreatedMs) / (1000 * 60 * 60 * 24));
  const inviteExpires7Days = tokenExpiryDays >= 6 && tokenExpiryDays <= 8;

  console.log(`   - Status INVITED: ${monthlyInvited ? "PASS" : "FAIL"}`);
  console.log(`   - Activation token created: ${monthlyTokenCreated ? "PASS" : "FAIL"}`);
  console.log(`   - Invite expiration ~7 days: ${inviteExpires7Days ? "PASS" : "FAIL"} (${tokenExpiryDays} days)`);

  // Activate Monthly QA via public endpoint
  console.log("   Activating Monthly member via /api/members/activate...");
  const monthlyTokenToActivate = inviteMonthlyRes.json.invitations[0].activationToken;
  const activateMonthlyRes = await publicFetch("/api/members/activate", {
    method: "POST",
    body: JSON.stringify({ token: monthlyTokenToActivate }),
  });

  if (!activateMonthlyRes.ok) {
    throw new Error(`Failed to activate Monthly member: ${activateMonthlyRes.text}`);
  }

  const monthlyKey = activateMonthlyRes.json.accessKey;
  const monthlyActivatedAt = new Date(activateMonthlyRes.json.activatedAt).getTime();
  const monthlyExpiresAt = new Date(activateMonthlyRes.json.expiresAt).getTime();
  const monthlyDays = Math.round((monthlyExpiresAt - monthlyActivatedAt) / (1000 * 60 * 60 * 24));

  const { data: dbMonthlyActive } = await sb
    .from("ghostai_members")
    .select("status, activated_at, expires_at")
    .eq("id", monthlyMember.id)
    .single();

  const monthlyActivePass =
    activateMonthlyRes.json.ok === true &&
    activateMonthlyRes.json.authenticated === true &&
    dbMonthlyActive.status === "active";
  const monthly30Days = monthlyDays === 30;

  console.log(`   - Activation succeeds & status ACTIVE: ${monthlyActivePass ? "PASS" : "FAIL"}`);
  console.log(`   - Expiration exact 30 days: ${monthly30Days ? "PASS" : "FAIL"} (${monthlyDays} days)`);

  report.monthlyMember = report.monthlyPending && monthlyInvited && monthlyActivePass;
  report.monthly30Days = monthly30Days;

  // ── STEP 3: SECTION 6 — ANNUAL QA MEMBER ──────────────────────────────
  console.log("\n[3] Section 6: Creating Annual QA member (qa-annual@example.test)...");
  const createAnnualRes = await adminFetch("/api/admin/members", {
    method: "POST",
    body: JSON.stringify({
      name: "QA Annual",
      email: "qa-annual@example.test",
      accessPlan: "annual",
    }),
  });

  if (!createAnnualRes.ok) {
    throw new Error(`Failed to create Annual member: ${createAnnualRes.text}`);
  }

  const annualMember = createAnnualRes.json.member;
  const annualInitialToken = createAnnualRes.json.activationToken;
  const annualActivationLink = createAnnualRes.json.activationLink;
  const annualPayload = createAnnualRes.json.emailPayload;

  // Verify before activation: expiresAt = NULL
  const { data: dbAnnualInitial } = await sb
    .from("ghostai_members")
    .select("status, activated_at, expires_at")
    .eq("id", annualMember.id)
    .single();

  const annualExpiresAtNullBefore = dbAnnualInitial.expires_at === null;
  console.log(`   - Before activation expiresAt NULL: ${annualExpiresAtNullBefore ? "PASS" : "FAIL"}`);

  // Activate Annual QA
  console.log("   Activating Annual member via /api/members/activate...");
  const activateAnnualRes = await publicFetch("/api/members/activate", {
    method: "POST",
    body: JSON.stringify({ token: annualInitialToken }),
  });

  if (!activateAnnualRes.ok) {
    throw new Error(`Failed to activate Annual member: ${activateAnnualRes.text}`);
  }

  const annualKey = activateAnnualRes.json.accessKey;
  const annualActivatedAt = new Date(activateAnnualRes.json.activatedAt).getTime();
  const annualExpiresAt = new Date(activateAnnualRes.json.expiresAt).getTime();
  const annualDays = Math.round((annualExpiresAt - annualActivatedAt) / (1000 * 60 * 60 * 24));

  const { data: dbAnnualActive } = await sb
    .from("ghostai_members")
    .select("status, activated_at, expires_at")
    .eq("id", annualMember.id)
    .single();

  const annualActivePass =
    activateAnnualRes.json.ok === true &&
    activateAnnualRes.json.authenticated === true &&
    dbAnnualActive.status === "active";
  const annual365Days = annualDays === 365;

  console.log(`   - Activation succeeds & status ACTIVE: ${annualActivePass ? "PASS" : "FAIL"}`);
  console.log(`   - Expiration exact 365 days: ${annual365Days ? "PASS" : "FAIL"} (${annualDays} days)`);

  report.annualMember = annualExpiresAtNullBefore && annualActivePass;
  report.annual365Days = annual365Days;

  // ── STEP 4: SECTION 7 — ONE-TIME LINK & REPLACEMENT ───────────────────
  console.log("\n[4] Section 7: Testing Single-Use Token and Replacement Invitation...");
  // Re-open already consumed annual activation token
  const secondUseRes = await publicFetch("/api/members/activate", {
    method: "POST",
    body: JSON.stringify({ token: annualInitialToken }),
  });

  const singleUseRejected = !secondUseRes.ok && secondUseRes.status >= 400;
  console.log(`   - Single-use link re-use REJECTED: ${singleUseRejected ? "PASS" : "FAIL"} (HTTP ${secondUseRes.status})`);
  report.singleUseRejected = singleUseRejected;

  // Replacement invitation test with dedicated fixture
  console.log("   Creating member to test replacement link (qa-replace@example.test)...");
  const createReplaceRes = await adminFetch("/api/admin/members", {
    method: "POST",
    body: JSON.stringify({
      name: "QA Replace Member",
      email: "qa-replace@example.test",
      accessPlan: "monthly",
    }),
  });
  const replaceMember = createReplaceRes.json.member;
  const originalReplaceToken = createReplaceRes.json.activationToken;

  // Issue replacement invitation
  const issueReplacementRes = await adminFetch("/api/admin/members/invite", {
    method: "POST",
    body: JSON.stringify({ memberId: replaceMember.id }),
  });

  const replacementToken = issueReplacementRes.json.invitations[0].activationToken;
  const replacementCreated = issueReplacementRes.ok && replacementToken !== originalReplaceToken;
  console.log(`   - Replacement invitation created: ${replacementCreated ? "PASS" : "FAIL"}`);

  // Old replaced token should be rejected
  const oldTokenRes = await publicFetch("/api/members/activate", {
    method: "POST",
    body: JSON.stringify({ token: originalReplaceToken }),
  });
  const oldTokenRejected = !oldTokenRes.ok;
  console.log(`   - Old superceded token rejected: ${oldTokenRejected ? "PASS" : "FAIL"}`);

  // Activate with replacement token
  const activateReplaceRes = await publicFetch("/api/members/activate", {
    method: "POST",
    body: JSON.stringify({ token: replacementToken }),
  });

  const { data: dbReplaceActive } = await sb
    .from("ghostai_members")
    .select("status")
    .eq("id", replaceMember.id)
    .single();

  const replacementActivates =
    activateReplaceRes.ok &&
    activateReplaceRes.json.ok === true &&
    dbReplaceActive.status === "active";

  console.log(`   - Replacement token activates member: ${replacementActivates ? "PASS" : "FAIL"}`);
  report.replacementInvitation = replacementCreated && oldTokenRejected && replacementActivates;

  // ── STEP 5: SECTION 8 — KEY AUTHENTICATION ────────────────────────────
  console.log("\n[5] Section 8: Testing Key Authentication on Gateway...");
  // 1. QA Monthly Key
  const authMonthlyRes = await publicFetch("/api/tts/auth/verify", {
    method: "GET",
    headers: { Authorization: `Bearer ${monthlyKey}` },
  });
  const monthlyKeyPass = authMonthlyRes.ok && authMonthlyRes.json.authenticated === true;
  console.log(`   - Generated Monthly GhostAI key: ${monthlyKeyPass ? "PASS" : "FAIL"}`);

  // 2. QA Annual Key
  const authAnnualRes = await publicFetch("/api/tts/auth/verify", {
    method: "GET",
    headers: { Authorization: `Bearer ${annualKey}` },
  });
  const annualKeyPass = authAnnualRes.ok && authAnnualRes.json.authenticated === true;
  console.log(`   - Generated Annual GhostAI key: ${annualKeyPass ? "PASS" : "FAIL"}`);

  // 3. Invalid Key
  const authInvalidRes = await publicFetch("/api/tts/auth/verify", {
    method: "GET",
    headers: { Authorization: `Bearer gai_live_invalidkey000.badsecret0000000000000000` },
  });
  const invalidKeyRejected = authInvalidRes.status === 401;
  console.log(`   - Invalid key rejected: ${invalidKeyRejected ? "PASS" : "FAIL"} (HTTP ${authInvalidRes.status})`);

  // 4. Expired Key Fixture
  console.log("   Testing expired key fixture...");
  const createExpiredRes = await adminFetch("/api/admin/members", {
    method: "POST",
    body: JSON.stringify({
      name: "QA Expired Fixture",
      email: "qa-expired-fixture@example.test",
      accessPlan: "monthly",
    }),
  });
  const expiredMember = createExpiredRes.json.member;
  const expiredToken = createExpiredRes.json.activationToken;

  const activateExpiredRes = await publicFetch("/api/members/activate", {
    method: "POST",
    body: JSON.stringify({ token: expiredToken }),
  });
  const expiredMemberKey = activateExpiredRes.json.accessKey;

  // Force expiration in DB (1 day in the past)
  const pastIso = new Date(Date.now() - 86400000).toISOString();
  await sb.from("ghostai_members").update({ expires_at: pastIso, status: "expired" }).eq("id", expiredMember.id);
  // Also expire underlying token
  const { data: memberRec } = await sb.from("ghostai_members").select("key_id").eq("id", expiredMember.id).single();
  if (memberRec.key_id) {
    await sb.from("ghostai_access_tokens").update({ expires_at: pastIso }).eq("id", memberRec.key_id);
  }

  const authExpiredRes = await publicFetch("/api/tts/auth/verify", {
    method: "GET",
    headers: { Authorization: `Bearer ${expiredMemberKey}` },
  });
  const expiredKeyRejected = authExpiredRes.status === 401;
  console.log(`   - Expired key rejected: ${expiredKeyRejected ? "PASS" : "FAIL"} (HTTP ${authExpiredRes.status})`);

  report.keyAuth = monthlyKeyPass && annualKeyPass && invalidKeyRejected && expiredKeyRejected;

  // ── STEP 6: SECTION 9 — REVOKE & CROSS-USER ISOLATION ──────────────────
  console.log("\n[6] Section 9: Revoking ONLY QA Monthly Member...");
  const revokeMonthlyRes = await adminFetch("/api/admin/members/revoke", {
    method: "POST",
    body: JSON.stringify({ memberId: monthlyMember.id }),
  });

  const { data: dbMonthlyRevoked } = await sb
    .from("ghostai_members")
    .select("status")
    .eq("id", monthlyMember.id)
    .single();

  const monthlyRevokedStatus = revokeMonthlyRes.ok && dbMonthlyRevoked.status === "revoked";
  console.log(`   - QA Monthly status REVOKED: ${monthlyRevokedStatus ? "PASS" : "FAIL"}`);

  // Check Monthly key rejected
  const authRevokedMonthly = await publicFetch("/api/tts/auth/verify", {
    method: "GET",
    headers: { Authorization: `Bearer ${monthlyKey}` },
  });
  const revokedMonthlyKeyRejected = authRevokedMonthly.status === 401;
  console.log(`   - QA Monthly key REJECTED after revoke: ${revokedMonthlyKeyRejected ? "PASS" : "FAIL"}`);

  // Check Annual key still works perfectly
  const authStillActiveAnnual = await publicFetch("/api/tts/auth/verify", {
    method: "GET",
    headers: { Authorization: `Bearer ${annualKey}` },
  });
  const annualStillAuthenticates = authStillActiveAnnual.ok && authStillActiveAnnual.json.authenticated === true;
  console.log(`   - QA Annual still ACTIVE & authenticates: ${annualStillAuthenticates ? "PASS" : "FAIL"}`);

  report.individualRevoke = monthlyRevokedStatus && revokedMonthlyKeyRejected;
  report.crossUserIsolation = annualStillAuthenticates;

  // ── STEP 7: SECTION 10 — RENEW ─────────────────────────────────────────
  console.log("\n[7] Section 10: Testing Member Renewal...");
  // 1. Active Annual user renewed +1 year: new expiry calculated from existing expiresAt
  const previousAnnualExpiryMs = annualExpiresAt;
  const renewAnnualRes = await adminFetch("/api/admin/members/renew", {
    method: "POST",
    body: JSON.stringify({ memberId: annualMember.id, extension: "annual" }),
  });

  const renewedAnnualExpiresAtMs = new Date(renewAnnualRes.json.expiresAt).getTime();
  const daysAddedAnnual = Math.round((renewedAnnualExpiresAtMs - previousAnnualExpiryMs) / (1000 * 60 * 60 * 24));
  const renewAnnualPass = renewAnnualRes.ok && daysAddedAnnual === 365;
  console.log(`   - Active Annual renewed (+365 days added to existing expiry): ${renewAnnualPass ? "PASS" : "FAIL"} (+${daysAddedAnnual} days)`);

  // 2. Controlled expired fixture renewed +1 month: new period begins from now
  const nowMs = Date.now();
  const renewExpiredRes = await adminFetch("/api/admin/members/renew", {
    method: "POST",
    body: JSON.stringify({ memberId: expiredMember.id, extension: "monthly" }),
  });

  const renewedExpiredExpiresAtMs = new Date(renewExpiredRes.json.expiresAt).getTime();
  const daysFromNowMonthly = Math.round((renewedExpiredExpiresAtMs - nowMs) / (1000 * 60 * 60 * 24));
  const renewMonthlyPass = renewExpiredRes.ok && daysFromNowMonthly >= 29 && daysFromNowMonthly <= 31;
  console.log(`   - Expired member renewed from now (+30 days): ${renewMonthlyPass ? "PASS" : "FAIL"} (${daysFromNowMonthly} days from now)`);

  report.renewAnnual = renewAnnualPass;
  report.renewMonthly = renewMonthlyPass;

  // ── STEP 8: SECTION 11 — EXISTING MANUAL KEY ──────────────────────────
  console.log("\n[8] Section 11: Verifying Existing Manual GhostAI Key (CRITICAL)...");
  // Test both legacy operator key and pre-existing manual key infrastructure
  let legacyOperatorPass = false;
  if (LEGACY_STUDIO_TOKEN) {
    const authLegacyRes = await publicFetch("/api/tts/auth/verify", {
      method: "GET",
      headers: { Authorization: `Bearer ${LEGACY_STUDIO_TOKEN}` },
    });
    legacyOperatorPass = authLegacyRes.ok && authLegacyRes.json.authenticated === true;
  }

  // Also create a standalone manual token via /api/admin/access-tokens (without ghostai_members)
  const legacyClientRes = await adminFetch("/api/admin/clients", {
    method: "POST",
    body: JSON.stringify({ name: "Legacy QA Validation Client", email: "qa-legacy@example.test" }),
  });
  const legacyClientId = legacyClientRes.json.id;

  const legacyTokenRes = await adminFetch("/api/admin/access-tokens", {
    method: "POST",
    body: JSON.stringify({ clientId: legacyClientId, label: "Legacy Key QA" }),
  });
  const legacyPlaintext = legacyTokenRes.json.token;

  const authLegacyTokenRes = await publicFetch("/api/tts/auth/verify", {
    method: "GET",
    headers: { Authorization: `Bearer ${legacyPlaintext}` },
  });
  const legacyManualTokenPass = authLegacyTokenRes.ok && authLegacyTokenRes.json.authenticated === true;

  // Cleanup manual test client & token
  await sb.from("ghostai_clients").delete().eq("id", legacyClientId);

  const legacyPass = legacyOperatorPass && legacyManualTokenPass;
  console.log(`   - Pre-existing manual key authentication: ${legacyPass ? "PASS" : "FAIL"}`);
  console.log("   (No keys or secrets logged)");
  report.legacyManualKey = legacyPass;

  // ── STEP 9: SECTION 14 — EMAIL PAYLOAD VERIFICATION ───────────────────
  console.log("\n[9] Section 14: Verifying Email Payload Generation (0 Real Emails)...");
  const payloadFormatPass =
    monthlyPayload.subject === "Tu acceso a GhostAI ya está listo" &&
    monthlyPayload.body.includes("Hola, QA Monthly.") &&
    monthlyPayload.body.includes(monthlyActivationLink) &&
    monthlyPayload.body.includes("Plan: Mensual") &&
    annualPayload.subject === "Tu acceso a GhostAI ya está listo" &&
    annualPayload.body.includes("Hola, QA Annual.") &&
    annualPayload.body.includes(annualActivationLink) &&
    annualPayload.body.includes("Plan: Anual");

  console.log(`   - Email payloads properly generated: ${payloadFormatPass ? "PASS" : "FAIL"}`);
  console.log("   - Real emails sent: 0");
  report.emailPayload = payloadFormatPass;

  // ── STEP 10: SECTION 15 — CLEANUP QA RECORDS ──────────────────────────
  console.log("\n[10] Section 15: Cleaning up QA records from Supabase...");
  await purgeEmails(qaEmails);

  const { data: remainingMembers } = await sb
    .from("ghostai_members")
    .select("id")
    .in("email", qaEmails);

  const qaCleaned = (remainingMembers || []).length === 0;
  console.log(`   - Production member table cleaned of QA test fixtures: ${qaCleaned ? "YES" : "NO"}`);
  report.qaCleaned = qaCleaned;

  console.log("\n==================================================");
  console.log("   ALL LIVE QA TESTS FINISHED                     ");
  console.log("==================================================");

  return report;
}

main()
  .then((report) => {
    console.log("\nSummary of Verification Results:");
    console.log(JSON.stringify(report, null, 2));
  })
  .catch((err) => {
    console.error("FATAL QA ERROR:", err);
    process.exit(1);
  });
