/**
 * LLM post-processing for transcript cleanup.
 *
 * Cleans grammar, removes fillers, resolves corrections — WITHOUT hallucination.
 */

import { env } from "@my-better-t-app/env/server";

import type { DiarizedSegment } from "./diarization";

const CLEANUP_SYSTEM_PROMPT = `You are a transcript editor. Your ONLY job is to clean up speech-to-text output.

Rules:
1. Fix grammar and punctuation errors
2. Remove filler words (um, uh, like, you know, basically, actually, i mean)
3. Remove false starts and self-corrections (keep the corrected version)
4. Remove repeated words/stutters
5. Maintain speaker labels exactly as given
6. NEVER add information not present in the original
7. NEVER change the meaning or intent
8. NEVER hallucinate or invent content
9. Keep the same language and register
10. If a segment is unintelligible, mark it as [unintelligible]

Return ONLY the cleaned text, maintaining the same structure.`;

export interface PostProcessedTranscript {
  cleanedText: string;
  originalText: string;
  segments: Array<{
    speaker: string;
    text: string;
    start: number;
    end: number;
  }>;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Post-process transcript segments with LLM cleanup.
 */
export async function postProcessTranscript(
  segments: DiarizedSegment[],
): Promise<PostProcessedTranscript> {
  const originalText = segments
    .map((s) => `[${s.speaker}]: ${s.text}`)
    .join("\n");

  const cleanedText = await llmCleanup(originalText);

  return {
    cleanedText: cleanedText ?? originalText,
    originalText,
    segments: segments.map((s) => ({
      speaker: s.speaker,
      text: s.text,
      start: s.start,
      end: s.end,
    })),
  };
}

/**
 * Call OpenAI-compatible API for transcript cleanup.
 */
async function llmCleanup(text: string): Promise<string | null> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    return basicCleanup(text);
  }

  try {
    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: CLEANUP_SYSTEM_PROMPT },
            { role: "user", content: text },
          ],
          temperature: 0.1,
          max_tokens: 2000,
        }),
      },
    );

    if (response.status < 200 || response.status >= 300) {
      console.error(`LLM API returned ${response.status}`);
      return basicCleanup(text);
    }

    const data = (await response.json()) as ChatCompletionResponse;
    return data.choices?.[0]?.message?.content ?? basicCleanup(text);
  } catch (err) {
    console.error("LLM cleanup failed:", err);
    return basicCleanup(text);
  }
}

/**
 * Basic rule-based cleanup when LLM is unavailable.
 */
function basicCleanup(text: string): string {
  const FILLER_PATTERN =
    /\b(um+|uh+|hmm+|like|you know|basically|actually|i mean|so yeah|right)\b[,.]?\s*/gi;
  const STUTTER_PATTERN = /\b(\w+)\s+\1\b/gi;

  let cleaned = text;
  cleaned = cleaned.replace(FILLER_PATTERN, "");
  cleaned = cleaned.replace(STUTTER_PATTERN, "$1");
  cleaned = cleaned.replace(/\s{2,}/g, " ").trim();
  cleaned = cleaned.replace(
    /([.!?])\s+([a-z])/g,
    (_: string, punct: string, letter: string) =>
      `${punct} ${letter.toUpperCase()}`,
  );

  return cleaned;
}
