/**
 * @file netlify/functions/lib/emailTemplates.js
 * GhostAI Email Template Generator.
 * Creates responsive, dark premium HTML emails and plain text fallbacks.
 * Compatible with Gmail, Outlook, Apple Mail, and mobile email clients.
 * Uses strict table layouts and inline CSS.
 * Zero secrets or permanent keys exposed.
 */

"use strict";
const {accessPlanLabel}=require("./accessPlans");

/**
 * Formats access plan label in Spanish.
 * @param {string} plan
 * @returns {string}
 */
function formatPlanLabel(plan) { return accessPlanLabel(plan || "monthly"); }

/**
 * Formats a date into a friendly Spanish date string if valid ISO, or returns as-is.
 * @param {string} dateStr
 * @returns {string}
 */
function formatExpiryDate(dateStr) {
  if (!dateStr) return "7 días";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString("es-ES", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  } catch (_) {
    return dateStr;
  }
}

/**
 * Escapes HTML characters to prevent XSS.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Generates the GhostAIMemberInvitationEmail content (subject, html, text).
 *
 * @param {object} params
 * @param {string} params.name - Member name
 * @param {string} params.email - Member email
 * @param {"monthly" | "annual" | string} params.plan - Access plan
 * @param {string} params.activationLink - One-time personal activation link
 * @param {string} [params.invitationExpiresAt] - ISO date or formatted expiration
 * @returns {{
 *   subject: string,
 *   preheader: string,
 *   html: string,
 *   text: string
 * }}
 */
