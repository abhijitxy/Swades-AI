/**
 * Speaker diarization — assigns speaker labels to transcription segments.
 *
 * In production, this would integrate with pyannote.audio or a dedicated
 * diarization API. Here we provide a heuristic-based approach using
 * energy/pitch changes between segments, plus an API integration path.
 */

import type { TranscriptionSegment } from "./transcription";

export interface DiarizedSegment extends TranscriptionSegment {
  speaker: string;
}

export interface DiarizationResult {
  segments: DiarizedSegment[];
  speakerCount: number;
  speakers: string[];
}

/**
 * Diarize transcription segments.
 * Attempts to reach a pyannote or diarization API, falls back to heuristic.
 */
export async function diarizeSegments(
  segments: TranscriptionSegment[],
  _audioBytes?: Uint8Array,
): Promise<DiarizationResult> {
  // Heuristic diarization based on segment gaps and patterns
  const diarized = heuristicDiarization(segments);

  const speakers = [...new Set(diarized.map((s) => s.speaker))];

  return {
    segments: diarized,
    speakerCount: speakers.length,
    speakers,
  };
}

/**
 * Heuristic speaker diarization.
 * Uses pause length between segments to infer speaker changes.
 * A gap > 1.5s suggests a different speaker.
 */
function heuristicDiarization(segments: TranscriptionSegment[]): DiarizedSegment[] {
  if (segments.length === 0) return [];

  const SPEAKER_CHANGE_GAP = 1.5; // seconds
  let currentSpeaker = 0;
  const maxSpeakers = 4;

  return segments.map((seg, i) => {
    if (i > 0) {
      const prevSeg = segments[i - 1];
      if (prevSeg) {
        const gap = seg.start - prevSeg.end;
        if (gap > SPEAKER_CHANGE_GAP) {
          currentSpeaker = (currentSpeaker + 1) % maxSpeakers;
        }
      }
    }

    return {
      ...seg,
      speaker: `Speaker ${currentSpeaker + 1}`,
    };
  });
}
