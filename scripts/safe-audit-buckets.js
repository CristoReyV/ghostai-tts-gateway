/**
 * @file scripts/safe-audit-buckets.js
 * Read-only diagnostic script to audit ElevenLabs API voice buckets.
 * NEVER leaks API key, never generates TTS, zero characters consumed.
 */

const fs = require("fs");
const path = require("path");

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

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
  console.error("ELEVENLABS_API_KEY not found in .env");
  process.exit(1);
}

const BASE_URL = "https://api.elevenlabs.io";

async function safeFetch(endpoint) {
  const url = `${BASE_URL}${endpoint}`;
  const res = await fetch(url, {
    headers: { "xi-api-key": apiKey },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed ${endpoint}: ${res.status} ${text}`);
  }
  return res.json();
}

async function run() {
  console.log("=== SAFE AUDIT: ELEVENLABS VOICE BUCKETS ===");

  // 1. Subscription Tier
  let tier = "unknown";
  try {
    const sub = await safeFetch("/v1/user/subscription");
    tier = sub.tier || "free";
    console.log(`Account tier: ${tier}`);
  } catch (err) {
    console.error("Subscription fetch error:", err.message);
  }

  // 2. Fetch buckets
  let sharedVoices = [];
  try {
    const sv = await safeFetch("/v1/shared-voices?language=es&page_size=12&sort=usage_character_count_1y");
    sharedVoices = sv.voices || [];
  } catch (err) {
    console.error("Shared voices error:", err.message);
  }

  const buckets = ["default", "community", "personal", "workspace"];
  const bucketVoices = {};

  for (const b of buckets) {
    try {
      const vData = await safeFetch(`/v2/voices?voice_type=${b}&page_size=100`);
      bucketVoices[b] = vData.voices || [];
    } catch (err) {
      console.error(`Bucket ${b} error:`, err.message);
      bucketVoices[b] = [];
    }
  }

  console.log("\n=== BUCKET COUNTS ===");
  console.log(`shared-voices (page_size=12): ${sharedVoices.length}`);
  console.log(`v2 default:                   ${bucketVoices.default.length}`);
  console.log(`v2 community:                 ${bucketVoices.community.length}`);
  console.log(`v2 personal:                  ${bucketVoices.personal.length}`);
  console.log(`v2 workspace:                 ${bucketVoices.workspace.length}`);

  // Create lookup maps
  const communityMap = new Map(bucketVoices.community.map(v => [v.voice_id, v]));
  const defaultMap = new Map(bucketVoices.default.map(v => [v.voice_id, v]));
  const personalMap = new Map(bucketVoices.personal.map(v => [v.voice_id, v]));
  const workspaceMap = new Map(bucketVoices.workspace.map(v => [v.voice_id, v]));

  console.log("\n=== 12 CARDS FROM /v1/shared-voices AUDIT ===");
  const auditRows = sharedVoices.map((v, idx) => {
    const prefix = v.voice_id ? v.voice_id.slice(0, 8) + "..." : "unknown";
    const inCommunity = communityMap.has(v.voice_id);
    const inDefault = defaultMap.has(v.voice_id);
    const inPersonal = personalMap.has(v.voice_id);
    const inWorkspace = workspaceMap.has(v.voice_id);

    let matchingBucket = "shared-only";
    if (inCommunity) matchingBucket = "v2 community";
    else if (inDefault) matchingBucket = "v2 default";
    else if (inPersonal) matchingBucket = "v2 personal";
    else if (inWorkspace) matchingBucket = "v2 workspace";

    // Provenance
    const voiceOrigin = inCommunity ? "library_copy" : "shared_library";
    // Availability on Free
    const availability = "restricted";

    return {
      index: idx + 1,
      idPrefix: prefix,
      name: v.name,
      category: v.category || "null",
      source: "/v1/shared-voices",
      accountBucket: matchingBucket,
      voiceOrigin,
      isBookmarked: Boolean(v.is_bookmarked),
      inCollection: inCommunity || Boolean(v.is_added_by_user),
      freeUsersAllowed: v.free_users_allowed,
      availableForTiers: v.available_for_tiers || null,
      finalAvailability: availability,
    };
  });

  console.table(auditRows);
}

run().catch(console.error);
