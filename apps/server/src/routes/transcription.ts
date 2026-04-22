import { Hono } from "hono";

import { processChunk, processSession } from "../workers/transcription-pipeline";

const transcriptionRouter = new Hono();

/**
 * POST /api/transcription/process/:chunkId
 * Trigger transcription for a specific chunk.
 */
transcriptionRouter.post("/process/:chunkId", async (c) => {
  const chunkId = c.req.param("chunkId");

  const result = await processChunk(chunkId);

  if (result.success) {
    return c.json({
      success: true,
      chunkId: result.chunkId,
      transcriptId: result.transcriptId,
      processingTimeMs: result.processingTimeMs,
    });
  }

  return c.json(
    {
      success: false,
      chunkId: result.chunkId,
      error: result.error,
      processingTimeMs: result.processingTimeMs,
    },
    500,
  );
});

/**
 * POST /api/transcription/process-session/:sessionId
 * Process all unprocessed chunks in a session.
 */
transcriptionRouter.post("/process-session/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");

  const results = await processSession(sessionId);

  const succeeded = results.filter((r) => r.success);
  const failed = results.filter((r) => !r.success);

  return c.json({
    sessionId,
    total: results.length,
    succeeded: succeeded.length,
    failed: failed.length,
    results,
  });
});

export { transcriptionRouter };
