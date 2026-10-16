/**
 * @file netlify/functions/lib/adminUserService.js
 * Business logic for Multi-Admin User Management, One-Time Activation, and RBAC.
 */

"use strict";

const crypto = require("crypto");
const db = require("./db");
const { hashPassword, verifyPassword } = require("./passwordService");
const { getPepper } = require("./tokenService");

const ADMIN_TOKEN_PREFIX = "gai_adm_act_";
const ADMIN_INVITE_TTL_DAYS = 7;

function getStudioBaseUrl() {
  const custom = process.env.GHOSTAI_STUDIO_URL || process.env.VITE_STUDIO_URL;
  if (custom && custom.trim()) return custom.trim().replace(/\/$/, "");
  return "https://ghostai-tts-studio.smartbrain.lat";
}

function hashAdminToken(secret) {
  const pepper = getPepper();
  return crypto.createHmac("sha256", pepper).update(secret).digest("hex");
}

/**
 * Invites a new administrator. Only callable by an OWNER.
 * Generates a one-time activation link without storing plaintext passwords.
 *
 * @param {object} params
 * @param {string} params.name
 * @param {string} params.email
 * @param {"owner" | "admin"} params.role
 * @param {object} params.requestingAdmin - Admin performing the action
 * @returns {Promise<{ adminUser: object, activationToken: string, activationLink: string }>}
 */
