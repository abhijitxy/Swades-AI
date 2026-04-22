# System README — Reliable Audio Chunking, Upload & Transcription Pipeline

A detailed, end‑to‑end walkthrough of the system: what it does, how every moving part works, and why each design choice exists. Designed so an engineer new to the repo can read this single document and understand the entire flow — from microphone button to cleaned transcript in the database.

---

## 1. What this project is

A hackathon build of a **reliable, loss‑proof audio recording pipeline** with a transcription stage bolted on top.

At its core it answers one question: *"How do I record audio in the browser and guarantee that every byte reaches the server, gets stored, gets transcribed, and survives any crash, network drop, or bucket loss in between?"*

The high-level contract the system enforces:

> No recorded audio is ever silently lost. Every chunk is durable on the client until both the storage bucket **and** the database confirm they hold it. If either side loses it, the client replays from its local buffer.

On top of that reliability spine, we layer:

- Server-side audio preprocessing (denoise, normalize, VAD)
- Whisper-based speech-to-text
- Speaker diarization (currently heuristic — see §8)
- LLM-based transcript cleanup (filler removal, grammar fixes, **no hallucination**)
- Persistent transcripts keyed back to the original chunk

---

## 2. Tech stack at a glance

| Layer             | Choice                                    | Why                                                              |
|-------------------|-------------------------------------------|------------------------------------------------------------------|
| Monorepo          | Turborepo + npm workspaces                | Shared packages (`db`, `env`, `ui`, `config`) across apps        |
| Runtime           | Bun                                       | Fast server startup, native `Bun.spawn` for ffmpeg/whisper CLIs  |
| Web app           | Next.js (App Router) + React              | File-based routing, server components, good DX                   |
| UI                | TailwindCSS + shadcn/ui                   | Consistent, accessible primitives                                |
| API server        | Hono                                      | Tiny, fast, edge-ready HTTP framework                            |
| Database          | PostgreSQL + Drizzle ORM                  | Typed schema, predictable migrations                             |
| Object storage    | S3-compatible (MinIO locally)             | Durable blob store for WAV chunks                                |
| Client durability | OPFS + IndexedDB                          | Survives tab reload, browser crash, and network loss             |
| Transcription     | Groq Whisper API → self-hosted → CLI      | Fallback chain, never fails hard                                 |
| LLM cleanup       | OpenAI `gpt-4o-mini` (optional)           | Grammar/filler fixes with strict anti-hallucination prompt       |
| Lint/format       | Ultracite (Oxlint + Oxfmt)                | Zero-config, auto-fixable                                        |

---

## 3. Repository layout

```
Swades-AI-Hackathon/
├── apps/
│   ├── web/                      # Next.js frontend
│   │   └── src/
│   │       ├── app/recorder/     # Recorder page (record + visualize chunks)
│   │       ├── hooks/
│   │       │   ├── use-recorder.ts         # Mic → PCM → 16kHz WAV chunker
│   │       │   └── use-chunk-pipeline.ts   # Pipeline state machine, OPFS glue
│   │       └── lib/
│   │           ├── opfs-store.ts           # OPFS + IndexedDB durable buffer
│   │           └── upload-worker.ts        # Background upload + retry + reconcile
│   │
│   └── server/                   # Hono API
│       └── src/
│           ├── index.ts
│           ├── routes/
│           │   ├── chunks.ts               # /upload, /status, /reconcile, transcripts
│           │   └── transcription.ts        # Manual re-processing endpoints
│           ├── workers/
│           │   └── transcription-pipeline.ts   # preprocess → STT → diarize → LLM → store
│           └── lib/
│               ├── s3.ts                   # S3/MinIO client
│               ├── checksum.ts             # SHA-256 for integrity
│               ├── audio-processor.ts      # ffmpeg: denoise, normalize, VAD
│               ├── transcription.ts        # Whisper (Groq / self-hosted / CLI)
│               ├── diarization.ts          # Speaker attribution (heuristic)
│               └── llm-postprocess.ts      # Transcript cleanup
│
├── packages/
│   ├── db/     # Drizzle schema + client (chunks, transcripts)
│   ├── env/    # Type-safe env (zod + t3-env)
│   ├── ui/     # Shared shadcn components
│   └── config/ # Shared tsconfig base
│
└── tests/load/ # Load-testing harness (k6-style)
```

