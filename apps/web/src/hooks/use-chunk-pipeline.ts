/**
 * useChunkPipeline — integrates the recorder hook with OPFS persistence
 * and background upload worker.
 *
 * Lifecycle: record → OPFS → upload → ack → cleanup
 */
"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import {
  cleanupAckedChunks,
  clearAllChunks,
  getAllChunkMeta,
  saveChunkToOpfs,
  type ChunkStatus,
} from "@/lib/opfs-store"
import { ChunkUploadWorker, type UploadEvent } from "@/lib/upload-worker"

const SESSION_KEY = "audio-session-id"

function getOrCreateSessionId(): string {
  if (typeof window === "undefined") return crypto.randomUUID()
  const existing = sessionStorage.getItem(SESSION_KEY)
  if (existing) return existing
  const id = crypto.randomUUID()
  sessionStorage.setItem(SESSION_KEY, id)
  return id
}

export interface PipelineChunk {
  chunkId: string
  status: ChunkStatus
  durationMs: number
  retries: number
  createdAt: number
  errorMessage: string | null
  blob?: Blob
  url?: string
}

export interface TranscriptRow {
  id: string
  chunkId: string
  sessionId: string
  rawText: string
  cleanedText: string | null
  speakers: string | null
  confidence: number | null
  language: string | null
  processingTimeMs: number | null
  createdAt: string
}

export interface UseChunkPipelineOptions {
  serverUrl: string
  autoStart?: boolean
  transcriptPollMs?: number
}

const DEFAULT_TRANSCRIPT_POLL_MS = 3000

