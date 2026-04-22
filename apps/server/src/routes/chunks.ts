import { db } from "@my-better-t-app/db";
import { chunks, transcripts } from "@my-better-t-app/db/schema";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";

import { computeChecksum } from "../lib/checksum";
import { chunkExistsInS3, uploadChunkToS3 } from "../lib/s3";
import { processChunk } from "../workers/transcription-pipeline";

const chunksRouter = new Hono();

chunksRouter.post("/upload", async (c) => {
  try {
    let formData: FormData;
    try {
      formData = await c.req.formData();
    } catch (formErr) {
      const msg = formErr instanceof Error ? formErr.message : "Invalid formData";
      console.error("[chunks/upload] formData parse failed:", msg);
      return c.json({ error: "Invalid multipart form data", details: msg }, 400);
    }

    const chunkId = formData.get("chunkId");
    const sessionId = formData.get("sessionId");
    const file = formData.get("file");
    const durationMs = formData.get("durationMs");

    if (!chunkId || typeof chunkId !== "string") {
      return c.json({ error: "chunkId is required" }, 400);
    }
    if (!sessionId || typeof sessionId !== "string") {
      return c.json({ error: "sessionId is required" }, 400);
    }
    if (!file || !(file instanceof File)) {
      return c.json({ error: "file is required" }, 400);
    }

    // Idempotency: check if chunk already exists
    let existingChunk: typeof chunks.$inferSelect | undefined;
    try {
      const existing = await db
        .select()
        .from(chunks)
        .where(eq(chunks.chunkId, chunkId))
        .limit(1);
      existingChunk = existing[0];
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : "DB select failed";
      console.error("[chunks/upload] DB select failed:", msg, dbErr);
      return c.json(
        { error: "Database unavailable", details: msg, stage: "select" },
        500,
      );
    }

    if (existingChunk) {
      return c.json({
        success: true,
        chunkId,
        status: existingChunk.status,
        message: "Chunk already processed",
        duplicate: true,
      });
    }

    const arrayBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    const checksum = await computeChecksum(bytes);

    const bucketKey = `${sessionId}/${chunkId}.wav`;

    try {
      await uploadChunkToS3(bucketKey, bytes);
    } catch (uploadError) {
      const message = uploadError instanceof Error ? uploadError.message : "S3 upload failed";
      console.error("[chunks/upload] S3 upload failed:", message, uploadError);
      return c.json(
        { error: "Failed to upload to storage", details: message, stage: "s3-upload" },
        500,
      );
    }

    const existsInBucket = await chunkExistsInS3(bucketKey);
    if (!existsInBucket) {
      console.error("[chunks/upload] Storage verification failed for", bucketKey);
      return c.json(
        { error: "Storage verification failed", stage: "s3-verify", bucketKey },
        500,
      );
    }

    try {
      await db
        .insert(chunks)
        .values({
          chunkId,
          sessionId,
          checksum,
          status: "acked",
          bucketKey,
          durationMs: durationMs ? Math.round(Number(durationMs)) : null,
          sampleRate: 16000,
          ackedAt: new Date(),
        })
        .onConflictDoNothing({ target: chunks.chunkId });
    } catch (dbError) {
      const message = dbError instanceof Error ? dbError.message : "DB insert failed";
      console.error("[chunks/upload] DB insert failed:", message, dbError);
      return c.json(
        { error: "Failed to record in database", details: message, stage: "db-insert" },
        500,
      );
    }

    // Fire-and-forget: kick off transcription pipeline for this chunk.
    // Errors are logged inside processChunk and update chunk status to "failed".
    void processChunk(chunkId).catch((err) => {
      const msg = err instanceof Error ? err.message : "Unknown transcription error";
      console.error(`[chunks/upload] auto-transcribe failed for ${chunkId}:`, msg);
    });

    return c.json({
      success: true,
      chunkId,
      status: "acked",
      checksum,
      bucketKey,
      duplicate: false,
      transcriptionQueued: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[chunks/upload] Unhandled error:", message, stack);
    return c.json(
      { error: "Unhandled error in /upload", details: message, stack },
      500,
    );
  }
});

/**
 * GET /api/chunks/status?sessionId=xxx
 * Returns status of all chunks for a session.
 */
chunksRouter.get("/status", async (c) => {
  const sessionId = c.req.query("sessionId");
  if (!sessionId) {
    return c.json({ error: "sessionId query param is required" }, 400);
  }

  const rows = await db.select().from(chunks).where(eq(chunks.sessionId, sessionId));

  return c.json({
    sessionId,
    chunks: rows.map((row) => ({
      chunkId: row.chunkId,
      status: row.status,
      checksum: row.checksum,
      createdAt: row.createdAt,
      ackedAt: row.ackedAt,
    })),
  });
});

/**
 * GET /api/chunks/:chunkId
 * Returns status of a single chunk.
 */
chunksRouter.get("/:chunkId", async (c) => {
  const chunkId = c.req.param("chunkId");
  const rows = await db.select().from(chunks).where(eq(chunks.chunkId, chunkId)).limit(1);

  if (rows.length === 0) {
    return c.json({ error: "Chunk not found" }, 404);
  }

  return c.json({ chunk: rows[0] });
});

/**
 * POST /api/chunks/reconcile
 * Server-side reconciliation: verifies acked chunks exist in S3.
 * Returns missing chunk IDs for re-upload.
 */
chunksRouter.post("/reconcile", async (c) => {
  const body = await c.req.json<{ sessionId?: string; chunkIds?: string[] }>();

  let ackedChunks;
  if (body.sessionId) {
    ackedChunks = await db
      .select()
      .from(chunks)
      .where(eq(chunks.sessionId, body.sessionId));
  } else if (body.chunkIds && body.chunkIds.length > 0) {
    ackedChunks = await db
      .select()
      .from(chunks)
      .where(inArray(chunks.chunkId, body.chunkIds));
  } else {
    return c.json({ error: "sessionId or chunkIds required" }, 400);
  }

  const missingInBucket: string[] = [];
  const verified: string[] = [];

  for (const chunk of ackedChunks) {
    const exists = await chunkExistsInS3(chunk.bucketKey);
    if (exists) {
      verified.push(chunk.chunkId);
    } else {
      missingInBucket.push(chunk.chunkId);
      // Mark as failed so client knows to re-upload
      await db
        .update(chunks)
        .set({ status: "failed", errorMessage: "Missing from bucket" })
        .where(eq(chunks.chunkId, chunk.chunkId));
    }
  }

  return c.json({
    total: ackedChunks.length,
    verified: verified.length,
    missing: missingInBucket,
  });
});

/**
 * GET /api/chunks/transcript/:chunkId
 * Returns transcript for a specific chunk.
 */
chunksRouter.get("/transcript/:chunkId", async (c) => {
  const chunkId = c.req.param("chunkId");
  const rows = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.chunkId, chunkId))
    .limit(1);

  if (rows.length === 0) {
    return c.json({ error: "Transcript not found" }, 404);
  }

  return c.json({ transcript: rows[0] });
});

/**
 * GET /api/chunks/transcripts/:sessionId
 * Returns all transcripts for a session.
 */
chunksRouter.get("/transcripts/:sessionId", async (c) => {
  const sessionId = c.req.param("sessionId");
  const rows = await db
    .select()
    .from(transcripts)
    .where(eq(transcripts.sessionId, sessionId));

  return c.json({ sessionId, transcripts: rows });
});

export { chunksRouter };
