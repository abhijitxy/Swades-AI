"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import { Download, Mic, Pause, Play, RefreshCw, Square, Trash2 } from "lucide-react"

import { Button } from "@my-better-t-app/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@my-better-t-app/ui/components/card"
import { LiveWaveform } from "@/components/ui/live-waveform"
import { ChunkProgress, ChunkStatusBadge } from "@/components/ui/chunk-status"
import { useRecorder, type WavChunk } from "@/hooks/use-recorder"
import { useChunkPipeline, type PipelineChunk } from "@/hooks/use-chunk-pipeline"
import { env } from "@my-better-t-app/env/web"
import type { ChunkStatus } from "@/lib/opfs-store"

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  const ms = Math.floor((seconds % 1) * 10)
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${ms}`
}

function formatDuration(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`
}

function ChunkRow({
  chunk,
  pipeline,
  index,
}: {
  chunk: WavChunk
  pipeline?: PipelineChunk
  index: number
}) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)

  const toggle = () => {
    const el = audioRef.current
    if (!el) return
    if (playing) {
      el.pause()
      el.currentTime = 0
      setPlaying(false)
    } else {
      el.play()
      setPlaying(true)
    }
  }

  const download = () => {
    const a = document.createElement("a")
    a.href = chunk.url
    a.download = `chunk-${index + 1}.wav`
    a.click()
  }

  const status: ChunkStatus = pipeline?.status ?? "local"

  return (
    <div className="flex items-center justify-between gap-3 rounded-sm border border-border/50 bg-muted/30 px-3 py-2">
      <audio
        ref={audioRef}
        src={pipeline?.url ?? chunk.url}
        onEnded={() => setPlaying(false)}
        preload="none"
      />
      <span className="text-xs font-medium text-muted-foreground tabular-nums">
        #{index + 1}
      </span>
      <span className="text-xs tabular-nums">{formatDuration(chunk.duration * 1000)}</span>
      <span className="text-[10px] text-muted-foreground">16kHz PCM</span>

      {/* Status badge */}
      <ChunkStatusBadge
        status={status}
        retries={pipeline?.retries}
        errorMessage={pipeline?.errorMessage}
      />

      <div className="ml-auto flex gap-1">
        <Button variant="ghost" size="icon-xs" onClick={toggle}>
          {playing ? <Square className="size-3" /> : <Play className="size-3" />}
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={download}>
          <Download className="size-3" />
        </Button>
      </div>
    </div>
  )
}

