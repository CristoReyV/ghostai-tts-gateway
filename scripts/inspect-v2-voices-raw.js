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
const BASE_URL = "https://api.elevenlabs.io";

async function safeFetch(endpoint) {
  const url = `${BASE_URL}${endpoint}`;
  const res = await fetch(url, { headers: { "xi-api-key": apiKey } });
  return res.json();
}

async function run() {
  console.log("=== INSPECT /v2/voices RAW ===");
  const rawAll = await safeFetch("/v2/voices?page_size=100");
  const voices = rawAll.voices || [];
  console.log(`Total voices in /v2/voices: ${voices.length}`);
  
  if (voices.length > 0) {
    const sample = voices[0];
    console.log("Sample voice keys:", Object.keys(sample));
    console.log("Sample category:", sample.category);
    console.log("Sample sharing keys:", sample.sharing ? Object.keys(sample.sharing) : "null");
  }

  // Count by category
  const categories = {};
  for (const v of voices) {
    const cat = v.category || "null";
    categories[cat] = (categories[cat] || 0) + 1;
  }
  console.log("Categories in /v2/voices:", categories);
}

run().catch(console.error);
