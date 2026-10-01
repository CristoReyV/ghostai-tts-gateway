exports.handler = async (event, context) => {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
    },
    body: JSON.stringify({
      status: "operational",
      service: "GhostAI TTS Gateway",
      version: "1.0.0",
      region: process.env.AWS_REGION || "netlify-global",
      timestamp: new Date().toISOString()
    })
  };
};
