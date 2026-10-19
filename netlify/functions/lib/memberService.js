/**
 * @file memberService.js
 * Business logic for Member Access, Cryptographic Invitations, Activation & Expirations.
 * Strictly adheres to individual key generation, zero plaintext secrets in logs,
 * single-use activation tokens, and additive database modeling.
 */

"use strict";

const crypto = require("crypto");
const db = require("./db");
const {requireAccessPlan,accessPlanLabel}=require("./accessPlans");
const { generateClientToken, getPepper, hashSecret } = require("./tokenService");
const { encryptCredential, decryptCredential, isEncryptionConfigured } = require("./credentialCrypto");

const ACTIVATION_TOKEN_PREFIX = "gai_act_";
const INVITATION_EXPIRATION_DAYS = 7;
const MONTHLY_DURATION_DAYS = 30;
const ANNUAL_DURATION_DAYS = 365;

/**
 * Reads the Studio URL used for activation links.
 * @returns {string}
 */
function getStudioBaseUrl() {
  const custom = process.env.GHOSTAI_STUDIO_URL;
  if (custom && typeof custom === "string" && custom.trim()) {
    return custom.trim().replace(/\/+$/, "");
  }
  return "https://ghostai-tts-studio.smartbrain.lat";
}

/**
 * Builds the activation URL for an activation token.
 * @param {string} tokenString
 * @returns {string}
 */
function buildActivationLink(tokenString) {
  const base = getStudioBaseUrl();
  return `${base}/?activate=${encodeURIComponent(tokenString)}`;
}

/**
 * Builds standard email payload according to Section 18.
 * Never sends real emails here.
 *
 * @param {{
 *   memberId: string,
 *   name: string,
 *   email: string,
 *   plan: "monthly" | "annual" | "lifetime",
 *   activationLink: string
 * }} params
 * @returns {{
 *   memberId: string,
 *   name: string,
 *   email: string,
 *   plan: string,
 *   activationLink: string,
 *   subject: string,
 *   body: string
 * }}
 */
function buildEmailPayload({ memberId, name, email, plan, activationLink }) {
  const planLabel = accessPlanLabel(plan);
  const subject = "Tu acceso a GhostAI ya está listo";
  const body = `Hola, ${name}.

Tu acceso a GhostAI ya está listo.

Actívalo desde este enlace:

${activationLink}

Tu acceso es personal.

Plan: ${planLabel}

— GhostAI`;

  return {
    memberId,
    name,
    email,
    plan: planLabel,
    activationLink,
    subject,
    body,
  };
}

/**
 * Helper to safely encrypt a token string.
 * Uses AES-256-GCM from credentialCrypto if configured;
 * otherwise uses pepper-derived AES-256-GCM fallback for testing environments.
 *
 * @param {string} plaintext
 * @returns {string}
 */