---

## 4. End-to-end data flow

```
┌─────────────────────────────── BROWSER ───────────────────────────────┐
│                                                                       │
│  Mic (getUserMedia)                                                   │
│    │                                                                  │
│    ▼                                                                  │
│  AudioContext + ScriptProcessor → resample → 16kHz mono PCM           │
│    │  (every N seconds)                                               │
│    ▼                                                                  │
│  encodeWav()  ──► WAV Blob (chunk)                                    │
│    │                                                                  │
│    ▼                                                                  │
│  saveChunkToOpfs()  [OPFS file + IndexedDB metadata]   ← DURABLE      │
│    │                                                                  │
│    ▼                                                                  │
│  ChunkUploadWorker (every 2s):                                        │
│    • picks up status=local & status=failed(<MAX_RETRIES)              │
│    • POST multipart to /api/chunks/upload                             │
│    • exponential backoff w/ jitter on 5xx / network error             │
│    ▼                                                                  │
│  Reconcile loop (every 30s):                                          │
│    • POST /api/chunks/reconcile with locally-acked chunkIds           │
│    • if server says "missing": flip status back to local → re-upload  │
│                                                                       │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │ multipart/form-data
                                    ▼
┌─────────────────────────────── SERVER ────────────────────────────────┐
│                                                                       │
│  POST /api/chunks/upload                                              │
│    1. Parse multipart                                                 │
│    2. Idempotency: SELECT chunks WHERE chunkId=?  → if hit, return    │
│    3. Compute SHA-256 checksum of bytes                               │
│    4. PUT to S3 bucket at sessionId/chunkId.wav                       │
│    5. HEAD the object to verify it really landed                      │
│    6. INSERT into chunks(status=acked, checksum, bucketKey, ...)      │
│       ON CONFLICT DO NOTHING                                          │
│    7. Fire-and-forget → processChunk(chunkId)                         │
│                                                                       │
│    ↳ processChunk (transcription-pipeline.ts)                         │
│         a) status=processing                                          │
│         b) GET bytes from S3                                          │
│         c) preprocessAudio()  – ffmpeg denoise + loudnorm + VAD       │
│         d) if !hasSpeech → store "[silence]" transcript, done         │
│         e) transcribeAudio() – Groq Whisper → self-hosted → CLI       │
│         f) diarizeSegments() – assign Speaker N per segment           │
│         g) postProcessTranscript() – LLM cleanup (or regex fallback)  │
│         h) INSERT into transcripts(rawText, cleanedText, speakers,    │
│            confidence, language, processingTimeMs)                    │
│         i) chunks.status = transcribed                                │
│                                                                       │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │
                                    ▼
                  ┌────────────────────────────────────┐
                  │ Postgres: chunks, transcripts       │
                  │ S3/MinIO: audio-chunks/<session>/… │
                  └────────────────────────────────────┘
```

---

## 5. Client internals

### 5.1 Recording (`use-recorder.ts`)

- Uses `getUserMedia` with `echoCancellation` and `noiseSuppression` enabled.
- Builds an `AudioContext` pipeline: source → `ScriptProcessorNode(4096)` → destination.
- On each audio process tick we resample the native rate down to **16 kHz mono**, which is exactly what Whisper expects (saves server-side resampling and network bytes).
- Samples are buffered until they cross `SAMPLE_RATE * chunkDuration` (default 5 s worth).
- When the threshold hits we synchronously build a PCM16 WAV file in memory (minimal 44-byte header + `s16le` samples) and push a `WavChunk` into state.
- `pause()` / `resume()` freeze and thaw the processor gate without tearing down the stream, so the elapsed counter stays accurate.
- `stop()` calls `flushChunk()` so the *last, under-threshold* chunk isn't lost.

### 5.2 Durable buffering (`opfs-store.ts`)

Two storage surfaces, chosen deliberately:

- **OPFS (Origin Private File System)** holds the actual `chunkId.wav` bytes. OPFS is fast, not visible to the user, and big enough for multi-gig recordings.
- **IndexedDB** holds *metadata only*: `chunkId`, `sessionId`, `status`, `retries`, `durationMs`, timestamps, `errorMessage`, `serverChecksum`. It has indices on `status` and `sessionId` so the upload worker can query cheaply.

Status machine on the client:

