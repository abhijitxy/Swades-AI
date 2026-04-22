/**
 * Transcription service.
 *
 * Preferred order:
 *   1. Groq Whisper API (OpenAI-compatible endpoint) — if GROQ_API_KEY is set
 *   2. Self-hosted faster-whisper-server at WHISPER_API_URL
 *   3. Local `whisper` CLI
 *
 * Each backend is guarded so a missing binary / unreachable host falls
 * through to the next option instead of crashing the pipeline.
 */
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { env } from "@my-better-t-app/env/server";

export interface TranscriptionResult {
  text: string;
  segments: TranscriptionSegment[];
  language: string;
  duration: number;
}

export interface TranscriptionSegment {
  start: number;
  end: number;
  text: string;
  confidence: number;
}

interface WhisperApiResponse {
  text?: string;
  segments?: Array<{
    start?: number;
    end?: number;
    text?: string;
    avg_logprob?: number;
  }>;
  language?: string;
  duration?: number;
}

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

function parseSegments(
  segments: WhisperApiResponse["segments"],
): TranscriptionSegment[] {
  return (
    segments?.map((seg) => ({
      start: seg.start ?? 0,
      end: seg.end ?? 0,
      text: seg.text ?? "",
      confidence: seg.avg_logprob ? Math.exp(seg.avg_logprob) : 0.5,
    })) ?? []
  );
}

function emptyResult(): TranscriptionResult {
  return {
    text: "[transcription unavailable]",
    segments: [],
    language: "en",
    duration: 0,
  };
}

async function callWhisperCompatible(
  url: string,
  audioBytes: Uint8Array,
  model: string,
  authHeader: string | null,
): Promise<TranscriptionResult | null> {
  try {
    const formData = new FormData();
    const audioBlob = new Blob([audioBytes], { type: "audio/wav" });
    formData.append("file", audioBlob, "audio.wav");
    formData.append("model", model);
    formData.append("response_format", "verbose_json");
    formData.append("language", "en");
    formData.append("temperature", "0");

    const headers: Record<string, string> = {};
    if (authHeader) {
      headers.Authorization = authHeader;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: formData,
    });

    if (response.status < 200 || response.status >= 300) {
      const body = await response.text().catch(() => "");
      console.error(
        `[transcription] ${url} returned ${response.status}: ${body.slice(0, 200)}`,
      );
      return null;
    }

    const data = (await response.json()) as WhisperApiResponse;
    return {
      text: data.text ?? "",
      segments: parseSegments(data.segments),
      language: data.language ?? "en",
      duration: data.duration ?? 0,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown";
    console.error(`[transcription] ${url} request failed: ${msg}`);
    return null;
  }
}

export async function transcribeAudio(
  audioBytes: Uint8Array,
): Promise<TranscriptionResult> {
  // 1. Groq Whisper — fastest + most reliable when the key is present
  if (env.GROQ_API_KEY) {
    const groqResult = await callWhisperCompatible(
      GROQ_ENDPOINT,
      audioBytes,
      env.GROQ_WHISPER_MODEL,
      `Bearer ${env.GROQ_API_KEY}`,
    );
    if (groqResult) return groqResult;
    console.error("[transcription] Groq failed, trying self-hosted whisper");
  }

  // 2. Self-hosted whisper HTTP server (faster-whisper-server etc.)
  const selfHosted = await callWhisperCompatible(
    `${env.WHISPER_API_URL}/v1/audio/transcriptions`,
    audioBytes,
    "base",
    null,
  );
  if (selfHosted) return selfHosted;

  // 3. Local CLI fallback
  return transcribeWithCli(audioBytes);
}

async function transcribeWithCli(
  audioBytes: Uint8Array,
): Promise<TranscriptionResult> {
  const inputPath = join(tmpdir(), `whisper-${crypto.randomUUID()}.wav`);
  const outputDir = join(tmpdir(), `whisper-out-${crypto.randomUUID()}`);

  try {
    await Bun.write(inputPath, audioBytes);

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(
        [
          "whisper",
          inputPath,
          "--model",
          "base",
          "--output_format",
          "json",
          "--output_dir",
          outputDir,
          "--language",
          "en",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
    } catch (spawnErr) {
      const msg = spawnErr instanceof Error ? spawnErr.message : "spawn failed";
      console.error(`[transcription] whisper CLI unavailable: ${msg}`);
      return emptyResult();
    }

    await proc.exited;

    if (proc.exitCode !== 0) {
      return emptyResult();
    }

    const glob = new Bun.Glob("*.json");
    for await (const file of glob.scan(outputDir)) {
      const content = await Bun.file(join(outputDir, file)).text();
      const data = JSON.parse(content) as WhisperApiResponse;
      return {
        text: data.text ?? "",
        segments: parseSegments(data.segments),
        language: "en",
        duration: 0,
      };
    }

    return emptyResult();
  } finally {
    await unlink(inputPath).catch(() => {});
  }
}