function safeEncryptKey(plaintext) {
  if (isEncryptionConfigured()) {
    try {
      return encryptCredential(plaintext);
    } catch (_) {}
  }

  // Fallback using pepper-derived key for test environments where BYOK master key is not explicitly injected
  const pepper = getPepper();
  const derivedKey = crypto.createHash("sha256").update(`ghostai:key-escrow:${pepper}`).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1_escrow.${iv.toString("base64url")}.${ciphertext.toString("base64url")}.${tag.toString("base64url")}`;
}

/**
 * Helper to decrypt a key string.
 *
 * @param {string} encryptedString
 * @returns {string | null}
 */
function safeDecryptKey(encryptedString) {
  if (!encryptedString || typeof encryptedString !== "string") return null;

  if (encryptedString.startsWith("v1_escrow.")) {
    try {
      const parts = encryptedString.split(".");
      if (parts.length !== 4) return null;
      const [, ivB64, ctB64, tagB64] = parts;
      const pepper = getPepper();
      const derivedKey = crypto.createHash("sha256").update(`ghostai:key-escrow:${pepper}`).digest();
      const iv = Buffer.from(ivB64, "base64url");
      const ct = Buffer.from(ctB64, "base64url");
      const tag = Buffer.from(tagB64, "base64url");
      const decipher = crypto.createDecipheriv("aes-256-gcm", derivedKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch (_) {
      return null;
    }
  }

  return decryptCredential(encryptedString);
}

/**
 * Issues a cryptographically random, single-use activation token for a member.
 *
 * @param {string} memberId
 * @param {string} [plaintextKey]
 * @returns {Promise<{
 *   activationToken: string,
 *   tokenPublicId: string,
 *   expiresAt: string,
 *   activationLink: string
 * }>}
 */
async function issueActivationToken(memberId, plaintextKey = null) {
  const randomHex = crypto.randomBytes(24).toString("hex");
  const activationToken = `${ACTIVATION_TOKEN_PREFIX}${randomHex}`;
  const tokenPublicId = randomHex.slice(0, 8);
  const tokenHash = hashSecret(activationToken);

  const expiresAt = new Date(Date.now() + INVITATION_EXPIRATION_DAYS * 86400 * 1000).toISOString();
  let encryptedKey = plaintextKey ? safeEncryptKey(plaintextKey) : null;
  if (!encryptedKey) {
    const prev = await db.getLatestActivationTokenForMember(memberId);
    if (prev && prev.encrypted_key) {
      encryptedKey = prev.encrypted_key;
    }
  }

  // Revoke any previous active activation tokens for this member
  await db.revokeActivationTokensForMember(memberId);

  await db.createActivationTokenRecord({
    memberId,
    tokenHash,
    tokenPublicId,
    encryptedKey,
    encryptedInvitationToken: safeEncryptKey(activationToken),
    expiresAt,
  });

  const activationLink = buildActivationLink(activationToken);
  return {
    activationToken,
    tokenPublicId,
    expiresAt,
    activationLink,
  };
}

/**
 * Creates a new member with:
 *  - Unique client in ghostai_clients
 *  - Unique key in ghostai_access_tokens
 *  - Member record with initial status 'pending'
 *  - Activation token (single use, 7-day expiration)
 *  - Prepared email payload (zero real emails)
 *
 * @param {{
 *   name: string,
 *   email: string,
 *   accessPlan: "monthly" | "annual" | "lifetime" | "Mensual" | "Anual" | "De por vida"
 * }} params
 * @returns {Promise<{
 *   member: object,
 *   activationToken: string,
 *   activationLink: string,
 *   emailPayload: object,
 *   rawKeyOnce?: string
 * }>}
 */
async function createMemberWithAccess({ name, email, accessPlan }) {
  if (!name || typeof name !== "string" || !name.trim()) {
    const err = new Error("El nombre es requerido.");
    err.code = "VALIDATION_MISSING_NAME";
    throw err;
  }

  if (!email || typeof email !== "string" || !email.trim()) {
    const err = new Error("El correo es requerido.");
    err.code = "VALIDATION_MISSING_EMAIL";
    throw err;
  }

  const normalizedEmail = email.trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(normalizedEmail)) {
    const err = new Error("Formato de correo inválido.");
    err.code = "VALIDATION_INVALID_EMAIL";
    throw err;
  }

  const normalizedPlan = requireAccessPlan(accessPlan || "monthly");

  // Check if member already exists
  const existing = await db.getMemberByEmail(normalizedEmail);
  if (existing) {
    const err = new Error(`El miembro con correo '${normalizedEmail}' ya existe.`);
    err.code = "MEMBER_ALREADY_EXISTS";
    err.existingMember = existing;
    throw err;
  }

  // 1. Create client in ghostai_clients
  const client = await db.createClient({
    name: name.trim(),
    email: normalizedEmail,
  });

  // 2. Generate individual client access token via existing tokenService
  const tokenResult = await generateClientToken({
    clientId: client.id,
    label: `GhostAI Member: ${name.trim()}`,
    expiresAt: null, // Expiration will begin upon activation (activatedAt)
  });

  // 3. Create member record in ghostai_members
  const member = await db.createMemberRecord({
    clientId: client.id,
    keyId: tokenResult.tokenId,
    name: name.trim(),
    email: normalizedEmail,
    accessPlan: normalizedPlan,
  });

  // 4. Generate activation token & link
  const activation = await issueActivationToken(member.id, tokenResult.token);

  // 5. Build email payload
  const emailPayload = buildEmailPayload({
    memberId: member.id,
    name: member.name,
    email: member.email,
    plan: member.access_plan,
    activationLink: activation.activationLink,
  });

  // 6. Log audit events
  await db.logOperationEvent({
    stage: "member_access",
    eventType: "member_created",
    clientId: client.id,
    metadata: {
      memberId: member.id,
      email: member.email,
      accessPlan: member.access_plan,
    },
  });

  await db.logOperationEvent({
    stage: "member_access",
    eventType: "key_created",
    clientId: client.id,
    metadata: {
      memberId: member.id,
      keyId: tokenResult.tokenId,
    },
  });

  await db.logOperationEvent({
    stage: "member_access",
    eventType: "invite_created",
    clientId: client.id,
    metadata: {
      memberId: member.id,
      expiresAt: activation.expiresAt,
    },
  });

  return {
    member: {
      ...member,
      keyId: tokenResult.tokenId,
      tokenPublicId: tokenResult.token.split(".")[0].replace("gai_live_", ""),
    },
    activationToken: activation.activationToken,
    activationLink: activation.activationLink,
    emailPayload,
  };
}

/**
 * Validates and consumes an activation token, activates member, and computes expiration.
 *
 * @param {string} tokenString
 * @returns {Promise<{
 *   ok: true,
 *   accessKey: string | null,
 *   clientName: string,
 *   accessPlan: string,
 *   activatedAt: string,
 *   expiresAt: string | null,
 *   memberId: string
 * }>}
 */
async function activateMemberAccess(tokenString) {
  if (!tokenString || typeof tokenString !== "string" || !tokenString.trim()) {
    const err = new Error("Token de activación no proporcionado.");
    err.code = "INVALID_ACTIVATION_TOKEN";
    err.statusCode = 400;
    throw err;
  }

  const cleanToken = tokenString.trim();
  const pepper = getPepper();
  const tokenHash = hashSecret(cleanToken, pepper);

  const record = await db.getActivationTokenByHash(tokenHash);
  if (!record) {
    const err = new Error("Token de activación inválido.");
    err.code = "INVALID_ACTIVATION_TOKEN";
    err.statusCode = 400;
    throw err;
  }

  if (record.status === "consumed" || record.consumed_at) {
    const err = new Error("Este enlace de activación ya fue utilizado.");
    err.code = "TOKEN_ALREADY_USED";
    err.statusCode = 400;
    throw err;
  }

  if (record.status === "revoked") {
    const err = new Error("Este enlace de activación ha sido revocado.");
    err.code = "TOKEN_REVOKED";
    err.statusCode = 400;
    throw err;
  }

  if (new Date(record.expires_at).getTime() <= Date.now()) {
    const err = new Error("Este enlace de activación ha expirado.");
    err.code = "TOKEN_EXPIRED";
    err.statusCode = 400;
    throw err;
  }

  const member = record.member;
  if (!member) {
    const err = new Error("Miembro asociado no encontrado.");
    err.code = "MEMBER_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  if (member.status === "revoked") {
    const err = new Error("El acceso para este miembro ha sido revocado.");
    err.code = "MEMBER_REVOKED";
    err.statusCode = 403;
    throw err;
  }

  if (member.activated_at || member.status === "active") {
    throw Object.assign(new Error("Este acceso ya fue activado. Entra usando tu GhostAI Key."), { code: "TOKEN_ALREADY_USED", statusCode: 409 });
  }
  const accessKey = record.encrypted_key ? safeDecryptKey(record.encrypted_key) : null;
  if (!accessKey) throw Object.assign(new Error("No se pudo recuperar tu key. Contacta al soporte de GhostAI."), { code: "ACTIVATION_KEY_UNAVAILABLE", statusCode: 409 });
  // The guarded consume prevents concurrent activations from restarting the period.
  if (!await db.consumeActivationToken(record.id)) throw Object.assign(new Error("Este enlace ya fue utilizado."), { code: "TOKEN_ALREADY_USED", statusCode: 409 });

  // 2. Calculate activation and expiration timestamps
  // Vigencia comienza en activatedAt!
  const now = new Date();
  const activatedAt = now.toISOString();
  const durationDays = member.access_plan === "annual" ? ANNUAL_DURATION_DAYS : MONTHLY_DURATION_DAYS;
  const durationMs = durationDays * 86400 * 1000;
  const expiresAt = member.access_plan === "lifetime" ? null : new Date(now.getTime() + durationMs).toISOString();

  // 3. Activate member
  const updatedMember = await db.updateMember(member.id, {
    status: "active",
    activated_at: activatedAt,
    expires_at: expiresAt,
  });

  // 4. Update underlying key expiration and status in ghostai_access_tokens
  if (member.key_id) {
    await db.updateTokenExpiresAt(member.key_id, expiresAt);
    await db.updateTokenStatus(member.key_id, "active");
  }

  // 5. Decrypt key if escrowed
  // Escrow remains encrypted for future server-side email delivery.

  // 6. Log audit event
  await db.logOperationEvent({
    stage: "member_access",
    eventType: "member_activated",
    clientId: member.client_id,
    metadata: {
      memberId: member.id,
      activatedAt,
      expiresAt,
      plan: member.access_plan,
    },
  });

  return {
    ok: true,
    accessKey,
    clientName: member.name,
    accessPlan: member.access_plan,
    activatedAt,
    expiresAt,
    memberId: member.id,
  };
}

// Change a pending plan only while activation and expiration remain unset.
async function updatePendingMemberAccessPlan(memberId, expectedPlan, nextPlan) {
  const member = await db.updatePendingMemberPlan(memberId, expectedPlan, nextPlan);
  if (!member) throw Object.assign(new Error("El acceso cambió. Revisa de nuevo el plan."), { statusCode: 409 });
  await db.logOperationEvent({stage:"member_access",eventType:"pending_member_plan_updated",clientId:member.client_id,metadata:{memberId,oldPlan:expectedPlan,newPlan:nextPlan}});
  return member;
}

/**
 * Renews an existing member (+30 days if monthly, +365 days if annual).
 *
 * @param {string} memberId
 * @param {"monthly" | "annual"} [extension]
 * @returns {Promise<object>}
 */
async function renewMemberAccess(memberId, extension = null) {
  const member = await db.getMemberById(memberId);
  if (!member) {
    const err = new Error("Miembro no encontrado.");
    err.code = "MEMBER_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  const updated = await db.renewMember(memberId, extension);

  await db.logOperationEvent({
    stage: "member_access",
    eventType: "member_renewed",
    clientId: member.client_id,
    metadata: {
      memberId,
      newExpiresAt: updated.expires_at,
      plan: extension || member.access_plan,
    },
  });

  return updated;
}

/**
 * Revokes a member and immediately invalidates their key and activation tokens.
 * Other members are completely unaffected.
 *
 * @param {string} memberId
 * @returns {Promise<object>}
 */
async function revokeMemberAccess(memberId) {
  const member = await db.getMemberById(memberId);
  if (!member) {
    const err = new Error("Miembro no encontrado.");
    err.code = "MEMBER_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  const updated = await db.revokeMember(memberId);

  await db.logOperationEvent({
    stage: "member_access",
    eventType: "member_revoked",
    clientId: member.client_id,
    metadata: {
      memberId,
      revokedAt: updated.revoked_at,
    },
  });

  return updated;
}

/**
 * Re-sends an invitation / generates a fresh activation token.
 *
 * @param {string} memberId
 * @returns {Promise<{
 *   activationToken: string,
 *   activationLink: string,
 *   emailPayload: object
 * }>}
 */
async function inviteMember(memberId) {
  const member = await db.getMemberById(memberId);
  if (!member) {
    const err = new Error("Miembro no encontrado.");
    err.code = "MEMBER_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  if (member.status === "revoked") {
    const err = new Error("No se puede invitar a un miembro revocado.");
    err.code = "MEMBER_REVOKED";
    err.statusCode = 400;
    throw err;
  }

  // Issue new activation token
  const activation = await issueActivationToken(memberId);
  const now = new Date().toISOString();

  // If member was 'pending', change status to 'invited'
  const nextStatus = member.status === "pending" ? "invited" : member.status;
  await db.updateMember(memberId, {
    invited_at: now,
    status: nextStatus,
  });

  const emailPayload = buildEmailPayload({
    memberId: member.id,
    name: member.name,
    email: member.email,
    plan: member.access_plan,
    activationLink: activation.activationLink,
  });

  await db.logOperationEvent({
    stage: "member_access",
    eventType: "invite_sent",
    clientId: member.client_id,
    metadata: {
      memberId,
      invitedAt: now,
    },
  });

  return {
    activationToken: activation.activationToken,
    activationLink: activation.activationLink,
    emailPayload,
  };
}

/**
 * Regenerates an individual key for a member.
 *
 * @param {string} memberId
 * @returns {Promise<{
 *   member: object,
 *   activationToken: string,
 *   activationLink: string,
 *   emailPayload: object
 * }>}
 */
async function regenerateMemberKey(memberId) {
  const member = await db.getMemberById(memberId);
  if (!member) {
    const err = new Error("Miembro no encontrado.");
    err.code = "MEMBER_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  // Generate with the official generator; preserve the existing membership period.
  const tokenResult = await generateClientToken({
    clientId: member.client_id,
    label: `GhostAI Member: ${member.name} (Regenerated)`,
    expiresAt: member.expires_at || null,
  });

  const activation = await issueActivationToken(memberId, tokenResult.token);
  // Associate the replacement before revoking the previous key.
  await db.updateMember(memberId, {
    key_id: tokenResult.tokenId,
    last_email_status: "not_sent",
    last_email_sent_at: null,
    last_email_sent_by: null,
    last_email_error: null,
    last_email_type: null,
    last_email_key_id: null,
    last_email_sent_by_name: null,
    last_email_sent_by_role: null,
  });
  if (member.key_id) await db.revokeToken(member.key_id);

  const emailPayload = buildEmailPayload({
    memberId: member.id,
    name: member.name,
    email: member.email,
    plan: member.access_plan,
    activationLink: member.status === "active" ? getStudioBaseUrl() : activation.activationLink,
  });

  await db.logOperationEvent({
    stage: "member_access",
    eventType: "key_regenerated",
    clientId: member.client_id,
    metadata: {
      memberId,
      newKeyId: tokenResult.tokenId,
    },
  });

  const updatedMember = await db.getMemberById(memberId);
  return {
    member: updatedMember,
    activationToken: member.status === "active" ? null : activation.activationToken,
    activationLink: member.status === "active" ? getStudioBaseUrl() : activation.activationLink,
    emailPayload,
  };
}

module.exports = {
  MONTHLY_DURATION_DAYS,
  ANNUAL_DURATION_DAYS,
  INVITATION_EXPIRATION_DAYS,
  ACTIVATION_TOKEN_PREFIX,
  getStudioBaseUrl,
  buildActivationLink,
  buildEmailPayload,
  issueActivationToken,
  createMemberWithAccess,
  activateMemberAccess,
  renewMemberAccess,
  updatePendingMemberAccessPlan,
  revokeMemberAccess,
  inviteMember,
  regenerateMemberKey,
  safeEncryptKey,
  safeDecryptKey,
};
