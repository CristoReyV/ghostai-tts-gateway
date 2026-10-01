const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "X-GhostAI-Gateway": "true"
};

exports.handler = async (event, context) => {
  // Manejo explícito de Preflight CORS (OPTIONS)
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders,
      body: ""
    };
  }

  try {
    if (event.httpMethod !== "GET") {
      return {
        statusCode: 405,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          ok: false,
          service: "ghostai-tts-gateway",
          error: `Method ${event.httpMethod} Not Allowed`
        })
      };
    }

    // Respuesta requerida para GET /health
    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ok: true,
        service: "ghostai-tts-gateway",
        version: "1.0.0"
      })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        ok: false,
        service: "ghostai-tts-gateway",
        error: err.message || "Internal server error"
      })
    };
  }
};