function renderGhostAIMemberInvitationEmail({
  name,
  email,
  plan,
  activationLink,
  invitationExpiresAt,
  accessKey = null,
  deliveryType = "INVITATION",
  emailType = null,
}) {
  const safeName = escapeHtml(name || "Estimado miembro");
  const planLabel = formatPlanLabel(plan);
  const expiryFormatted = escapeHtml(formatExpiryDate(invitationExpiresAt));
  const safeLink = escapeHtml(activationLink);

  const replacement = deliveryType === "ACCESS_REPLACEMENT";
  const openAccess = deliveryType !== "INVITATION";
  const renewal = emailType === "RENEWAL";
  const heading = replacement ? "Tu acceso a GhostAI fue actualizado" : renewal ? "Tu acceso a GhostAI fue renovado" : openAccess ? "Tu acceso a GhostAI está disponible" : "Tu acceso a GhostAI ya está listo";
  const intro = replacement ? "Tu llave anterior dejó de funcionar. Tu plan y vencimiento se mantienen." : renewal ? "Tu renovación ya está registrada. Puedes seguir usando tu llave personal." : openAccess ? "Vuelve a GhostAI usando tu llave personal." : "Ya puedes activar tu cuenta personal en GhostAI TTS Studio.";
  const visibleKey = accessKey || "gai_live_••••••••.••••••••";
  const safeKey = escapeHtml(visibleKey);
  const ctaLabel = openAccess ? "ABRIR GHOSTAI" : "ACTIVAR Y ENTRAR A GHOSTAI";
  const subject = heading;
  const preheader = openAccess ? "Guarda tu llave y vuelve a GhostAI." : "Activa tu acceso a GhostAI TTS Studio.";

  // Plain Text Version (Section 8)
  const text = `Hola, ${name || "miembro"}.

${heading}. ${intro}

Plan: ${planLabel}

IMPORTANTE — GUARDA TU GHOSTAI KEY
${replacement ? "Guarda tu nueva GhostAI Key:" : "Tu llave personal:"}
${visibleKey}

Guárdala en un lugar seguro. La necesitarás para volver a entrar a GhostAI.
Selecciona y copia esta llave antes de continuar.

${ctaLabel}:
${activationLink}

${replacement ? "Este reemplazo no inicia un nuevo periodo ni modifica tu vencimiento." : openAccess ? "Abrir GhostAI no cambia tu vigencia registrada." : "Este enlace es personal y expira el " + formatExpiryDate(invitationExpiresAt) + "."}

¿Ya utilizaste el enlace o cerraste la pestaña? No pasa nada.
Vuelve a GhostAI e introduce la llave que aparece en este correo.
Si necesitas ayuda con tu acceso, contacta a quien te envió esta invitación.

— GhostAI`;

  // HTML Version (Dark Premium, Email-Safe Tables & Inline Styles)
  const html = `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${escapeHtml(subject)}</title>
  <!--[if mso]>
  <style type="text/css">
    body, table, td, a { font-family: Arial, Helvetica, sans-serif !important; }
  </style>
  <![endif]-->
</head>
<body style="margin: 0; padding: 0; background-color: #0c0d0e; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; color: #f4f4f5;">
  
  <!-- Preheader text (invisible in email body, visible in inbox preview) -->
  <div style="display: none; max-height: 0px; overflow: hidden; font-size: 1px; line-height: 1px; color: #0c0d0e; opacity: 0;">
    ${escapeHtml(preheader)} &zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;
  </div>

  <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #0c0d0e; min-height: 100vh;">
    <tr>
      <td align="center" style="padding: 40px 16px 60px 16px;">
        
        <!-- Main Card Container -->
        <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="max-width: 540px; background-color: #141618; border: 1px solid #23272b; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);">
          
          <!-- Top Brand Accent Header -->
          <tr>
            <td style="height: 4px; background: linear-gradient(90deg, #10b981 0%, #06b6d4 100%); font-size: 0; line-height: 0;">&nbsp;</td>
          </tr>

          <!-- Header Logo -->
          <tr>
            <td align="center" style="padding: 36px 40px 24px 40px; border-bottom: 1px solid #1f2226;">
              <table role="presentation" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td align="center">
                    <span style="display: inline-block; font-size: 18px; font-weight: 800; letter-spacing: 2.5px; color: #ffffff; text-transform: uppercase;">
                      GHOST<span style="color: #10b981;">AI</span>
                    </span>
                    <div style="font-size: 11px; font-weight: 600; letter-spacing: 1.5px; color: #71717a; text-transform: uppercase; margin-top: 4px;">
                      TTS STUDIO
                    </div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Card Body -->
          <tr>
            <td style="padding: 36px 40px 32px 40px;">
              
              <!-- Badge -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin-bottom: 16px;">
                <tr>
                  <td style="background-color: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.25); border-radius: 9999px; padding: 4px 12px;">
                    <span style="font-size: 11px; font-weight: 700; color: #10b981; letter-spacing: 1px; text-transform: uppercase;">
                      ACCESO DISPONIBLE
                    </span>
                  </td>
                </tr>
              </table>

              <!-- Headline -->
              <h1 style="margin: 0 0 12px 0; font-size: 24px; font-weight: 700; color: #ffffff; line-height: 1.3;">
                ${escapeHtml(openAccess ? heading : "Tu acceso ya está listo")}
              </h1>

              <!-- Greeting & Subtext -->
              <p style="margin: 0 0 20px 0; font-size: 15px; color: #d4d4d8; line-height: 1.6;">
                Hola, <strong style="color: #ffffff;">${safeName}</strong>.
              </p>
              <p style="margin: 0 0 28px 0; font-size: 15px; color: #a1a1aa; line-height: 1.6;">
                ${escapeHtml(intro)}
              </p>

              <!-- Plan Details Box -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="background-color: #1a1d21; border: 1px solid #2a2e34; border-radius: 8px; margin-bottom: 32px;">
                <tr>
                  <td style="padding: 16px 20px;">
                    <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%">
                      <tr>
                        <td align="left">
                          <span style="font-size: 12px; font-weight: 600; color: #71717a; text-transform: uppercase; letter-spacing: 0.5px;">PLAN ASIGNADO</span>
                          <div style="font-size: 16px; font-weight: 700; color: #ffffff; margin-top: 2px;">
                            ${escapeHtml(planLabel)}
                          </div>
                        </td>
                        <td align="right">
                          <span style="display: inline-block; background-color: #23272c; color: #10b981; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 4px; border: 1px solid #2f343b;">
                            ${openAccess ? "VIGENCIA REGISTRADA" : "ACTIVO AL INGRESAR"}
                          </span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <table role="presentation" width="100%" style="margin-bottom:28px;border:1px solid #10b981;border-radius:8px;background:#10251f;"><tr><td style="padding:20px;">
                <p style="color:#6ee7b7;font-weight:700;font-size:14px;">IMPORTANTE — GUARDA TU GHOSTAI KEY</p>
                <p style="color:#d4d4d8;">${replacement ? "Guarda tu nueva GhostAI Key:" : "Tu llave personal:"}</p>
                <div style="font-family:monospace;font-size:14px;color:#ffffff;background:#080c14;border:1px solid #2f343b;border-radius:6px;padding:14px;word-break:break-all;user-select:text;">${safeKey}</div>
                <p style="color:#d4d4d8;font-size:13px;line-height:1.6;">Guárdala en un lugar seguro. La necesitarás para volver a entrar a GhostAI.</p>
                <p style="color:#a1a1aa;font-size:13px;">Selecciona y copia esta llave antes de continuar.</p>
              </td></tr></table>
              <!-- Main Call To Action Button -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="margin-bottom: 28px;">
                <tr>
                  <td align="center">
                    <!--[if mso]>
                    <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${safeLink}" style="height:48px;v-text-anchor:middle;width:460px;" arcsize="10%" fillcolor="#10b981" stroke="f">
                      <w:anchorlock/>
                      <center style="color:#ffffff;font-family:sans-serif;font-size:14px;font-weight:bold;letter-spacing:1px;">${ctaLabel}</center>
                    </v:roundrect>
                    <![endif]-->
                    <!--[if !mso]><!-->
                    <a href="${safeLink}" target="_blank" style="display: block; width: 100%; box-sizing: border-box; background-color: #10b981; color: #0a0b0d; font-size: 14px; font-weight: 700; letter-spacing: 1px; text-decoration: none; text-align: center; padding: 15px 24px; border-radius: 6px; text-transform: uppercase;">
                      ${ctaLabel} &rarr;
                    </a>
                    <!--<![endif]-->
                  </td>
                </tr>
              </table>

              <!-- Security Notice -->
              <p style="margin: 0 0 16px 0; font-size: 13px; color: #71717a; line-height: 1.5; text-align: center;">
                ${replacement ? "Este reemplazo no inicia un nuevo periodo ni modifica tu vencimiento." : openAccess ? "Abrir GhostAI no cambia tu vigencia registrada." : `Este enlace es personal y de uso único. Expira el <strong style="color: #a1a1aa;">${expiryFormatted}</strong>.`}
              </p>

              <!-- Fallback URL display -->
              <table role="presentation" border="0" cellpadding="0" cellspacing="0" width="100%" style="border-top: 1px solid #1f2226; margin-top: 24px; padding-top: 20px;">
                <tr>
                  <td>
                    <p style="margin: 0 0 6px 0; font-size: 11px; color: #71717a; line-height: 1.4;">
                      Si el botón no funciona, copia y pega el siguiente enlace directo en tu navegador:
                    </p>
                    <div style="background-color: #0f1011; border: 1px solid #23272b; border-radius: 4px; padding: 10px 12px; font-family: monospace; font-size: 11px; color: #10b981; word-break: break-all; line-height: 1.4;">
                      ${safeLink}
                    </div>
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="background-color: #0f1012; padding: 24px 40px; border-top: 1px solid #1c1e22;">
              <p style="margin: 0 0 6px 0; font-size: 12px; font-weight: 700; color: #a1a1aa; letter-spacing: 1px; text-transform: uppercase;">
                GHOSTAI PLATFORM
              </p>
              <p style="margin: 0; font-size: 11px; color: #52525b; line-height: 1.5;">
                ¿Ya utilizaste el enlace o cerraste la pestaña? No pasa nada.<br>Vuelve a GhostAI e introduce la llave que aparece en este correo.<br>Para ayuda con tu acceso, contacta a quien te envió esta invitación.<br><br>
                Si no esperabas este correo, puedes ignorarlo de manera segura.
              </p>
            </td>
          </tr>

        </table>

      </td>
    </tr>
  </table>

</body>
</html>`;

  return {
    subject,
    preheader,
    html,
    text,
  };
}

module.exports = {
  renderGhostAIMemberInvitationEmail,
  formatPlanLabel,
  formatExpiryDate,
};