```
local → uploading → uploaded → acked → cleaned
                        │
                        └──► failed ─► (retries < MAX) ─► local
```

Why two stores? OPFS is great at files but bad at querying. IndexedDB is great at queried metadata but awkward for large binary blobs. Splitting them gives us the strengths of both.

### 5.3 Upload worker (`upload-worker.ts`)

A single-class cooperative worker (`ChunkUploadWorker`) that the React hook starts on mount:

- `processQueue()` runs every **2 s**: fetches all `local` + `failed (retries < 8)` chunks, fires `uploadChunk()` for each one that isn't already in flight (tracked via `activeUploads: Set<string>`).
- `uploadChunk()` reads the blob from OPFS, posts as multipart (`chunkId`, `sessionId`, `file`, `durationMs`), then flips metadata to `acked` on success with the server's checksum stored.
- `fetchWithRetry()` does **exponential backoff with jitter** on 5xx / network errors, bumping the retry counter each round until `MAX_RETRIES = 8` (≈ `1s, 2s, 4s, … capped at 60s`, × 0.5–1.0 jitter).
- `reconcile()` runs every **30 s**: takes all locally-`acked` chunkIds, asks the server "do you still have these?", and if any come back in `missing` it flips them back to `local` → the next `processQueue` tick re-uploads from OPFS.

### 5.4 Pipeline hook (`use-chunk-pipeline.ts`)

Glues everything together for the UI:

- Creates or reuses a per-browser-session `sessionId` via `sessionStorage`.
- Subscribes to `ChunkUploadWorker` events and updates React state.
- On mount, calls `restorePersistedChunks()` — this reads every non-`cleaned` record out of IndexedDB and re-hydrates the UI after a crash or reload.
- Polls `GET /api/chunks/transcripts/:sessionId` every 3 s so transcripts show up live as they finish.
- `cleanup()` deletes `acked` chunks from OPFS once they're confirmed safe server-side.
- `clearAll()` nukes OPFS, IndexedDB, in-memory state, revokes object URLs, and rotates the `sessionId` — used by the "Clear All" UI button.

---

## 6. Server internals

### 6.1 Upload endpoint (`POST /api/chunks/upload`)

Strictly ordered, defensively coded, with an explicit `stage` on every failure path:

1. Parse multipart — fail fast with `400` if the body is malformed.
2. **Idempotency check**: if `chunkId` already exists in `chunks` we short-circuit and return `{ duplicate: true, status }`. This is critical because the client retries aggressively.
3. Compute **SHA-256 checksum** of the bytes — returned to the client so they can verify integrity locally.
4. Upload to S3 under the key `<sessionId>/<chunkId>.wav`.
5. `HEAD` the object to *verify* it actually landed — guards against silent PUT success that the backend never replicated.
6. `INSERT` into `chunks` with `ON CONFLICT DO NOTHING` on the `chunkId` PK — a second safety net against races under high concurrency.
7. Fire-and-forget kick off `processChunk(chunkId)` so transcription starts immediately without blocking the HTTP response.

### 6.2 Reconcile endpoint (`POST /api/chunks/reconcile`)

Given a `sessionId` **or** an array of `chunkIds`:

- For each chunk the DB thinks is acked, `HEAD` the S3 object.
- If it's really there → add to `verified`.
- If it's missing → add to `missing` **and** mark `status=failed, errorMessage="Missing from bucket"` so the client's next reconcile sees it and re-uploads from OPFS.

This is the core of the "DB ack ≠ truth unless storage agrees" invariant.

### 6.3 Transcription pipeline (`workers/transcription-pipeline.ts`)

A single linear function, `processChunk(chunkId)`:

1. Load the `chunks` row; bail if not found.
2. `chunks.status = processing`.
3. `getChunkFromS3()` — if bytes are gone, `status=failed`, store an `errorMessage`, return.
4. **Preprocess** via `preprocessAudio()` (see §6.4). Returns `{ processedBytes, hasSpeech }`.
5. If VAD says **no speech**, we short-circuit: insert a `[silence]` transcript with 100% confidence and mark `status=transcribed`. This stops silent chunks from hitting the (paid) Whisper API.
6. **Transcribe** (§6.5). Returns segments with `{ start, end, text, confidence, language }`.
7. **Diarize** (§8). Attaches `speaker` to each segment.
8. **LLM post-process** (§6.6). Produces `cleanedText` alongside `originalText`.
9. Insert a row into `transcripts` with raw + cleaned text, serialized speakers, average confidence, language, and processing time.
10. `chunks.status = transcribed`.