export default function RecorderPage() {
  const [deviceId] = useState<string | undefined>()
  const { status, start, stop, pause, resume, chunks, elapsed, stream, clearChunks } =
    useRecorder({ chunkDuration: 5, deviceId })

  const {
    sessionId,
    pipelineChunks,
    transcripts,
    isWorkerRunning,
    ingestChunk,
    fetchServerStatus,
    fetchTranscripts,
    cleanup,
    clearAll,
  } = useChunkPipeline({
    serverUrl: env.NEXT_PUBLIC_SERVER_URL,
    autoStart: true,
  })

  const isRecording = status === "recording"
  const isPaused = status === "paused"
  const isActive = isRecording || isPaused

  // Ingest new chunks into the pipeline as they arrive
  const lastIngestedRef = useRef(0)

  // Watch for new chunks and ingest them
  const ingestNewChunks = useCallback(async () => {
    const newChunks = chunks.slice(lastIngestedRef.current)
    for (const chunk of newChunks) {
      await ingestChunk(chunk.id, chunk.blob, chunk.duration * 1000)
    }
    lastIngestedRef.current = chunks.length
  }, [chunks, ingestChunk])

  // Auto-ingest when chunks change
  if (chunks.length > lastIngestedRef.current) {
    ingestNewChunks()
  }

  const handlePrimary = useCallback(() => {
    if (isActive) {
      stop()
    } else {
      lastIngestedRef.current = 0
      start()
    }
  }, [isActive, stop, start])

  const handleClearAll = useCallback(async () => {
    clearChunks()
    await clearAll()
    lastIngestedRef.current = 0
  }, [clearChunks, clearAll])

  // Status counts
  const statusCounts = useMemo(() => {
    const counts: Record<ChunkStatus, number> = {
      local: 0,
      uploading: 0,
      uploaded: 0,
      acked: 0,
      failed: 0,
      cleaned: 0,
    }
    for (const c of pipelineChunks) {
      counts[c.status]++
    }
    return counts
  }, [pipelineChunks])

  return (
    <div className="container mx-auto flex max-w-lg flex-col items-center gap-6 px-4 py-8">
      <Card className="w-full">
        <CardHeader>
          <CardTitle>Recorder</CardTitle>
          <CardDescription>
            16 kHz / 16-bit PCM WAV — chunked every 5 s
            <br />
            <span className="text-[10px] text-muted-foreground">
              Session: {sessionId.slice(0, 8)}… • Worker: {isWorkerRunning ? "🟢 Active" : "🔴 Stopped"}
            </span>
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          {/* Waveform */}
          <div className="overflow-hidden rounded-sm border border-border/50 bg-muted/20 text-foreground">
            <LiveWaveform
              active={isRecording}
              processing={isPaused}
              stream={stream}
              height={80}
              barWidth={3}
              barGap={1}
              barRadius={2}
              sensitivity={1.8}
              smoothingTimeConstant={0.85}
              fadeEdges
              fadeWidth={32}
              mode="static"
            />
          </div>

          {/* Timer */}
          <div className="text-center font-mono text-3xl tabular-nums tracking-tight">
            {formatTime(elapsed)}
          </div>

          {/* Controls */}
          <div className="flex items-center justify-center gap-3">
            {/* Record / Stop */}
            <Button
              size="lg"
              variant={isActive ? "destructive" : "default"}
              className="gap-2 px-5"
              onClick={handlePrimary}
              disabled={status === "requesting"}
            >
              {isActive ? (
                <>
                  <Square className="size-4" />
                  Stop
                </>
              ) : (
                <>
                  <Mic className="size-4" />
                  {status === "requesting" ? "Requesting..." : "Record"}
                </>
              )}
            </Button>

            {/* Pause / Resume */}
            {isActive && (
              <Button
                size="lg"
                variant="outline"
                className="gap-2"
                onClick={isPaused ? resume : pause}
              >
                {isPaused ? (
                  <>
                    <Play className="size-4" />
                    Resume
                  </>
                ) : (
                  <>
                    <Pause className="size-4" />
                    Pause
                  </>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Pipeline Status */}
      {pipelineChunks.length > 0 && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Pipeline</CardTitle>
            <CardDescription>
              {pipelineChunks.length} chunks • {statusCounts.acked} synced
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {/* Progress bar */}
            <ChunkProgress total={pipelineChunks.length} byStatus={statusCounts} />

            {/* Chunk list */}
            {chunks.map((chunk, i) => {
              const pipeline = pipelineChunks.find((p) => p.chunkId === chunk.id)
              return (
                <ChunkRow key={chunk.id} chunk={chunk} pipeline={pipeline} index={i} />
              )
            })}

            {/* Restored chunks not in current recording */}
            {pipelineChunks
              .filter((p) => !chunks.some((c) => c.id === p.chunkId))
              .map((p, i) => (
                <div
                  key={p.chunkId}
                  className="flex items-center justify-between gap-3 rounded-sm border border-border/50 bg-muted/20 px-3 py-2"
                >
                  <span className="text-xs font-medium text-muted-foreground tabular-nums">
                    Prev #{i + 1}
                  </span>
                  <span className="text-xs tabular-nums">{formatDuration(p.durationMs)}</span>
                  <ChunkStatusBadge
                    status={p.status}
                    retries={p.retries}
                    errorMessage={p.errorMessage}
                  />
                </div>
              ))}

            {/* Action buttons */}
            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={fetchServerStatus}
              >
                <RefreshCw className="size-3" />
                Sync Status
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={cleanup}
              >
                <Trash2 className="size-3" />
                Cleanup Acked
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-destructive"
                onClick={handleClearAll}
              >
                <Trash2 className="size-3" />
                Clear All
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Transcripts */}
      {(transcripts.length > 0 || pipelineChunks.some((c) => c.status === "acked")) && (
        <Card className="w-full">
          <CardHeader>
            <CardTitle>Transcript</CardTitle>
            <CardDescription>
              {transcripts.length} transcribed • auto-refreshing
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {transcripts.length === 0 ? (
              <div className="rounded-sm border border-dashed border-border/50 bg-muted/20 p-3 text-center text-xs text-muted-foreground">
                Waiting for transcription… chunks are being processed on the server.
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {transcripts.map((t, i) => (
                  <div
                    key={t.id}
                    className="rounded-sm border border-border/50 bg-muted/20 p-3"
                  >
                    <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                      <span className="tabular-nums">#{i + 1}</span>
                      <span className="font-mono">
                        {t.chunkId.slice(0, 8)}…
                      </span>
                      <span className="flex items-center gap-2">
                        {t.language && <span>{t.language}</span>}
                        {typeof t.confidence === "number" && (
                          <span>{t.confidence}%</span>
                        )}
                        {typeof t.processingTimeMs === "number" && (
                          <span>{(t.processingTimeMs / 1000).toFixed(1)}s</span>
                        )}
                      </span>
                    </div>
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">
                      {t.cleanedText ?? t.rawText}
                    </p>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                onClick={fetchTranscripts}
              >
                <RefreshCw className="size-3" />
                Refresh
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
