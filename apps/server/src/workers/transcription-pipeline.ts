/**
 * Transcription pipeline orchestrator.
 * Processes chunks through: preprocess → transcribe → diarize → LLM cleanup → store.
 */

import { db } from "@my-better-t-app/db";
import { chunks, transcripts } from "@my-better-t-app/db/schema";
import { eq } from "drizzle-orm";

import { preprocessAudio } from "../lib/audio-processor";
import { diarizeSegments } from "../lib/diarization";
import { postProcessTranscript } from "../lib/llm-postprocess";
import { getChunkFromS3 } from "../lib/s3";
import { transcribeAudio } from "../lib/transcription";

export interface PipelineResult {
  chunkId: string;
  success: boolean;
  transcriptId?: string;
  error?: string;
  processingTimeMs: number;
}

/**
 * Process a single chunk through the full pipeline.
 */
export async function processChunk(chunkId: string): Promise<PipelineResult> {
  const startTime = Date.now();

  try {
    // 1. Fetch chunk metadata from DB
    const chunkRows = await db.select().from(chunks).where(eq(chunks.chunkId, chunkId)).limit(1);
    const chunk = chunkRows[0];
    if (!chunk) {
      return { chunkId, success: false, error: "Chunk not found in DB", processingTimeMs: 0 };
    }

    // 2. Mark as processing
    await db.update(chunks).set({ status: "processing" }).where(eq(chunks.chunkId, chunkId));

    // 3. Download from S3
    const audioBytes = await getChunkFromS3(chunk.bucketKey);
    if (!audioBytes) {
      await db
        .update(chunks)
        .set({ status: "failed", errorMessage: "Audio not found in bucket" })
        .where(eq(chunks.chunkId, chunkId));
      return {
        chunkId,
        success: false,
        error: "Audio not found in S3",
        processingTimeMs: Date.now() - startTime,
      };
    }

    // 4. Preprocess audio
    const { processedBytes, hasSpeech } = await preprocessAudio(audioBytes);

    if (!hasSpeech) {
      // Skip transcription for silent chunks
      const transcriptId = crypto.randomUUID();
      await db.insert(transcripts).values({
        id: transcriptId,
        chunkId,
        sessionId: chunk.sessionId,
        rawText: "[silence]",
        cleanedText: "[silence]",
        confidence: 100,
        language: "en",
        processingTimeMs: Date.now() - startTime,
      });

      await db.update(chunks).set({ status: "transcribed" }).where(eq(chunks.chunkId, chunkId));

      return {
        chunkId,
        success: true,
        transcriptId,
        processingTimeMs: Date.now() - startTime,
      };
    }

    // 5. Transcribe
    const transcription = await transcribeAudio(processedBytes);

    // 6. Diarize
    const diarization = await diarizeSegments(transcription.segments, processedBytes);

    // 7. LLM Post-processing
    const postProcessed = await postProcessTranscript(diarization.segments);

    // 8. Store transcript
    const transcriptId = crypto.randomUUID();
    const avgConfidence = transcription.segments.length > 0
      ? Math.round(
          (transcription.segments.reduce((sum, s) => sum + s.confidence, 0) /
            transcription.segments.length) *
            100,
        )
      : 0;

    await db.insert(transcripts).values({
      id: transcriptId,
      chunkId,
      sessionId: chunk.sessionId,
      rawText: postProcessed.originalText,
      cleanedText: postProcessed.cleanedText,
      speakers: JSON.stringify(postProcessed.segments),
      confidence: avgConfidence,
      language: transcription.language,
      processingTimeMs: Date.now() - startTime,
    });

    // 9. Update chunk status
    await db.update(chunks).set({ status: "transcribed" }).where(eq(chunks.chunkId, chunkId));

    return {
      chunkId,
      success: true,
      transcriptId,
      processingTimeMs: Date.now() - startTime,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    await db
      .update(chunks)
      .set({
        status: "failed",
        errorMessage,
      })
      .where(eq(chunks.chunkId, chunkId))
      .catch(() => {});

    return {
      chunkId,
      success: false,
      error: errorMessage,
      processingTimeMs: Date.now() - startTime,
    };
  }
}

/**
 * Process all acked chunks for a session that haven't been transcribed yet.
 */
export async function processSession(sessionId: string): Promise<PipelineResult[]> {
  const ackedChunks = await db
    .select()
    .from(chunks)
    .where(eq(chunks.sessionId, sessionId));

  const unprocessed = ackedChunks.filter(
    (c) => c.status === "acked" || c.status === "failed",
  );

  const results: PipelineResult[] = [];
  for (const chunk of unprocessed) {
    const result = await processChunk(chunk.chunkId);
    results.push(result);
  }

  return results;
}
