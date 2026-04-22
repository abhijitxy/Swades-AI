/**
 * OPFS (Origin Private File System) based durable storage for audio chunks.
 *
 * Every chunk is persisted to OPFS before any network calls.
 * Metadata is tracked in IndexedDB for status, retries, and timestamps.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type ChunkStatus = "local" | "uploading" | "uploaded" | "acked" | "failed" | "cleaned"

export interface ChunkMetadata {
  chunkId: string
  sessionId: string
  status: ChunkStatus
  retries: number
  durationMs: number
  createdAt: number
  updatedAt: number
  lastAttemptAt: number | null
  errorMessage: string | null
  serverChecksum: string | null
}

// ─── IndexedDB helpers ──────────────────────────────────────────────────────

const DB_NAME = "audio-chunks-meta"
const DB_VERSION = 1
const STORE_NAME = "chunks"

function openMetaDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "chunkId" })
        store.createIndex("status", "status", { unique: false })
        store.createIndex("sessionId", "sessionId", { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

// ─── OPFS helpers ───────────────────────────────────────────────────────────

const OPFS_DIR = "audio-chunks"

async function getChunksDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(OPFS_DIR, { create: true })
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Save an audio chunk to OPFS and record metadata in IndexedDB.
 */
export async function saveChunkToOpfs(
  chunkId: string,
  sessionId: string,
  blob: Blob,
  durationMs: number,
): Promise<void> {
  // 1. Write audio file to OPFS
  const dir = await getChunksDir()
  const fileHandle = await dir.getFileHandle(`${chunkId}.wav`, { create: true })
  const writable = await fileHandle.createWritable()
  await writable.write(blob)
  await writable.close()

  // 2. Store metadata
  const metadata: ChunkMetadata = {
    chunkId,
    sessionId,
    status: "local",
    retries: 0,
    durationMs,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastAttemptAt: null,
    errorMessage: null,
    serverChecksum: null,
  }

  const db = await openMetaDb()
  const tx = db.transaction(STORE_NAME, "readwrite")
  tx.objectStore(STORE_NAME).put(metadata)
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

/**
 * Read a chunk's audio data from OPFS.
 */
export async function readChunkFromOpfs(chunkId: string): Promise<Blob | null> {
  try {
    const dir = await getChunksDir()
    const fileHandle = await dir.getFileHandle(`${chunkId}.wav`)
    return await fileHandle.getFile()
  } catch {
    return null
  }
}

/**
 * Update chunk metadata status.
 */
export async function updateChunkStatus(
  chunkId: string,
  status: ChunkStatus,
  extra?: Partial<Pick<ChunkMetadata, "retries" | "errorMessage" | "serverChecksum" | "lastAttemptAt">>,
): Promise<void> {
  const db = await openMetaDb()
  const tx = db.transaction(STORE_NAME, "readwrite")
  const store = tx.objectStore(STORE_NAME)

  const existing = await idbRequest(store.get(chunkId)) as ChunkMetadata | undefined
  if (!existing) {
    db.close()
    return
  }

  const updated: ChunkMetadata = {
    ...existing,
    ...extra,
    status,
    updatedAt: Date.now(),
  }

  store.put(updated)
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

/**
 * Get all chunks with a specific status.
 */
export async function getChunksByStatus(status: ChunkStatus): Promise<ChunkMetadata[]> {
  const db = await openMetaDb()
  const tx = db.transaction(STORE_NAME, "readonly")
  const index = tx.objectStore(STORE_NAME).index("status")
  const result = await idbRequest(index.getAll(status)) as ChunkMetadata[]
  db.close()
  return result
}

/**
 * Get all chunks for a session.
 */
export async function getChunksBySession(sessionId: string): Promise<ChunkMetadata[]> {
  const db = await openMetaDb()
  const tx = db.transaction(STORE_NAME, "readonly")
  const index = tx.objectStore(STORE_NAME).index("sessionId")
  const result = await idbRequest(index.getAll(sessionId)) as ChunkMetadata[]
  db.close()
  return result
}

/**
 * Get all chunk metadata.
 */
export async function getAllChunkMeta(): Promise<ChunkMetadata[]> {
  const db = await openMetaDb()
  const tx = db.transaction(STORE_NAME, "readonly")
  const result = await idbRequest(tx.objectStore(STORE_NAME).getAll()) as ChunkMetadata[]
  db.close()
  return result
}

/**
 * Delete a chunk from OPFS and IndexedDB.
 * Only call after both bucket and DB are confirmed consistent.
 */
export async function cleanupChunk(chunkId: string): Promise<void> {
  // Remove file from OPFS
  try {
    const dir = await getChunksDir()
    await dir.removeEntry(`${chunkId}.wav`)
  } catch {
    // File may already be gone
  }

  // Remove metadata
  const db = await openMetaDb()
  const tx = db.transaction(STORE_NAME, "readwrite")
  tx.objectStore(STORE_NAME).delete(chunkId)
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
  db.close()
}

/**
 * Clean up all acked chunks that have been verified server-side.
 */
export async function cleanupAckedChunks(): Promise<number> {
  const acked = await getChunksByStatus("acked")
  let cleaned = 0

  for (const chunk of acked) {
    await cleanupChunk(chunk.chunkId)
    cleaned++
  }

  return cleaned
}

/**
 * Nuke every chunk: wipes OPFS directory and clears the IndexedDB store.
 * Used by the "Clear All" action so state on disk matches state in memory.
 */
export async function clearAllChunks(): Promise<void> {
  try {
    const dir = await getChunksDir()
    const iter = (dir as unknown as { keys?: () => AsyncIterable<string> }).keys?.()
    if (iter) {
      for await (const name of iter) {
        await dir.removeEntry(name).catch(() => {})
      }
    }
  } catch {
    // OPFS may be unavailable; continue to IDB cleanup
  }

  try {
    const db = await openMetaDb()
    const tx = db.transaction(STORE_NAME, "readwrite")
    tx.objectStore(STORE_NAME).clear()
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  } catch {
    // Best effort
  }
}
