/**
 * Audio preprocessing pipeline — noise reduction, normalization, and VAD.
 *
 * Uses ffmpeg CLI for processing. If ffmpeg is not installed, every stage
 * degrades gracefully: we log once and return the raw input so the
 * transcription pipeline keeps working.
 */
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let ffmpegAvailable: boolean | null = null;

async function isFfmpegAvailable(): Promise<boolean> {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    const proc = Bun.spawn(["ffmpeg", "-version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    ffmpegAvailable = proc.exitCode === 0;
  } catch {
    ffmpegAvailable = false;
  }
  if (!ffmpegAvailable) {
    console.warn(
      "[audio-processor] ffmpeg not found in $PATH — preprocessing disabled, raw audio will be sent to transcription.",
    );
  }
  return ffmpegAvailable;
}

async function runFfmpeg(args: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(["ffmpeg", ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    return proc.exitCode === 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "spawn failed";
    console.error(`[audio-processor] ffmpeg spawn failed: ${msg}`);
    return false;
  }
}

export async function normalizeAudio(inputBytes: Uint8Array): Promise<Uint8Array> {
  if (!(await isFfmpegAvailable())) return inputBytes;

  const inputPath = join(tmpdir(), `input-${crypto.randomUUID()}.wav`);
  const outputPath = join(tmpdir(), `normalized-${crypto.randomUUID()}.wav`);

  try {
    await Bun.write(inputPath, inputBytes);

    const ok = await runFfmpeg([
      "-y", "-i", inputPath,
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
      "-ar", "16000", "-ac", "1", "-sample_fmt", "s16",
      outputPath,
    ]);

    if (!ok) return inputBytes;

    const outputFile = Bun.file(outputPath);
    return new Uint8Array(await outputFile.arrayBuffer());
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

export async function reduceNoise(inputBytes: Uint8Array): Promise<Uint8Array> {
  if (!(await isFfmpegAvailable())) return inputBytes;

  const inputPath = join(tmpdir(), `input-${crypto.randomUUID()}.wav`);
  const outputPath = join(tmpdir(), `denoised-${crypto.randomUUID()}.wav`);

  try {
    await Bun.write(inputPath, inputBytes);

    const ok = await runFfmpeg([
      "-y", "-i", inputPath,
      "-af", "afftdn=nf=-25",
      "-ar", "16000", "-ac", "1", "-sample_fmt", "s16",
      outputPath,
    ]);

    if (!ok) return inputBytes;

    const outputFile = Bun.file(outputPath);
    return new Uint8Array(await outputFile.arrayBuffer());
  } finally {
    await unlink(inputPath).catch(() => {});
    await unlink(outputPath).catch(() => {});
  }
}

export async function detectVoiceActivity(
  inputBytes: Uint8Array,
): Promise<{ hasSpeech: boolean; speechRatio: number }> {
  // Without ffmpeg we can't run silencedetect; assume there's speech so
  // we still try to transcribe instead of silently dropping every chunk.
  if (!(await isFfmpegAvailable())) {
    return { hasSpeech: true, speechRatio: 1 };
  }

  const inputPath = join(tmpdir(), `vad-${crypto.randomUUID()}.wav`);

  try {
    await Bun.write(inputPath, inputBytes);

    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(
        [
          "ffmpeg", "-i", inputPath,
          "-af", "silencedetect=noise=-30dB:d=0.5",
          "-f", "null", "-",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "spawn failed";
      console.error(`[audio-processor] VAD spawn failed: ${msg}`);
      return { hasSpeech: true, speechRatio: 1 };
    }

    const reader = proc.stderr.getReader();
    const chunks: Uint8Array[] = [];
    let done = false;
    while (!done) {
      const result = await reader.read();
      if (result.done) {
        done = true;
      } else {
        chunks.push(result.value);
      }
    }
    const stderrText = new TextDecoder().decode(Buffer.concat(chunks));

    await proc.exited;

    const silenceStarts = stderrText.match(/silence_start/g);
    const silenceCount = silenceStarts?.length ?? 0;

    const hasSpeech = silenceCount < 20;
    const speechRatio = hasSpeech ? 0.8 : 0.2;

    return { hasSpeech, speechRatio };
  } finally {
    await unlink(inputPath).catch(() => {});
  }
}

export async function preprocessAudio(
  inputBytes: Uint8Array,
): Promise<{ processedBytes: Uint8Array; hasSpeech: boolean; speechRatio: number }> {
  const denoised = await reduceNoise(inputBytes);
  const normalized = await normalizeAudio(denoised);
  const vad = await detectVoiceActivity(normalized);

  return {
    processedBytes: normalized,
    hasSpeech: vad.hasSpeech,
    speechRatio: vad.speechRatio,
  };
}
