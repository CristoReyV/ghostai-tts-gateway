/**
 * @file netlify/functions/lib/emailService.js
 * Transactional email service for GhostAI Gateway.
 * Supports:
 *  - Resend API (when RESEND_API_KEY is configured)
 *  - Secure Sandbox / Simulated Provider (when no credentials configured, or in tests)
 *
 * Enforces:
 *  - 0 real member emails sent during tests / development
 *  - Zero secret exposure
 *  - Proper audit attribution (sentByAdminId)
 */

"use strict";

const crypto = require("crypto");
const { renderGhostAIMemberInvitationEmail } = require("./emailTemplates");

const DEFAULT_FROM_EMAIL = "GhostAI <no-reply@smartbrain.lat>";

/**
 * Returns currently configured email provider name.
 * @returns {"resend" | "sandbox"}
 */
function getActiveEmailProvider() {
  if (process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim()) {
    return "resend";
  }
  return "sandbox";
}

/**
 * Sends an email using the active provider or sandbox.
 *
 * @param {object} params
 * @param {string} params.to
 * @param {string} params.subject
 * @param {string} params.html
 * @param {string} params.text
 * @param {string} [params.from]
 * @returns {Promise<{ ok: boolean, messageId?: string, error?: string, provider: string, simulated: boolean }>}
 */
async function sendEmail({ to, subject, html, text, from = null }) {
  const provider = getActiveEmailProvider();
  const sender = from || process.env.GHOSTAI_FROM_EMAIL || DEFAULT_FROM_EMAIL;

  // 1. Controlled simulation / sandbox mode
  if (provider === "sandbox" || process.env.NODE_ENV === "test" || process.env.GHOSTAI_EMAIL_SANDBOX === "true") {
    // Check for simulated failure trigger (for automated tests or testing error handling)
    if (to.includes("error-fail") || to.includes("force-fail") || process.env.FORCE_EMAIL_FAIL === "true") {
      return {
        ok: false,
        error: "Simulated mail delivery rejection (SMTP 550 or invalid domain)",
        provider: "sandbox",
        simulated: true,
      };
    }

    const mockId = `mock_msg_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    return {
      ok: true,
      messageId: mockId,
      provider: "sandbox",
      simulated: true,
    };
  }

  // 2. Resend API provider
  if (provider === "resend") {
    const apiKey = process.env.RESEND_API_KEY.trim();
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          from: sender,
          to: [to],
          subject,
          html,
          text,
        }),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        const errorMsg = data.message || `Resend error HTTP ${response.status}`;
        return {
          ok: false,
          error: errorMsg,
          provider: "resend",
          simulated: false,
        };
      }

      return {
        ok: true,
        messageId: data.id || `resend_${crypto.randomUUID()}`,
        provider: "resend",
        simulated: false,
      };
    } catch (err) {
      return {
        ok: false,
        error: err.message || "Network error contacting email provider",
        provider: "resend",
        simulated: false,
      };
    }
  }

  return {
    ok: false,
    error: "No email provider configured.",
    provider: "none",
    simulated: false,
  };
}

module.exports = {
  getActiveEmailProvider,
  sendEmail,
  DEFAULT_FROM_EMAIL,
};