export function useChunkPipeline(options: UseChunkPipelineOptions) {
  const {
    serverUrl,
    autoStart = true,
    transcriptPollMs = DEFAULT_TRANSCRIPT_POLL_MS,
  } = options
  const [sessionId, setSessionId] = useState(getOrCreateSessionId)
  const [pipelineChunks, setPipelineChunks] = useState<PipelineChunk[]>([])
  const [transcripts, setTranscripts] = useState<TranscriptRow[]>([])
  const [isWorkerRunning, setIsWorkerRunning] = useState(false)
  const workerRef = useRef<ChunkUploadWorker | null>(null)
  const urlsRef = useRef<Map<string, string>>(new Map())

  // Initialize worker
  useEffect(() => {
    const worker = new ChunkUploadWorker(serverUrl)
    workerRef.current = worker

    const unsubscribe = worker.on((event: UploadEvent) => {
      setPipelineChunks((prev) =>
        prev.map((c) => {
          if (c.chunkId !== event.chunkId) return c
          const newStatus = event.status as ChunkStatus | undefined
          return {
            ...c,
            status: newStatus ?? c.status,
            errorMessage: event.error ?? c.errorMessage,
          }
        }),
      )
    })

    if (autoStart) {
      worker.start()
      setIsWorkerRunning(true)
    }

    // Restore persisted chunks on mount
    restorePersistedChunks()

    return () => {
      unsubscribe()
      worker.stop()

      // Revoke object URLs
      for (const url of urlsRef.current.values()) {
        URL.revokeObjectURL(url)
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverUrl, autoStart])

  /**
   * Restore chunks from previous sessions (crash recovery).
   */
  const restorePersistedChunks = useCallback(async () => {
    try {
      const allMeta = await getAllChunkMeta()
      const restored: PipelineChunk[] = allMeta
        .filter((m) => m.status !== "cleaned")
        .map((m) => ({
          chunkId: m.chunkId,
          status: m.status,
          durationMs: m.durationMs,
          retries: m.retries,
          createdAt: m.createdAt,
          errorMessage: m.errorMessage,
        }))

      if (restored.length > 0) {
        setPipelineChunks((prev) => {
          const existingIds = new Set(prev.map((c) => c.chunkId))
          const newChunks = restored.filter((r) => !existingIds.has(r.chunkId))
          return [...prev, ...newChunks]
        })
      }
    } catch {
      // OPFS may not be available
    }
  }, [])

  /**
   * Ingest a new audio chunk: persist to OPFS first, then queue for upload.
   */
  const ingestChunk = useCallback(
    async (chunkId: string, blob: Blob, durationMs: number) => {
      // 1. Persist to OPFS immediately
      await saveChunkToOpfs(chunkId, sessionId, blob, durationMs)

      // 2. Create object URL for playback
      const url = URL.createObjectURL(blob)
      urlsRef.current.set(chunkId, url)

      // 3. Add to state
      const pipelineChunk: PipelineChunk = {
        chunkId,
        status: "local",
        durationMs,
        retries: 0,
        createdAt: Date.now(),
        errorMessage: null,
        blob,
        url,
      }

      setPipelineChunks((prev) => [...prev, pipelineChunk])

      // Worker will pick it up on next cycle
    },
    [sessionId],
  )

  /**
   * Get current session chunks from server.
   */
  const fetchServerStatus = useCallback(async () => {
    try {
      const response = await fetch(`${serverUrl}/api/chunks/status?sessionId=${sessionId}`)
      if (!response.ok) return

      const data = (await response.json()) as {
        chunks?: Array<{ chunkId: string; status: string }>
      }

      if (data.chunks) {
        setPipelineChunks((prev) =>
          prev.map((c) => {
            const serverChunk = data.chunks?.find((sc) => sc.chunkId === c.chunkId)
            if (serverChunk) {
              return { ...c, status: serverChunk.status as ChunkStatus }
            }
            return c
          }),
        )
      }
    } catch {
      // Best effort
    }
  }, [serverUrl, sessionId])

  /**
   * Trigger cleanup of acked chunks.
   */
  const cleanup = useCallback(async () => {
    const cleaned = await cleanupAckedChunks()
    if (cleaned > 0) {
      setPipelineChunks((prev) => prev.filter((c) => c.status !== "acked"))
    }
    return cleaned
  }, [])

  /**
   * Fetch all transcripts for the current session.
   */
  const fetchTranscripts = useCallback(async () => {
    try {
      const response = await fetch(
        `${serverUrl}/api/chunks/transcripts/${sessionId}`,
      )
      if (!response.ok) return
      const data = (await response.json()) as { transcripts?: TranscriptRow[] }
      if (data.transcripts) {
        const sorted = [...data.transcripts].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        )
        setTranscripts(sorted)
      }
    } catch {
      // Best effort
    }
  }, [serverUrl, sessionId])

  // Poll transcripts while worker is running (or pipeline has chunks)
  useEffect(() => {
    fetchTranscripts()
    const interval = setInterval(fetchTranscripts, transcriptPollMs)
    return () => clearInterval(interval)
  }, [fetchTranscripts, transcriptPollMs])

  /**
   * Wipe everything: worker state, OPFS, IDB, in-memory pipeline,
   * transcripts, object URLs, and rotate sessionId so a new session starts clean.
   */
  const clearAll = useCallback(async () => {
    workerRef.current?.stop()
    setIsWorkerRunning(false)

    for (const url of urlsRef.current.values()) {
      URL.revokeObjectURL(url)
    }
    urlsRef.current.clear()

    await clearAllChunks()

    setPipelineChunks([])
    setTranscripts([])

    const newSessionId = crypto.randomUUID()
    if (typeof window !== "undefined") {
      sessionStorage.setItem(SESSION_KEY, newSessionId)
    }
    setSessionId(newSessionId)

    if (autoStart) {
      workerRef.current?.start()
      setIsWorkerRunning(true)
    }
  }, [autoStart])

  /**
   * Start/stop the upload worker.
   */
  const startWorker = useCallback(() => {
    workerRef.current?.start()
    setIsWorkerRunning(true)
  }, [])

  const stopWorker = useCallback(() => {
    workerRef.current?.stop()
    setIsWorkerRunning(false)
  }, [])

  return {
    sessionId,
    pipelineChunks,
    transcripts,
    isWorkerRunning,
    ingestChunk,
    fetchServerStatus,
    fetchTranscripts,
    cleanup,
    clearAll,
    startWorker,
    stopWorker,
  }
}
