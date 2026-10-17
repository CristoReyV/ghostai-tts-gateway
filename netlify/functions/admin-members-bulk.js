/**
 * @file netlify/functions/admin-members-bulk.js
 * POST /api/admin/members/bulk
 *
 * Bulk member creator and importer endpoint.
 * Accepts an array of members, skips duplicates, creates individual keys and activation tokens,
 * and returns summary statistics according to Section 20.
 *
 * Protected by GHOSTAI_ADMIN_AUTH_TOKEN / admin session.
 */

"use strict";

const crypto = require("crypto");
const { corsHeaders, preflightResponse } = require("./lib/cors");
const { makeError, ERROR_CODES } = require("./lib/errors");
const { authorizeAdmin: requireAdminAuth } = require("./lib/adminAuthorization");
const { createMemberWithAccess } = require("./lib/memberService");
const { validateMemberRows } = require("./lib/memberImportParser");
const db = require("./lib/db");

function jsonResponse(statusCode, body, origin) {
  return {
    statusCode,
    headers: {
      ...corsHeaders(origin),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin;

  if (event.httpMethod === "OPTIONS") return preflightResponse(origin);

  const requestId = crypto.randomUUID();

  // Admin auth guard
  const adminAuth = await requireAdminAuth(event, requestId, "member.create_key");
  if (!adminAuth.ok) {
    return jsonResponse(adminAuth.statusCode, { error: adminAuth.error, requestId }, origin);
  }

  if (event.httpMethod !== "POST") {
    const err = makeError(405, ERROR_CODES.METHOD_NOT_ALLOWED, "Solo POST es aceptado en este endpoint.", requestId);
    return jsonResponse(405, { error: err.error, requestId }, origin);
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch (_) {
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_JSON, "Request body must be valid JSON.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  const { members } = body;
  if (!Array.isArray(members) || members.length === 0) {
    const err = makeError(400, ERROR_CODES.VALIDATION_INVALID_PARAM, "Field 'members' must be a non-empty array.", requestId);
    return jsonResponse(400, { error: err.error, requestId }, origin);
  }

  try {
    // 1. Fetch current members to check duplicates
    const currentMembers = await db.listMembers();

    // 2. Normalize and validate rows
    const validationInput = members.map((m) => ({
      name: m.name || "",
      email: m.email || "",
      accessPlan: m.accessPlan || null,
      rawPlan: m.accessPlan || m.plan || "",
    }));

    const validation = validateMemberRows(validationInput, currentMembers);

    const createdMembers = [];
    const emailPayloads = [];
    const results = [];

    let newCount = 0;
    let existingCount = 0;
    let errorCount = 0;
    let monthlyCount = 0;
    let annualCount = 0;

    // 3. Process each validated row
    for (const row of validation.rows) {
      if (row.isExisting) {
        existingCount++;
        results.push({
          rowNumber: row.rowNumber,
          name: row.name,
          email: row.email,
          status: "ALREADY_EXISTS",
          existingStatus: row.existingMemberStatus,
          message: row.errorMessage,
        });
        continue;
      }

      if (!row.isValid) {
        errorCount++;
        results.push({
          rowNumber: row.rowNumber,
          name: row.name,
          email: row.email,
          status: "ERROR",
          message: row.errorMessage,
        });
        continue;
      }

      try {
        const creation = await createMemberWithAccess({
          name: row.name,
          email: row.email,
          accessPlan: row.accessPlan,
        });

        newCount++;
        if (row.accessPlan === "monthly") monthlyCount++;
        if (row.accessPlan === "annual") annualCount++;

        createdMembers.push(creation.member);
        emailPayloads.push(creation.emailPayload);

        results.push({
          rowNumber: row.rowNumber,
          memberId: creation.member.id,
          name: creation.member.name,
          email: creation.member.email,
          plan: creation.member.access_plan,
          status: "CREATED",
          activationLink: creation.activationLink,
          emailPayload: creation.emailPayload,
        });
      } catch (err) {
        if (err.code === "MEMBER_ALREADY_EXISTS") {
          existingCount++;
          results.push({
            rowNumber: row.rowNumber,
            name: row.name,
            email: row.email,
            status: "ALREADY_EXISTS",
            message: err.message,
          });
        } else {
          errorCount++;
          results.push({
            rowNumber: row.rowNumber,
            name: row.name,
            email: row.email,
            status: "ERROR",
            message: err.message,
          });
        }
      }
    }

    return jsonResponse(
      200,
      {
        ok: true,
        summary: {
          processed: members.length,
          newCount,
          existingCount,
          errorCount,
          monthlyCount,
          annualCount,
        },
        results,
        createdMembers,
        emailPayloads,
        zeroRealEmailsSent: true,
      },
      origin
    );
  } catch (err) {
    const errorPayload = makeError(500, ERROR_CODES.INTERNAL_ERROR, "Error procesando importación masiva de miembros.", requestId);
    return jsonResponse(500, { error: errorPayload.error, requestId }, origin);
  }
};
