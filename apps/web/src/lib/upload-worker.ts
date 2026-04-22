/**
 * Background upload worker — reads pending chunks from OPFS and uploads
 * to the server with exponential backoff retry.
 */

import {
  getChunksByStatus,
  readChunkFromOpfs,
  updateChunkStatus,
  type ChunkMetadata,
} from "./opfs-store"

// ─── Config ─────────────────────────────────────────────────────────────────

const MAX_RETRIES = 8
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 60000
const UPLOAD_INTERVAL_MS = 2000
const RECONCILE_INTERVAL_MS = 30000

// ─── Types ──────────────────────────────────────────────────────────────────

export type UploadEventType = "upload-start" | "upload-success" | "upload-fail" | "status-change"

export interface UploadEvent {
  type: UploadEventType
  chunkId: string
  status?: string
  error?: string
}

type UploadEventListener = (event: UploadEvent) => void

// ─── Worker ─────────────────────────────────────────────────────────────────

export class ChunkUploadWorker {
  private serverUrl: string
  private running = false
  private uploadTimer: ReturnType<typeof setInterval> | null = null
  private reconcileTimer: ReturnType<typeof setInterval> | null = null
  private listeners: UploadEventListener[] = []
  private activeUploads = new Set<string>()

  constructor(serverUrl: string) {
    this.serverUrl = serverUrl
  }

  /**
   * Subscribe to upload events.
   */
  on(listener: UploadEventListener): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener)
    }
  }

  private emit(event: UploadEvent): void {
    for (const listener of this.listeners) {
      listener(event)
    }
  }

  /**
   * Start the background upload loop.
   */
  start(): void {
    if (this.running) return
    this.running = true

    // Upload loop
    this.uploadTimer = setInterval(() => {
      this.processQueue()
    }, UPLOAD_INTERVAL_MS)

    // Reconciliation loop
    this.reconcileTimer = setInterval(() => {
      this.reconcile()
    }, RECONCILE_INTERVAL_MS)

    // Process immediately on start
    this.processQueue()
  }

  /**
   * Stop the background upload loop.
   */
  stop(): void {
    this.running = false
    if (this.uploadTimer) {
      clearInterval(this.uploadTimer)
      this.uploadTimer = null
    }
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer)
      this.reconcileTimer = null
    }
  }

  /**
   * Process the pending upload queue.
   */
  private async processQueue(): Promise<void> {
    if (!this.running) return

    // Get all chunks that need uploading
    const localChunks = await getChunksByStatus("local")
    const failedChunks = (await getChunksByStatus("failed")).filter(
      (c) => c.retries < MAX_RETRIES,
    )

    const pending = [...localChunks, ...failedChunks]

    for (const chunk of pending) {
      if (this.activeUploads.has(chunk.chunkId)) continue
      this.uploadChunk(chunk)
    }
  }

  /**
   * Upload a single chunk with retries.
   */
  private async uploadChunk(chunk: ChunkMetadata): Promise<void> {
    if (this.activeUploads.has(chunk.chunkId)) return
    this.activeUploads.add(chunk.chunkId)

    try {
      this.emit({ type: "upload-start", chunkId: chunk.chunkId })
      await updateChunkStatus(chunk.chunkId, "uploading", {
        lastAttemptAt: Date.now(),
      })
      this.emit({ type: "status-change", chunkId: chunk.chunkId, status: "uploading" })

      // Read from OPFS
      const blob = await readChunkFromOpfs(chunk.chunkId)
      if (!blob) {
        await updateChunkStatus(chunk.chunkId, "failed", {
          errorMessage: "Chunk not found in OPFS",
        })
        this.emit({
          type: "upload-fail",
          chunkId: chunk.chunkId,
          error: "Chunk not found in OPFS",
        })
        return
      }

      // Build form data
      const formData = new FormData()
      formData.append("chunkId", chunk.chunkId)
      formData.append("sessionId", chunk.sessionId)
      formData.append("file", blob, `${chunk.chunkId}.wav`)
      formData.append("durationMs", String(chunk.durationMs))

      // Upload with retry logic
      const response = await this.fetchWithRetry(
        `${this.serverUrl}/api/chunks/upload`,
        {
          method: "POST",
          body: formData,
        },
        chunk,
      )

      if (!response) {
        return // retries exhausted, status already updated
      }

      const data = (await response.json()) as {
        success?: boolean
        status?: string
        chunkId?: string
        checksum?: string
        error?: string
      }

      if (data.success) {
        await updateChunkStatus(chunk.chunkId, "acked", {
          serverChecksum: data.checksum ?? null,
          retries: chunk.retries,
        })
        this.emit({
          type: "upload-success",
          chunkId: chunk.chunkId,
          status: "acked",
        })
        this.emit({
          type: "status-change",
          chunkId: chunk.chunkId,
          status: "acked",
        })
      } else {
        await updateChunkStatus(chunk.chunkId, "failed", {
          errorMessage: data.error ?? "Upload failed",
          retries: chunk.retries + 1,
        })
        this.emit({
          type: "upload-fail",
          chunkId: chunk.chunkId,
          error: data.error ?? "Upload failed",
        })
      }
    } finally {
      this.activeUploads.delete(chunk.chunkId)
    }
  }

  /**
   * Fetch with exponential backoff retry.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    chunk: ChunkMetadata,
    attempt = 0,
  ): Promise<Response | null> {
    try {
      const response = await fetch(url, init)

      if (response.ok || response.status === 409) {
        return response
      }

      // Server error — retry
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)
        const jitter = delay * (0.5 + Math.random() * 0.5)
        await sleep(jitter)
        return this.fetchWithRetry(url, init, chunk, attempt + 1)
      }

      return response
    } catch (err) {
      // Network error — retry
      if (attempt < MAX_RETRIES) {
        const delay = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS)
        const jitter = delay * (0.5 + Math.random() * 0.5)
        await sleep(jitter)

        await updateChunkStatus(chunk.chunkId, "failed", {
          retries: chunk.retries + attempt + 1,
          errorMessage: err instanceof Error ? err.message : "Network error",
          lastAttemptAt: Date.now(),
        })

        return this.fetchWithRetry(url, init, chunk, attempt + 1)
      }

      await updateChunkStatus(chunk.chunkId, "failed", {
        retries: chunk.retries + attempt + 1,
        errorMessage: err instanceof Error ? err.message : "Network error",
      })
      this.emit({
        type: "upload-fail",
        chunkId: chunk.chunkId,
        error: err instanceof Error ? err.message : "Network error",
      })

      return null
    }
  }

  /**
   * Client-side reconciliation: verify acked chunks with server.
   */
  private async reconcile(): Promise<void> {
    if (!this.running) return

    try {
      const ackedChunks = await getChunksByStatus("acked")
      if (ackedChunks.length === 0) return

      const chunkIds = ackedChunks.map((c) => c.chunkId)

      const response = await fetch(`${this.serverUrl}/api/chunks/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunkIds }),
      })

      if (!response.ok) return

      const data = (await response.json()) as { missing?: string[] }
      const missing = data.missing ?? []

      // Re-queue missing chunks for re-upload
      for (const chunkId of missing) {
        await updateChunkStatus(chunkId, "local", {
          retries: 0,
          errorMessage: "Re-upload needed — missing from server bucket",
        })
        this.emit({
          type: "status-change",
          chunkId,
          status: "local",
        })
      }
    } catch {
      // Reconciliation is best-effort
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