async function inviteAdminUser({ name, email, role, requestingAdmin }) {
  if (!name || typeof name !== "string" || !name.trim()) {
    const err = new Error("El nombre del administrador es requerido.");
    err.code = "VALIDATION_MISSING_FIELD";
    err.statusCode = 400;
    throw err;
  }

  if (!email || typeof email !== "string" || !email.includes("@")) {
    const err = new Error("Correo electrónico inválido.");
    err.code = "VALIDATION_INVALID_EMAIL";
    err.statusCode = 400;
    throw err;
  }

  const normalizedRole = role === "owner" ? "owner" : "admin";
  const normalizedEmail = email.toLowerCase().trim();

  // Check if admin user already exists
  const existing = await db.getAdminUserByEmail(normalizedEmail);
  if (existing) {
    const err = new Error(`El administrador con correo '${normalizedEmail}' ya existe.`);
    err.code = "ADMIN_ALREADY_EXISTS";
    err.statusCode = 409;
    throw err;
  }

  // Create admin user record
  const adminUser = await db.createAdminUserRecord({
    name: name.trim(),
    email: normalizedEmail,
    role: normalizedRole,
    status: "pending",
    invitedBy: requestingAdmin?.id !== "system_owner" ? requestingAdmin?.id : null,
  });

  // Generate one-time cryptographic activation token
  const publicId = crypto.randomBytes(8).toString("hex");
  const secret = crypto.randomBytes(24).toString("hex");
  const rawToken = `${ADMIN_TOKEN_PREFIX}${publicId}.${secret}`;
  const tokenHash = hashAdminToken(secret);

  const expiresAt = new Date(Date.now() + ADMIN_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await db.createAdminActivationTokenRecord({
    adminId: adminUser.id,
    tokenHash,
    tokenPublicId: publicId,
    expiresAt,
  });

  // Construct activation URL
  const studioBase = getStudioBaseUrl();
  const activationLink = `${studioBase}/admin/activate/${rawToken}`;

  // Audit log
  await db.logAdminAuditEvent({
    adminId: requestingAdmin?.id,
    adminEmail: requestingAdmin?.email,
    adminRole: requestingAdmin?.role,
    action: "admin_created",
    targetId: adminUser.id,
    metadata: {
      invitedEmail: normalizedEmail,
      invitedRole: normalizedRole,
    },
  });

  return {
    adminUser,
    activationToken: rawToken,
    activationLink,
  };
}

/**
 * Activates an admin user using their one-time activation token and sets their password.
 *
 * @param {object} params
 * @param {string} params.token - Raw activation token
 * @param {string} params.password - Plaintext chosen password (min 8 chars)
 * @returns {Promise<{ ok: true, admin: object }>}
 */
async function activateAdminUser({ token, password }) {
  if (!token || typeof token !== "string" || !token.startsWith(ADMIN_TOKEN_PREFIX)) {
    const err = new Error("Token de activación inválido.");
    err.code = "AUTH_INVALID_TOKEN";
    err.statusCode = 400;
    throw err;
  }

  if (!password || typeof password !== "string" || password.length < 8) {
    const err = new Error("La contraseña debe tener al menos 8 caracteres.");
    err.code = "VALIDATION_PASSWORD_TOO_SHORT";
    err.statusCode = 400;
    throw err;
  }

  const parts = token.slice(ADMIN_TOKEN_PREFIX.length).split(".");
  if (parts.length !== 2) {
    const err = new Error("Formato de token de activación inválido.");
    err.code = "AUTH_INVALID_TOKEN";
    err.statusCode = 400;
    throw err;
  }

  const secret = parts[1];
  const tokenHash = hashAdminToken(secret);

  const tokenRecord = await db.getAdminActivationTokenByHash(tokenHash);
  if (!tokenRecord) {
    const err = new Error("Token de activación no encontrado o ya utilizado.");
    err.code = "TOKEN_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  if (tokenRecord.status !== "active") {
    const err = new Error("Este enlace de activación ya ha sido utilizado o revocado.");
    err.code = "TOKEN_ALREADY_CONSUMED";
    err.statusCode = 400;
    throw err;
  }

  if (new Date(tokenRecord.expires_at).getTime() < Date.now()) {
    const err = new Error("Este enlace de activación ha expirado.");
    err.code = "TOKEN_EXPIRED";
    err.statusCode = 400;
    throw err;
  }

  const admin = await db.getAdminUserById(tokenRecord.admin_id);
  if (!admin) {
    const err = new Error("Administrador asociado no encontrado.");
    err.code = "ADMIN_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  // Hash password with scrypt
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  // Consume token
  await db.consumeAdminActivationToken(tokenRecord.id);

  // Update admin user
  const updatedAdmin = await db.updateAdminUser(admin.id, {
    status: "active",
    password_hash: passwordHash,
    activated_at: now,
    last_login_at: now,
  });

  // Audit log
  await db.logAdminAuditEvent({
    adminId: admin.id,
    adminEmail: admin.email,
    adminRole: admin.role,
    action: "admin_activated",
    targetId: admin.id,
    metadata: {
      role: admin.role,
    },
  });

  return {
    ok: true,
    admin: {
      id: updatedAdmin.id,
      name: updatedAdmin.name,
      email: updatedAdmin.email,
      role: updatedAdmin.role,
      status: updatedAdmin.status,
    },
  };
}

/**
 * Authenticates an admin using email and password.
 *
 * @param {string} email
 * @param {string} password
 * @returns {Promise<object>}
 */
async function loginAdminWithPassword(email, password) {
  if (!email || !password || typeof email !== "string" || typeof password !== "string") {
    const err = new Error("Correo y contraseña son requeridos.");
    err.code = "AUTH_INVALID";
    err.statusCode = 400;
    throw err;
  }

  const admin = await db.getAdminUserByEmail(email.toLowerCase().trim());
  if (!admin) {
    const err = new Error("Credenciales administrativas inválidas.");
    err.code = "AUTH_INVALID";
    err.statusCode = 401;
    throw err;
  }

  if (admin.status !== "active") {
    const err = new Error("Esta cuenta de administrador no está activa.");
    err.code = "ADMIN_INACTIVE";
    err.statusCode = 403;
    throw err;
  }

  if (!admin.password_hash) {
    const err = new Error("Esta cuenta requiere activación previa.");
    err.code = "ADMIN_NOT_ACTIVATED";
    err.statusCode = 403;
    throw err;
  }

  const valid = await verifyPassword(password, admin.password_hash);
  if (!valid) {
    const err = new Error("Credenciales administrativas inválidas.");
    err.code = "AUTH_INVALID";
    err.statusCode = 401;
    throw err;
  }

  const now = new Date().toISOString();
  await db.updateAdminUser(admin.id, { last_login_at: now });

  return {
    id: admin.id,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    status: admin.status,
  };
}

/**
 * Updates an admin user's status (active | disabled).
 * Enforces safety rule: Cannot disable self if last active owner.
 *
 * @param {object} params
 * @param {string} params.adminId - Target admin ID
 * @param {"active" | "disabled"} params.status - New status
 * @param {object} params.requestingAdmin - Admin performing the update
 * @returns {Promise<object>}
 */
async function updateAdminStatus({ adminId, status, requestingAdmin }) {
  if (status !== "active" && status !== "disabled") {
    const err = new Error("El estado debe ser 'active' o 'disabled'.");
    err.code = "VALIDATION_INVALID_PARAM";
    err.statusCode = 400;
    throw err;
  }

  const target = await db.getAdminUserById(adminId);
  if (!target) {
    const err = new Error("Administrador no encontrado.");
    err.code = "ADMIN_NOT_FOUND";
    err.statusCode = 404;
    throw err;
  }

  // Safety check: Cannot disable an owner if it is the last active owner
  if (status === "disabled" && target.role === "owner") {
    const activeOwnersCount = await db.countActiveOwners();
    if (activeOwnersCount <= 1) {
      const err = new Error("No se puede desactivar al único OWNER activo del sistema.");
      err.code = "LAST_OWNER_PROTECTION";
      err.statusCode = 400;
      throw err;
    }
  }

  const updated = await db.updateAdminUser(adminId, { status });

  await db.logAdminAuditEvent({
    adminId: requestingAdmin?.id,
    adminEmail: requestingAdmin?.email,
    adminRole: requestingAdmin?.role,
    action: status === "disabled" ? "admin_disabled" : "admin_activated",
    targetId: adminId,
    metadata: {
      targetEmail: target.email,
      targetRole: target.role,
      newStatus: status,
    },
  });

  return updated;
}

module.exports = {
  ADMIN_TOKEN_PREFIX,
  getStudioBaseUrl,
  inviteAdminUser,
  activateAdminUser,
  loginAdminWithPassword,
  updateAdminStatus,
};
