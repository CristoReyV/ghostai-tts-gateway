/**
 * @file tests/voice-library.test.js
 * Comprehensive tests for GET /api/tts/voice-library and POST /api/tts/voices/shared/add.
 */

"use strict";

jest.mock("../netlify/functions/providers", () => ({
  getProvider: jest.fn(),
}));

const { getProvider } = require("../netlify/functions/providers");
const { handler: voiceLibraryHandler } = require("../netlify/functions/tts-voice-library");
const { handler: sharedAddHandler } = require("../netlify/functions/tts-voices-shared-add");

const TEST_OPERATOR_TOKEN = "test-operator-token";

function makeEvent(method, params = {}, body = null, auth = `Bearer ${TEST_OPERATOR_TOKEN}`) {
  const headers = { origin: "https://studio.ghostai.io" };
  if (auth !== null && auth !== undefined) {
    headers.authorization = auth;
  }
  return {
    httpMethod: method,
    headers,
    queryStringParameters: params,
    body: body ? JSON.stringify(body) : null,
  };
}

describe("Gateway: GET /api/tts/voice-library", () => {
  let mockGetVoiceLibrary;

  beforeEach(() => {
    mockGetVoiceLibrary = jest.fn().mockResolvedValue({
      ok: true,
      voices: [
        {
          voiceId: "v-shared-1",
          publicOwnerId: "owner-abc",
          name: "Lucía - Narradora",
          language: "es",
          locale: "es-ES",
          accent: "peninsular",
          gender: "female",
          age: "young",
          useCase: "narrative_story",
          descriptive: "calm",
          description: "Voz tranquila para narración",
          category: "professional",
          previewUrl: "https://storage.googleapis.com/preview.mp3",
          clonedByCount: 1500,
          usageCharacterCount1y: 20000000,
          featured: false,
          freeUsersAllowed: true,
          liveModerationEnabled: false,
          noticePeriod: 730,
          rate: 1,
          verifiedLanguages: [],
        },
      ],
      page: 0,
      pageSize: 24,
      hasMore: true,
      totalCount: 8537,
    });

    getProvider.mockReturnValue({
      getVoiceLibrary: mockGetVoiceLibrary,
    });
  });

  test("returns 204 for OPTIONS preflight", async () => {
    const res = await voiceLibraryHandler(makeEvent("OPTIONS"));
    expect(res.statusCode).toBe(204);
  });

  test("rejects POST with 405 Method Not Allowed", async () => {
    const res = await voiceLibraryHandler(makeEvent("POST"));
    expect(res.statusCode).toBe(405);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
  });

  test("returns 200 with default parameters (language=es, page=0, page_size=24)", async () => {
    const res = await voiceLibraryHandler(makeEvent("GET"));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.voices).toHaveLength(1);
    expect(body.page).toBe(0);
    expect(body.pageSize).toBe(24);
    expect(body.hasMore).toBe(true);
    expect(body.totalCount).toBe(8537);

    expect(mockGetVoiceLibrary).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "es",
        page: 0,
        pageSize: 24,
        sort: "usage_character_count_1y",
      }),
      expect.any(String)
    );
  });

  test("caps page_size at maximum 100", async () => {
    await voiceLibraryHandler(makeEvent("GET", { page_size: "500" }));
    expect(mockGetVoiceLibrary).toHaveBeenCalledWith(
      expect.objectContaining({
        pageSize: 100,
      }),
      expect.any(String)
    );
  });

  test("validates non-negative page", async () => {
    const res = await voiceLibraryHandler(makeEvent("GET", { page: "-5" }));
    expect(res.statusCode).toBe(400);
  });

  test("accepts and sanitizes approved filters without arbitrary pass-through", async () => {
    await voiceLibraryHandler(
      makeEvent("GET", {
        language: "es",
        search: "Lucia",
        accent: "peninsular",
        locale: "es-ES",
        gender: "female",
        age: "young",
        use_cases: "narrative_story",
        arbitrary_param: "malicious_injection",
      })
    );

    const callArgs = mockGetVoiceLibrary.mock.calls[0][0];
    expect(callArgs.search).toBe("Lucia");
    expect(callArgs.accent).toBe("peninsular");
    expect(callArgs.locale).toBe("es-ES");
    expect(callArgs.gender).toBe("female");
    expect(callArgs.age).toBe("young");
    expect(callArgs.use_cases).toBe("narrative_story");
    expect(callArgs.arbitrary_param).toBeUndefined();
  });

  test("handles empty voices list (voices=[]) gracefully", async () => {
    mockGetVoiceLibrary.mockResolvedValueOnce({
      ok: true,
      voices: [],
      page: 0,
      pageSize: 24,
      hasMore: false,
      totalCount: 0,
    });

    const res = await voiceLibraryHandler(makeEvent("GET", { search: "NonExistentVoice" }));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.voices).toEqual([]);
    expect(body.hasMore).toBe(false);
    expect(body.totalCount).toBe(0);
  });

  test("never exposes API key in response", async () => {
    const res = await voiceLibraryHandler(makeEvent("GET"));
    expect(res.body).not.toContain("sk_");
    expect(res.body).not.toContain("xi-api-key");
  });

  test("propagates upstream errors properly", async () => {
    mockGetVoiceLibrary.mockResolvedValueOnce({
      ok: false,
      statusCode: 429,
      error: { code: "ELEVENLABS_RATE_LIMIT", message: "Too many requests" },
      requestId: "r-rate",
    });

    const res = await voiceLibraryHandler(makeEvent("GET"));
    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("ELEVENLABS_RATE_LIMIT");
  });
});