Any throw inside the whole function is caught and written to `chunks.errorMessage`, so the UI can display a reason per chunk.

### 6.4 Audio preprocessing (`lib/audio-processor.ts`)

Uses the system `ffmpeg` CLI (detected once, cached in `ffmpegAvailable`). If ffmpeg isn't present we log a single warning and pass the raw audio through — **the pipeline never fails just because ffmpeg is missing**.

- **`reduceNoise`** — `afftdn=nf=-25` for FFT-based denoise.
- **`normalizeAudio`** — `loudnorm=I=-16:TP=-1.5:LRA=11`, broadcast-quality loudness normalization, forced to 16 kHz / mono / s16.
- **`detectVoiceActivity`** — `silencedetect=noise=-30dB:d=0.5`, then counts `silence_start` markers in stderr. More than 20 → treat as silent.

Why preprocess? Whisper's accuracy jumps noticeably on clean, normalized input, and VAD lets us skip transcription entirely on empty chunks.

### 6.5 Transcription (`lib/transcription.ts`)

Tries, in order:

1. **Groq Whisper API** (OpenAI-compatible) — if `GROQ_API_KEY` is set. Uses `whisper-large-v3-turbo` by default. Fastest and most accurate in practice.
2. **Self-hosted Whisper** at `WHISPER_API_URL` (e.g. `faster-whisper-server`). Same OpenAI-compatible endpoint shape, no auth header.
3. **Local `whisper` CLI** — writes the bytes to a temp `.wav`, runs `whisper` with `--model base --output_format json`, parses the result, then cleans up temp files.

Every tier is guarded: bad HTTP, missing binary, or spawn failure logs and returns `null`, which lets the next tier take over. If everything fails we return `{ text: "[transcription unavailable]", segments: [], ... }` so the transcript row still gets written — the pipeline **never silently loses a chunk**.

Each segment carries `confidence` derived from Whisper's `avg_logprob` via `exp(logprob)`.

### 6.6 LLM post-processing (`lib/llm-postprocess.ts`)

Takes the diarized segments, renders them as:

```
[Speaker 1]: first segment text
[Speaker 2]: second segment text
...
```

and sends that to `gpt-4o-mini` with a hard-locked system prompt. The prompt explicitly forbids:

- adding information not in the original
- changing meaning
- hallucinating speakers or dialogue
- breaking the `[Speaker N]:` labels

If `OPENAI_API_KEY` isn't set or the call fails, we fall back to `basicCleanup()`: a regex-based filler-word stripper (`um`, `uh`, `like`, `you know`, `basically`, …), stutter collapser (`the the → the`), whitespace normalizer, and sentence-start capitalizer. Both `originalText` and `cleanedText` are stored so you can always audit what the LLM did.

### 6.7 Database schema

Two tables, both in `packages/db/src/schema/chunks.ts`:

- **`chunks`** — one row per uploaded audio chunk. PK `chunk_id`. Indices on `session_id`, `status`, `created_at`. `status` is a pg enum: `uploaded | acked | processing | transcribed | failed`.
- **`transcripts`** — one row per produced transcript, FK → `chunks.chunk_id`. Stores `raw_text`, `cleaned_text`, `speakers` (JSON blob of segments), `confidence` 0-100, `language`, `processing_time_ms`.

---

## 7. Failure modes handled

| Failure                               | What saves us                                                   |
|---------------------------------------|-----------------------------------------------------------------|
| Tab closed / browser crash mid-record | OPFS write is synchronous before any network call; on reload the pipeline hook re-hydrates unfinished chunks |
| Network blip during upload            | Upload worker exponential backoff + jitter, up to 8 retries     |
| Server returns 5xx                    | Retry, same mechanism                                           |
| Duplicate upload (client retried after 200 lost) | Server idempotency check + `ON CONFLICT DO NOTHING`   |
| S3 wrote but didn't replicate         | Post-upload `HEAD` verify, otherwise respond `500 s3-verify`    |
| DB says acked but bucket lost the object | 30-second client reconcile loop + `/reconcile` endpoint flips to `failed` → client re-uploads from OPFS |
| Whisper provider down                 | 3-tier fallback: Groq → self-hosted → local CLI                 |
| ffmpeg not installed                  | Graceful skip, raw audio passed through, single warning logged  |
| LLM API down / key missing            | Regex-based `basicCleanup()` fallback                           |
| Silent chunk                          | VAD short-circuit, writes `[silence]` transcript, skips API call|
| Transcription exception               | Caught, `chunks.status=failed`, `errorMessage` stored, visible in UI |

