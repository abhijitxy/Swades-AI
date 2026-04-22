/**
 * k6 load test for the chunk upload pipeline.
 *
 * Targets: ~5k requests/second to POST /api/chunks/upload
 *
 * Run: k6 run tests/load/k6-upload.js
 *
 * Prerequisites:
 * - k6 installed: brew install k6
 * - Server running at http://localhost:3000
 * - MinIO and Postgres up
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// ─── Custom metrics ─────────────────────────────────────────────────────────

const uploadDuration = new Trend("upload_duration", true);
const uploadErrors = new Counter("upload_errors");
const duplicateRate = new Rate("duplicate_rate");
const dataLossRate = new Rate("data_loss_rate");

// ─── Config ─────────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    sustained_load: {
      executor: "constant-arrival-rate",
      rate: 5000,
      timeUnit: "1s",
      duration: "30s",
      preAllocatedVUs: 200,
      maxVUs: 500,
    },
    ramp_up: {
      executor: "ramping-arrival-rate",
      startRate: 100,
      timeUnit: "1s",
      preAllocatedVUs: 100,
      maxVUs: 500,
      stages: [
        { target: 1000, duration: "10s" },
        { target: 5000, duration: "20s" },
        { target: 5000, duration: "30s" },
        { target: 0, duration: "10s" },
      ],
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<2000", "p(99)<5000"],
    http_req_failed: ["rate<0.01"], // <1% error rate
    upload_errors: ["count<100"],
    data_loss_rate: ["rate<0.001"], // <0.1% data loss
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Generate a minimal valid WAV header + silence (for testing).
 */
function generateTestWav() {
  const sampleRate = 16000;
  const duration = 5; // seconds
  const numSamples = sampleRate * duration;
  const dataSize = numSamples * 2; // 16-bit = 2 bytes per sample

  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");

  // fmt chunk
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  // data chunk
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  // Generate sine wave (not silence so VAD detects speech)
  const frequency = 440;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * frequency * t) * 0.5;
    view.setInt16(44 + i * 2, sample * 0x7fff, true);
  }

  return new Uint8Array(buffer);
}

function writeString(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}

// ─── Test ───────────────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || "http://localhost:3000";
const testWav = generateTestWav();

export default function () {
  const chunkId = `load-test-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const sessionId = `load-session-${__VU}`;

  const formData = {
    chunkId: chunkId,
    sessionId: sessionId,
    durationMs: "5000",
    file: http.file(testWav, `${chunkId}.wav`, "audio/wav"),
  };

  const startTime = Date.now();
  const res = http.post(`${BASE_URL}/api/chunks/upload`, formData);
  const duration = Date.now() - startTime;

  uploadDuration.add(duration);

  const isOk = check(res, {
    "status is 200": (r) => r.status === 200,
    "response has success": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.success === true;
      } catch {
        return false;
      }
    },
    "has chunkId": (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.chunkId === chunkId;
      } catch {
        return false;
      }
    },
  });

  if (!isOk) {
    uploadErrors.add(1);
    dataLossRate.add(1);
  } else {
    dataLossRate.add(0);

    try {
      const body = JSON.parse(res.body);
      duplicateRate.add(body.duplicate === true ? 1 : 0);
    } catch {
      // ignore
    }
  }

  // Verify idempotency: re-send same chunk
  if (Math.random() < 0.1) {
    // 10% of requests test idempotency
    const dupeRes = http.post(`${BASE_URL}/api/chunks/upload`, formData);
    check(dupeRes, {
      "duplicate returns 200": (r) => r.status === 200,
      "duplicate marked as duplicate": (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.duplicate === true;
        } catch {
          return false;
        }
      },
    });
  }

  sleep(0.01); // Small pause between requests
}

// ─── Verification ───────────────────────────────────────────────────────────

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: " ", enableColors: true }),
    "./tests/load/summary.json": JSON.stringify(data, null, 2),
  };
}

function textSummary(data, opts) {
  // k6 built-in
  return JSON.stringify(
    {
      totalRequests: data.metrics.http_reqs?.values?.count ?? 0,
      avgDuration: data.metrics.http_req_duration?.values?.avg ?? 0,
      p95Duration: data.metrics.http_req_duration?.values?.["p(95)"] ?? 0,
      p99Duration: data.metrics.http_req_duration?.values?.["p(99)"] ?? 0,
      errorRate: data.metrics.http_req_failed?.values?.rate ?? 0,
      uploadErrors: data.metrics.upload_errors?.values?.count ?? 0,
    },
    null,
    2,
  );
}
