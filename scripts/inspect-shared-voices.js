/**
 * @file scripts/inspect-shared-voices.js
 * Read-only diagnostic script to probe ElevenLabs GET /v1/shared-voices.
 * NEVER makes POST calls, never generates TTS, never adds voices, never leaks API key.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// Load .env safely without printing any values
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

const { probeSharedVoices, listVoices } = require("../netlify/functions/providers/elevenlabs");

async function run() {
  const requestId = "probe-" + Date.now();
  console.log("=== INICIANDO SONDA READ-ONLY A ELEVENLABS /v1/shared-voices ===");

  const pagesData = [];
  const allVoicesMap = new Map(); // deduplicated by voice_id

  let currentPage = 0;
  let hasMore = true;
  let initialResponseMeta = null;
  const maxPages = 15; // safety ceiling

  while (hasMore && currentPage < maxPages) {
    console.log(`Consultando página ${currentPage} (language=es, page_size=100, sort=usage_character_count_1y)...`);
    const result = await probeSharedVoices(
      {
        language: "es",
        pageSize: 100,
        page: currentPage,
        sort: "usage_character_count_1y",
      },
      `${requestId}-p${currentPage}`
    );

    if (!result.ok) {
      console.error(`Error en página ${currentPage}:`, result.error);
      break;
    }

    const data = result.data || {};
    const voices = data.voices || [];

    if (currentPage === 0) {
      initialResponseMeta = {
        status: result.status,
        has_more: data.has_more,
        total_count: data.total_count,
        count_page_0: voices.length,
        raw_keys: Object.keys(data),
      };
    }

    pagesData.push({
      page: currentPage,
      count: voices.length,
      has_more: data.has_more,
    });

    for (const v of voices) {
      if (!allVoicesMap.has(v.voice_id)) {
        allVoicesMap.set(v.voice_id, v);
      }
    }

    hasMore = Boolean(data.has_more);
    if (!hasMore || voices.length === 0) {
      break;
    }

    currentPage++;
    // Small polite delay between sequential pages
    await new Promise((r) => setTimeout(r, 400));
  }

  const allVoices = Array.from(allVoicesMap.values());
  console.log(`\nTotal de páginas consultadas: ${pagesData.length}`);
  console.log(`Total de voces únicas recopiladas: ${allVoices.length}`);

  // Query account voices (/v2/voices) for comparison
  console.log("\nConsultando colección actual de la cuenta (/v2/voices)...");
  const accountResult = await listVoices(`${requestId}-account`);
  const accountVoices = accountResult.ok ? accountResult.voices || [] : [];
  console.log(`Voces en la cuenta (/v2/voices): ${accountVoices.length}`);

  // Detailed Analysis
  // B. Properties
  const directFieldsCount = {};
  const sampleVoice = allVoices[0] || {};
  const allFieldKeys = new Set();

  for (const v of allVoices) {
    for (const k of Object.keys(v)) {
      allFieldKeys.add(k);
      directFieldsCount[k] = (directFieldsCount[k] || 0) + 1;
    }
  }

  // C. Models (Direct & Nested in verified_languages)
  const modelsDirectCount = {};
  const modelsVerifiedLanguagesCount = {};
  for (const v of allVoices) {
    const m = v.model_id || "sin_direct_model_id";
    modelsDirectCount[m] = (modelsDirectCount[m] || 0) + 1;

    if (Array.isArray(v.verified_languages)) {
      v.verified_languages.forEach((vl) => {
        const mid = vl.model_id || "sin_model_id";
        modelsVerifiedLanguagesCount[mid] = (modelsVerifiedLanguagesCount[mid] || 0) + 1;
      });
    }
  }

  // D. Accents & Locales
  const accentsCount = {};
  const localesCount = {};
  const languagesCount = {};
  for (const v of allVoices) {
    const acc = v.accent || "sin_accent";
    accentsCount[acc] = (accentsCount[acc] || 0) + 1;

    const loc = v.locale || "sin_locale";
    localesCount[loc] = (localesCount[loc] || 0) + 1;

    const lang = v.language || "sin_language";
    languagesCount[lang] = (languagesCount[lang] || 0) + 1;
  }

  // E. Use cases & descriptives
  const useCasesCount = {};
  const descriptivesCount = {};
  const categoriesCount = {};
  const gendersCount = {};
  const agesCount = {};

  for (const v of allVoices) {
    const uc = v.use_case || v.use_cases || "sin_use_case";
    if (Array.isArray(uc)) {
      uc.forEach((u) => { useCasesCount[u] = (useCasesCount[u] || 0) + 1; });
    } else {
      useCasesCount[String(uc)] = (useCasesCount[String(uc)] || 0) + 1;
    }

    const desc = v.descriptive || v.descriptives;
    if (Array.isArray(desc)) {
      desc.forEach((d) => { descriptivesCount[d] = (descriptivesCount[d] || 0) + 1; });
    } else if (typeof desc === "string") {
      desc.split(",").forEach((d) => {
        const trimmed = d.trim();
        if (trimmed) descriptivesCount[trimmed] = (descriptivesCount[trimmed] || 0) + 1;
      });
    } else {
      descriptivesCount["sin_descriptive"] = (descriptivesCount["sin_descriptive"] || 0) + 1;
    }

    const cat = v.category || "sin_category";
    categoriesCount[cat] = (categoriesCount[cat] || 0) + 1;

    const gen = v.gender || "sin_gender";
    gendersCount[gen] = (gendersCount[gen] || 0) + 1;

    const ag = v.age || "sin_age";
    agesCount[ag] = (agesCount[ag] || 0) + 1;
  }

  // F. Previews
  let withPreviewCount = 0;
  let withoutPreviewCount = 0;
  for (const v of allVoices) {
    if (v.preview_url && typeof v.preview_url === "string" && v.preview_url.trim().length > 0) {
      withPreviewCount++;
    } else {
      withoutPreviewCount++;
    }
  }

  // Check required fields for Add Shared Voice: public_owner_id, voice_id, name
  let hasRequiredAddFieldsCount = 0;
  for (const v of allVoices) {
    if (v.voice_id && v.public_owner_id && v.name) {
      hasRequiredAddFieldsCount++;
    }
  }

  // Overlap between public shared voices and account voices
  const accountVoiceIds = new Set(accountVoices.map((v) => v.voiceId));
  const overlapVoices = allVoices.filter((v) => accountVoiceIds.has(v.voice_id));

  const outputReport = {
    initialResponseMeta,
    pagesData,
    totalUniqueVoices: allVoices.length,
    allFieldKeys: Array.from(allFieldKeys).sort(),
    directFieldsCount,
    modelsDirectCount,
    modelsVerifiedLanguagesCount,
    languagesCount,
    accentsCount,
    localesCount,
    categoriesCount,
    gendersCount,
    agesCount,
    useCasesCount,
    descriptivesCount,
    withPreviewCount,
    withoutPreviewCount,
    hasRequiredAddFieldsCount,
    accountVoicesCount: accountVoices.length,
    overlapCount: overlapVoices.length,
    overlapVoiceNames: overlapVoices.map((v) => ({ voice_id: v.voice_id, name: v.name })),
    sampleVoiceFirst: sampleVoice,
  };

  const reportPath = path.resolve(__dirname, "shared-voices-audit.json");
  fs.writeFileSync(reportPath, JSON.stringify(outputReport, null, 2), "utf8");
  console.log(`\nAuditoría guardada exitosamente en ${reportPath}`);

  return outputReport;
}

run()
  .then((report) => {
    console.log("\n=== RESUMEN EJECUTIVO ===");
    console.log("HTTP status:", report.initialResponseMeta?.status);
    console.log("Total count reportado por ElevenLabs:", report.initialResponseMeta?.total_count);
    console.log("Voces en page 0:", report.initialResponseMeta?.count_page_0);
    console.log("Has more en page 0:", report.initialResponseMeta?.has_more);
    console.log("Total páginas descargadas:", report.pagesData.length);
    console.log("Total voces únicas:", report.totalUniqueVoices);
    console.log("Voces con preview válido:", report.withPreviewCount);
    console.log("Modelos directos:", report.modelsDirectCount);
    console.log("Modelos en verified_languages:", report.modelsVerifiedLanguagesCount);
    console.log("Acentos encontrados:", report.accentsCount);
    console.log("Casos de uso encontrados:", report.useCasesCount);
    console.log("Descriptores encontrados (top 10):", Object.entries(report.descriptivesCount).slice(0, 10));
    console.log("Voces con public_owner_id + voice_id + name:", report.hasRequiredAddFieldsCount);
    console.log("Solapamiento con cuenta (/v2/voices):", report.overlapCount);
  })
  .catch((err) => {
    console.error("Error ejecutando sonda:", err);
    process.exit(1);
  });