---

## 8. Diarization — current state & why proper diarization matters

### 8.1 What's implemented today

`lib/diarization.ts` ships with a **heuristic diarizer** only:

```
If the gap between segment[i].end and segment[i+1].start > 1.5s
    → treat it as a likely speaker change
    → increment speaker (mod 4)
Else
    → same speaker as previous segment
```

Each segment is labeled `Speaker 1` … `Speaker 4`. The signature accepts `audioBytes` so a real embedding-based diarizer can drop in later, but that path is not yet wired up.

### 8.2 Why this is *not* good enough, even though it "works"

Heuristic diarization by pause length is wrong in every realistic conversation:

- **Two people finishing each other's sentences** (low/zero gap) look like one speaker.
- **One person pausing to think** (long gap) gets falsely split into two speakers.
- **Overlapping speech** (very common in meetings) is invisible — Whisper returns a single segment, so the heuristic never sees the overlap at all.
- **Speaker identity is lost across chunks** — since each chunk is diarized independently, `Speaker 1` in chunk N has no relationship to `Speaker 1` in chunk N+1. The labels are essentially random per chunk.
- **No speaker count estimate** — `maxSpeakers = 4` is hard-coded; a 6-person call will collide labels.

### 8.3 Why proper diarization was the right thing to do

In a transcription product, diarization is not a nice-to-have — it's what turns a wall of text into a *conversation record*. Specifically:

1. **Readability** — `[Alice]: …` / `[Bob]: …` transcripts are usable; unattributed text requires a human to re-listen to figure out who said what.
2. **Downstream analytics** — talk-time ratio, turn-taking cadence, question/answer attribution, coaching insights (for sales calls, support calls, interviews) all depend on accurate speaker boundaries.
3. **LLM post-processing quality** — our cleanup prompt explicitly preserves `[Speaker N]:` labels. If those labels are wrong, the "cleaned" transcript is wrong in a way that looks authoritative. Garbage-in, confidently-wrong-out.
4. **Search and redaction** — "show me everything Alice said about pricing" is only possible with a stable speaker identity across the whole recording.
5. **Compliance / legal use** — in regulated contexts (healthcare, finance, legal depositions) an unattributed transcript can be inadmissible; a misattributed one is worse.

### 8.4 What we'd ship given more time

The correct architecture, which the current code is already shaped to receive:

1. **Speaker-embedding model** — run `pyannote.audio` (or equivalent) over the audio to produce per-segment speaker embeddings (d-vectors / x-vectors).
2. **Clustering** — agglomerative or spectral clustering on the embeddings inside each chunk to get chunk-local speaker IDs.
3. **Cross-chunk speaker linking** — maintain a per-`sessionId` "speaker registry" keyed on centroid embeddings. When a new chunk arrives, match its local clusters against the registry; reuse existing IDs when cosine similarity > threshold, otherwise register a new speaker. This is what makes `Speaker 1` mean the same person across the whole recording.
4. **Overlap detection** — pyannote's overlap-detection head flags segments where multiple speakers are active, so the LLM post-processor can emit `[Speaker 1 & Speaker 2 (overlap)]: …` instead of silently picking one.
5. **Optional enrollment** — if known speakers enroll a short sample, diarization becomes identification: labels become `[Alice]` / `[Bob]` instead of `[Speaker 1]`.

Time pressure in the hackathon meant we shipped the heuristic so the rest of the pipeline (ingest → STT → post-process → store → UI) could be demonstrated end-to-end. **The interface in `diarizeSegments(segments, audioBytes)` is intentionally the exact shape a real diarizer would slot into**, so swapping it is a single-file change.

---

## 9. Running the system

### 9.1 Prerequisites

