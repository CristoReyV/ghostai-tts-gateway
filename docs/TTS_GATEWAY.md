# GhostAI TTS Gateway — Technical Documentation

## Overview

`ghostai-tts-gateway` is a lightweight **serverless backend** deployed on **Netlify Functions** that acts as a secure proxy between GhostAI Studio and Text-to-Speech cloud providers.

GhostAI Studio **never communicates directly** with ElevenLabs. The `xi-api-key` secret exists only on the backend and is never transmitted to the browser.

---

## Architecture

```
GhostAI Frontend (browser)
        │
        │  POST /api/tts/generate  (no API keys)
        │  GET  /api/tts/voices
        │  GET  /api/tts/models
        ▼
┌─────────────────────────────────────────┐
│         ghostai-tts-gateway             │
│          Netlify Functions              │
│                                         │
│  tts-generate.js  ─┐                   │
│  tts-voices.js    ─┤─► providers/      │
│  tts-models.js    ─┘   ├── elevenlabs/ │ ◄── xi-api-key (env only)
│  health.js             └── [future]    │
│                                         │
│  lib/cors.js   (CORS + origin policy)  │
│  lib/errors.js (error normalisation)   │
│  lib/logger.js (structured JSON logs)  │
│  lib/validate.js (request validation)  │
└─────────────────────────────────────────┘
        │
        │  xi-api-key (backend → ElevenLabs only)
        ▼
   https://api.elevenlabs.io
        │
        ▼
   audio/mpeg binary  ──►  GhostAI Frontend
```

---

## Endpoints

### `GET /health` · `GET /api/health` · `GET /api/tts/health`

Liveness and configuration check. Does **not** perform a real TTS request.

```json
{
  "ok": true,
  "service": "ghostai-tts-gateway",
  "version": "1.0.0",
  "provider": "elevenlabs",
  "configured": true
}
```

`configured` is `true` when `ELEVENLABS_API_KEY` is present. The key itself is **never** included in any response.

---

### `POST /api/tts/generate`

Generates TTS audio via the configured provider and returns the audio binary directly.

**Request body:**

```json
{
  "provider": "elevenlabs",
  "voiceId": "ELEVEN_LABS_VOICE_ID",
  "text": "Texto a convertir",
  "modelId": "eleven_multilingual_v2",
  "voiceSettings": {
    "stability": 0.5,
    "similarityBoost": 0.75,
    "style": 0,
    "speed": 1,
    "useSpeakerBoost": true
  },
  "outputFormat": "mp3_44100_128",
  "languageCode": "es"
}
```

Only `provider`, `voiceId`, and `text` are required. All other fields use configured defaults.

**Successful response:**

- `200 OK`
- `Content-Type: audio/mpeg`
- `Content-Length: <bytes>`
- `X-TTS-Provider: elevenlabs`
- `X-TTS-Request-ID: <uuid>`
- `X-TTS-Output-Format: mp3_44100_128`
- Body: binary audio data (`isBase64Encoded: true` for Netlify Functions v1)

**Error response:**

```json
{
  "error": {
    "code": "ELEVENLABS_RATE_LIMIT",
    "message": "ElevenLabs rate limit reached. Please retry later."
  },
  "requestId": "abc-123"
}
```

---

### `GET /api/tts/voices`

Returns the normalised voice list from the provider. Cached in-memory for `ELEVENLABS_CACHE_TTL_MS` ms.

**Query params:** `?provider=elevenlabs` (default: `elevenlabs`)

**Response:**

```json
{
  "voices": [
    {
      "voiceId": "...",
      "name": "Rachel",
      "category": "premade",
      "labels": { "accent": "american" },
      "previewUrl": null
    }
  ],
  "hasMore": false,
  "nextPageToken": null
}
```

---

### `GET /api/tts/models`

Returns TTS-compatible models only (`can_do_text_to_speech === true`). Cached in-memory.

**Response:**

```json
{
  "models": [
    {
      "modelId": "eleven_multilingual_v2",
      "name": "Multilingual v2",
      "description": "...",
      "languages": [{ "code": "es", "name": "Spanish" }],
      "supportsStyle": true,
      "supportsSpeakerBoost": true
    }
  ]
}
```

---

## Environment Variables

See [`.env.example`](./.env.example) for the full template.

| Variable | Required | Default | Description |
|---|---|---|---|
| `ELEVENLABS_API_KEY` | ✅ | — | ElevenLabs secret API key. **Never exposed to client.** |
| `ELEVENLABS_DEFAULT_MODEL_ID` | — | `eleven_multilingual_v2` | Default model when not specified by client |
| `ELEVENLABS_DEFAULT_OUTPUT_FORMAT` | — | `mp3_44100_128` | Default audio format |
| `ELEVENLABS_TIMEOUT_MS` | — | `30000` | HTTP timeout for ElevenLabs calls (ms) |
| `ELEVENLABS_CACHE_TTL_MS` | — | `120000` | In-memory cache TTL for voices/models (ms) |
| `GHOSTAI_ALLOWED_ORIGINS` | — | `*` | Comma-separated allowed CORS origins |
| `TTS_MAX_TEXT_LENGTH` | — | `5000` | Maximum characters per TTS request |

**Set these in Netlify UI:** Site → Site configuration → Environment variables.  
**Never commit `.env` to version control.**

---

## Security

- `ELEVENLABS_API_KEY` is set **only** in `providers/elevenlabs/index.js` when calling `api.elevenlabs.io`.  
  It is never forwarded to the client or logged.