describe("Gateway: POST /api/tts/voices/shared/add", () => {
  let mockAddSharedVoice;

  beforeEach(() => {
    process.env.GHOSTAI_STUDIO_AUTH_TOKEN = TEST_OPERATOR_TOKEN;
    mockAddSharedVoice = jest.fn().mockResolvedValue({
      ok: true,
      voiceId: "target-voice-123",
      name: "Mateo - Narrador",
      message: "Voice added successfully to account",
    });

    getProvider.mockReturnValue({
      addSharedVoice: mockAddSharedVoice,
    });
  });

  afterEach(() => {
    delete process.env.GHOSTAI_STUDIO_AUTH_TOKEN;
  });

  test("returns 204 for OPTIONS preflight without auth", async () => {
    const res = await sharedAddHandler(makeEvent("OPTIONS", {}, null, null));
    expect(res.statusCode).toBe(204);
    expect(mockAddSharedVoice).not.toHaveBeenCalled();
  });

  test("rejects POST without auth with 401 AUTH_REQUIRED and provider not called", async () => {
    const res = await sharedAddHandler(
      makeEvent("POST", {}, { voiceId: "v-1", publicOwnerId: "owner-1", name: "Mateo" }, null)
    );
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("AUTH_REQUIRED");
    expect(mockAddSharedVoice).not.toHaveBeenCalled();
  });

  test("rejects POST with incorrect bearer token with 401 AUTH_INVALID and provider not called", async () => {
    const res = await sharedAddHandler(
      makeEvent("POST", {}, { voiceId: "v-1", publicOwnerId: "owner-1", name: "Mateo" }, "Bearer bad-token")
    );
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("AUTH_INVALID");
    expect(mockAddSharedVoice).not.toHaveBeenCalled();
  });

  test("rejects POST with 500 when server GHOSTAI_STUDIO_AUTH_TOKEN is missing (fail closed)", async () => {
    delete process.env.GHOSTAI_STUDIO_AUTH_TOKEN;
    const res = await sharedAddHandler(
      makeEvent("POST", {}, { voiceId: "v-1", publicOwnerId: "owner-1", name: "Mateo" })
    );
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("GATEWAY_NOT_CONFIGURED");
    expect(mockAddSharedVoice).not.toHaveBeenCalled();
  });

  test("rejects GET with 405 Method Not Allowed", async () => {
    const res = await sharedAddHandler(makeEvent("GET"));
    expect(res.statusCode).toBe(405);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("METHOD_NOT_ALLOWED");
  });

  test("requires voiceId, publicOwnerId, and name", async () => {
    // Missing voiceId
    const resNoVoice = await sharedAddHandler(
      makeEvent("POST", {}, { publicOwnerId: "owner-1", name: "Mateo" })
    );
    expect(resNoVoice.statusCode).toBe(400);

    // Missing publicOwnerId
    const resNoOwner = await sharedAddHandler(
      makeEvent("POST", {}, { voiceId: "v-1", name: "Mateo" })
    );
    expect(resNoOwner.statusCode).toBe(400);

    // Missing name
    const resNoName = await sharedAddHandler(
      makeEvent("POST", {}, { voiceId: "v-1", publicOwnerId: "owner-1" })
    );
    expect(resNoName.statusCode).toBe(400);
  });

  test("validates and sanitizes safe identifiers against path traversal", async () => {
    const res = await sharedAddHandler(
      makeEvent("POST", {}, { voiceId: "../../escape", publicOwnerId: "owner-1", name: "Mateo" })
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe("VALIDATION_INVALID_PARAM");
  });

  test("successfully adds shared voice and returns confirmation", async () => {
    const res = await sharedAddHandler(
      makeEvent("POST", {}, {
        voiceId: "v-target-123",
        publicOwnerId: "owner-hex-456",
        name: "Mateo - Narrador",
      })
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.voiceId).toBe("target-voice-123");
    expect(body.name).toBe("Mateo - Narrador");

    expect(mockAddSharedVoice).toHaveBeenCalledWith(
      {
        voiceId: "v-target-123",
        publicOwnerId: "owner-hex-456",
        name: "Mateo - Narrador",
      },
      expect.any(String)
    );
  });

  test("propagates upstream failure without exposing API key", async () => {
    mockAddSharedVoice.mockResolvedValueOnce({
      ok: false,
      statusCode: 404,
      error: { code: "ELEVENLABS_NOT_FOUND", message: "Voice not found" },
      requestId: "r-404",
    });

    const res = await sharedAddHandler(
      makeEvent("POST", {}, {
        voiceId: "nonexistent",
        publicOwnerId: "owner-bad",
        name: "Test",
      })
    );

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain("sk_");
    expect(res.body).not.toContain("xi-api-key");
  });
});
