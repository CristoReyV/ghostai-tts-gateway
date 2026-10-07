/**
 * @file cleanupService.js
 * Idempotent cleanup service for expired Temporary Recovery Vault generations.
 *
 * Supported Scheduling Mechanisms:
 *  - Netlify Scheduled Functions (e.g. `exports.handler = schedule('@daily', ...)` or `@hourly`)
 *  - Supabase pg_cron (e.g. `SELECT cron.schedule('cleanup-expired-tts', '0 * * * *', ...)` )
 */

"use strict";

const db = require("./db");
const storage = require("./storageService");
const { logOperationEvent } = require("./db");
const { TtsOperationStage } = require("./errorCatalog");

/**
 * Sweeps and cleans all expired TTS generation sessions and associated MP3 objects.
 * Never touches unexpired sessions.
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   expiredSessionsCount: number,
 *   cleanedFilesCount: number,
 *   error?: string
 * }>}
 */
async function cleanupExpiredTtsGenerations() {
  try {
    const expiredSessions = await db.getExpiredSessions();
    let cleanedFilesCount = 0;

    for (const session of expiredSessions) {
      // 1. Get all items belonging to this session
      const items = await db.listGenerationItems(session.id);
      const pathsToDelete = items
        .map((i) => i.storage_path)
        .filter((p) => p && typeof p === "string");

      // 2. Remove files from storage bucket
      if (pathsToDelete.length > 0) {
        const deleteRes = await storage.deleteAudioFiles(pathsToDelete);
        if (!deleteRes.ok) {
          await logOperationEvent({
            clientId: session.client_id,
            sessionId: session.id,
            stage: TtsOperationStage.CLEANUP,
            eventType: "CLEANUP_STORAGE_DELETE_FAILED",
            errorCode: "CLEANUP_STORAGE_ERROR",
            messageSanitized: deleteRes.error || "Fallo eliminando archivos en storage durante cleanup",
          });
          // Do NOT mark items or session as expired if storage delete failed.
          // Allows next scheduled run to retry cleanly.
          continue;
        }
        cleanedFilesCount += pathsToDelete.length;
      }

      // 3. Mark items as expired
      for (const item of items) {
        await db.createOrUpdateGenerationItem({
          ...item,
          sessionId: session.id,
          clientId: session.client_id,
          narrationId: item.narration_id,
          status: "expired",
          expiresAt: session.expires_at,
        });
      }

      // 4. Mark session as expired
      await db.updateGenerationSession(session.id, {
        status: "expired",
      });

      // 5. Log operation event
      await logOperationEvent({
        clientId: session.client_id,
        sessionId: session.id,
        stage: TtsOperationStage.CLEANUP,
        eventType: "SESSION_CLEANED",
        messageSanitized: `Expired session ${session.id} cleaned (${pathsToDelete.length} files removed).`,
      });
    }

    return {
      ok: true,
      expiredSessionsCount: expiredSessions.length,
      cleanedFilesCount,
    };
  } catch (err) {
    return {
      ok: false,
      expiredSessionsCount: 0,
      cleanedFilesCount: 0,
      error: err.message,
    };
  }
}

module.exports = {
  cleanupExpiredTtsGenerations,
};
