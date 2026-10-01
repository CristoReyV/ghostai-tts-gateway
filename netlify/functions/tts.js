exports.handler = async (event, context) => {
  // CORS Preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "X-GhostAI-Gateway": "true"
      },
      body: ""
    };
  }

  const defaultHeaders = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "X-GhostAI-Gateway": "true"
  };

  if (event.httpMethod === "GET") {
    return {
      statusCode: 200,
      headers: defaultHeaders,
      body: JSON.stringify({
        service: "GhostAI TTS Gateway",
        status: "ready",
        endpoints: {
          generate: "POST /api/tts",
          health: "GET /api/health"
        },
        supportedEngines: [
          { id: "oasis", name: "Oasis Native Voice", type: "browser-native" },
          { id: "elevenlabs", name: "ElevenLabs API Proxy", type: "cloud" },
          { id: "openai", name: "OpenAI Audio TTS", type: "cloud" }
        ],
        documentation: "https://github.com/CristoReyV/ghostai-tts-gateway"
      })
    };
  }

  if (event.httpMethod === "POST") {
    try {
      const payload = event.body ? JSON.parse(event.body) : {};
      const { text, voiceId = "oasis", provider = "native" } = payload;

      if (!text || text.trim() === "") {
        return {
          statusCode: 400,
          headers: defaultHeaders,
          body: JSON.stringify({
            error: "Bad Request",
            message: "Parameter 'text' is required"
          })
        };
      }

      return {
        statusCode: 200,
        headers: defaultHeaders,
        body: JSON.stringify({
          success: true,
          message: "TTS Gateway request acknowledged",
          voiceId,
          provider,
          charCount: text.length,
          timestamp: new Date().toISOString()
        })
      };
    } catch (err) {
      return {
        statusCode: 400,
        headers: defaultHeaders,
        body: JSON.stringify({
          error: "Invalid JSON body",
          details: err.message
        })
      };
    }
  }

  return {
    statusCode: 405,
    headers: defaultHeaders,
    body: JSON.stringify({ error: "Method Not Allowed" })
  };
};