- Node + npm
- Bun (server runtime)
- PostgreSQL
- MinIO (or any S3-compatible bucket) — default endpoint `http://localhost:9000`, creds `minioadmin` / `minioadmin`
- *Optional but recommended:*
  - `ffmpeg` in `$PATH` (for denoise / normalize / VAD)
  - `GROQ_API_KEY` for fast Whisper
  - `OPENAI_API_KEY` for LLM cleanup
  - A self-hosted `faster-whisper-server` on `WHISPER_API_URL` if you don't want to rely on a cloud API

### 9.2 Environment

Put this in `apps/server/.env`:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/audio
CORS_ORIGIN=http://localhost:3001
NODE_ENV=development

# S3 / MinIO
S3_ENDPOINT=http://localhost:9000
S3_REGION=us-east-1
S3_BUCKET=audio-chunks
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_FORCE_PATH_STYLE=true

# Transcription (all optional)
GROQ_API_KEY=
GROQ_WHISPER_MODEL=whisper-large-v3-turbo
WHISPER_API_URL=http://localhost:8080
OPENAI_API_KEY=
```

### 9.3 First run

```bash
npm install
npm run db:push           # apply Drizzle schema
npm run dev               # starts both apps via turbo
```

- Web: http://localhost:3001 (open `/recorder`)
- API: http://localhost:3000

The S3 bucket is auto-created on server boot via `ensureBucket()`.

### 9.4 Useful scripts

```bash
npm run dev:web           # web only
npm run dev:server        # server only
npm run build             # build all
npm run check-types       # project-wide tsc -b
npm run db:studio         # Drizzle studio UI
npm exec -- ultracite fix # format + lint autofix (repo standard)
```

---

## 10. API reference (server)

| Method | Path                                        | Purpose                                                        |
|--------|---------------------------------------------|----------------------------------------------------------------|
| GET    | `/`                                         | Health check                                                   |
| POST   | `/api/chunks/upload`                        | Upload a chunk (multipart: `chunkId`, `sessionId`, `file`, `durationMs`). Idempotent. Kicks off transcription. |
| GET    | `/api/chunks/status?sessionId=…`            | All chunk statuses for a session                               |
| GET    | `/api/chunks/:chunkId`                      | One chunk row                                                  |
| POST   | `/api/chunks/reconcile`                     | Body: `{ sessionId }` or `{ chunkIds: [] }`. Verifies bucket vs DB, returns `missing[]`, marks them `failed` |
| GET    | `/api/chunks/transcript/:chunkId`           | Transcript for a single chunk                                  |
| GET    | `/api/chunks/transcripts/:sessionId`        | All transcripts for a session                                  |
| POST   | `/api/transcription/process/:chunkId`       | Manually re-run the transcription pipeline for one chunk       |
| POST   | `/api/transcription/process-session/:sessionId` | Re-run pipeline for every `acked`/`failed` chunk in a session |

---

## 11. Design principles codified

1. **OPFS is the source of truth until both bucket + DB agree.** Nothing is deleted from the client until `status=acked` *and* (later) reconciliation hasn't flipped it back.
2. **Idempotency on every mutating endpoint.** The client retries; the server must not double-count.
3. **Every external dependency has a fallback.** Groq → self-hosted → CLI. ffmpeg optional. LLM optional. Missing pieces degrade, never crash.
4. **Typed end-to-end.** Drizzle for DB types, `@t3-oss/env-core` + zod for envs, TypeScript strict across all packages.
5. **Observability-first error handling.** Every catch logs context (path, method, stage, chunkId, message) before returning structured JSON. The `stage` field on 500 responses tells you exactly where the request died.
6. **No hallucinations in the cleanup layer.** The LLM prompt is locked to editorial cleanup only, and we always keep `rawText` next to `cleanedText` for audit.

---

## 12. Known limitations / future work

- **Diarization is heuristic only.** See §8 — proper embedding-based diarization with cross-chunk speaker linking is the single biggest accuracy win left.
- Transcription is per-chunk, so words that straddle chunk boundaries can be split. A 0.5 s overlap between adjacent chunks, stitched server-side, would fix this.
- `ScriptProcessorNode` in `use-recorder.ts` is deprecated in favor of `AudioWorkletNode`; works fine today but should migrate.
- No auth yet — `sessionId` is client-generated. Fine for the hackathon, not fine for production.
- The reconcile loop is O(acked chunks) per cycle; at very large scale this should page and/or use a server-driven change feed instead.
- Load-test harness in `tests/load/` targets the upload path only; the transcription stage needs its own soak test.