- All error responses use normalised codes — no stack traces, no internal paths, no secrets.
- CORS origin allowlist via `GHOSTAI_ALLOWED_ORIGINS`. When unset, falls back to `*` (development mode only).
- Response headers include `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, and HSTS via `netlify.toml`.
- Client cannot provide its own API key — validation explicitly rejects `apiKey` fields in the request body.

---

## CORS

CORS is handled **inside each function** (not just via static headers) to support the `GHOSTAI_ALLOWED_ORIGINS` allowlist.

The `Access-Control-Expose-Headers` header exposes:
- `X-TTS-Provider`
- `X-TTS-Request-ID`
- `X-TTS-Output-Format`
- `X-GhostAI-Gateway`

All endpoints respond correctly to `OPTIONS` preflight with `204 No Content`.

---

## Error Codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_MISSING_PROVIDER` | 400 | `provider` field absent |
| `VALIDATION_UNKNOWN_PROVIDER` | 400 | Provider not in allowlist |
| `VALIDATION_MISSING_VOICE_ID` | 400 | `voiceId` absent or empty |
| `VALIDATION_MISSING_TEXT` | 400 | `text` absent or whitespace |
| `VALIDATION_TEXT_TOO_LONG` | 400 | Exceeds `TTS_MAX_TEXT_LENGTH` |
| `VALIDATION_INVALID_OUTPUT_FORMAT` | 400 | Format not in allowlist |
| `GATEWAY_NOT_CONFIGURED` | 503 | `ELEVENLABS_API_KEY` not set |
| `ELEVENLABS_UNAUTHORIZED` | 401 | Invalid or missing API key |
| `ELEVENLABS_FORBIDDEN` | 403 | Access denied |
| `ELEVENLABS_NOT_FOUND` | 404 | Voice or model not found |
| `ELEVENLABS_UNPROCESSABLE` | 422 | Invalid parameters |
| `ELEVENLABS_RATE_LIMIT` | 429 | Rate limit reached |
| `ELEVENLABS_SERVER_ERROR` | 502 | ElevenLabs 5xx |
| `ELEVENLABS_TIMEOUT` | 504 | Request timed out |
| `ELEVENLABS_NETWORK_ERROR` | 502 | Network failure |
| `METHOD_NOT_ALLOWED` | 405 | Wrong HTTP method |

---

## Rate Limiting

In the current Netlify Free/Pro tier, rate limiting is handled at the **Netlify edge** level. Inside the function:

- `TTS_MAX_TEXT_LENGTH` prevents excessively large generation requests.
- `ELEVENLABS_TIMEOUT_MS` prevents hung requests from blocking function instances.
- ElevenLabs' own 429 responses are normalised and forwarded as `ELEVENLABS_RATE_LIMIT`.

A custom rate limiting middleware can be added in `lib/rateLimit.js` in the future without touching the provider adapters.

---

## Logging

All logs are structured JSON lines to stdout (Netlify Function logs).

```json
{ "ts": "...", "event": "TTS_REQUEST_START",   "requestId": "...", "provider": "...", "voiceId": "...", "modelId": "...", "textLength": 42 }
{ "ts": "...", "event": "TTS_PROVIDER_REQUEST", "requestId": "..." }
{ "ts": "...", "event": "TTS_PROVIDER_SUCCESS", "requestId": "...", "durationMs": 1234, "responseBytes": 56789 }
{ "ts": "...", "event": "TTS_PROVIDER_ERROR",   "requestId": "...", "status": 429, "durationMs": 120 }
```

`xi-api-key` is stripped from all log outputs by the logger sanitiser.

---

## Tests

```bash
npm test              # run all 65 tests (no real API calls)
npm run test:coverage # with coverage report
```

Test files in `tests/`:

| File | Description |
|---|---|
| `validate.test.js` | Validation layer — 10 cases |
| `elevenlabs-provider.test.js` | Adapter — 20 cases (all errors, caching, binary, key secrecy) |
| `tts-generate.test.js` | Handler — 15 cases (CORS, validation, errors, key secrecy) |
| `tts-voices-models.test.js` | Voices & Models handlers — 10 cases |
| `health.test.js` | Health handler — 7 cases |
| `cors.test.js` | CORS utility — 5 cases |

All ElevenLabs HTTP calls are mocked. **Zero real credits consumed.**

---

## Deployment

1. Push to `main` → Netlify auto-deploys via GitHub integration.
2. Set environment variables in **Netlify UI** → Site configuration → Environment variables.
3. Custom domain `tts-test.smartbrain.lat` is already configured.

### Verifying the deploy

```bash
curl https://tts-test.smartbrain.lat/health
# → { "ok": true, "service": "ghostai-tts-gateway", "configured": true }

curl -X OPTIONS https://tts-test.smartbrain.lat/api/tts/generate -i
# → 204 + CORS headers
```

---

## Adding a New Provider

1. Create `netlify/functions/providers/<name>/index.js` implementing:
   - `generate(request)` → `{ ok, audioBuffer, contentType, durationMs, responseBytes }`
   - `listVoices(requestId)` → `{ ok, voices, hasMore, nextPageToken }`
   - `listModels(requestId)` → `{ ok, models }`
2. Register it in `netlify/functions/providers/index.js`:
   ```js
   const myProvider = require('./<name>');
   const PROVIDERS = { elevenlabs, myprovider: myProvider };
   ```
3. Add its allowed name to `ALLOWED_PROVIDERS` in `lib/validate.js`.
4. Add tests in `tests/<name>-provider.test.js`.
5. Document environment variables in `.env.example`.

> **Note:** Supertonic / ONNX / Transformers.js are intentionally **not** implemented in this backend. If Supertonic is added in the future, it must be a separate provider adapter — not a Worker, not WASM bundled here.

---

## Streaming (Future)

ElevenLabs supports `POST /v1/text-to-speech/:voice_id/stream`. The provider adapter is structured to support a future `generateStream(request)` method without breaking `generate()`. Not implemented in v1.0.
