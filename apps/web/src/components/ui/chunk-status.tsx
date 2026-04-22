"use client"

import type { ChunkStatus } from "@/lib/opfs-store"

const STATUS_CONFIG: Record<
  ChunkStatus,
  { label: string; color: string; bgColor: string; icon: string; pulse: boolean }
> = {
  local: {
    label: "Local",
    color: "text-amber-400",
    bgColor: "bg-amber-400/10 border-amber-400/20",
    icon: "💾",
    pulse: false,
  },
  uploading: {
    label: "Uploading",
    color: "text-blue-400",
    bgColor: "bg-blue-400/10 border-blue-400/20",
    icon: "⬆️",
    pulse: true,
  },
  uploaded: {
    label: "Uploaded",
    color: "text-cyan-400",
    bgColor: "bg-cyan-400/10 border-cyan-400/20",
    icon: "☁️",
    pulse: false,
  },
  acked: {
    label: "Acked",
    color: "text-emerald-400",
    bgColor: "bg-emerald-400/10 border-emerald-400/20",
    icon: "✅",
    pulse: false,
  },
  failed: {
    label: "Failed",
    color: "text-red-400",
    bgColor: "bg-red-400/10 border-red-400/20",
    icon: "❌",
    pulse: false,
  },
  cleaned: {
    label: "Cleaned",
    color: "text-zinc-400",
    bgColor: "bg-zinc-400/10 border-zinc-400/20",
    icon: "🧹",
    pulse: false,
  },
}

interface ChunkStatusBadgeProps {
  status: ChunkStatus
  retries?: number
  errorMessage?: string | null
}

export function ChunkStatusBadge({ status, retries, errorMessage }: ChunkStatusBadgeProps) {
  const config = STATUS_CONFIG[status]

  return (
    <div className="flex items-center gap-1.5">
      <span
        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${config.bgColor} ${config.color}`}
      >
        <span className={config.pulse ? "animate-pulse" : ""}>
          {config.icon}
        </span>
        {config.label}
        {(retries ?? 0) > 0 && (
          <span className="text-muted-foreground">({retries})</span>
        )}
      </span>
      {errorMessage && status === "failed" && (
        <span
          className="max-w-[120px] truncate text-[9px] text-red-400/70"
          title={errorMessage}
        >
          {errorMessage}
        </span>
      )}
    </div>
  )
}

interface ChunkProgressProps {
  total: number
  byStatus: Record<ChunkStatus, number>
}

export function ChunkProgress({ total, byStatus }: ChunkProgressProps) {
  if (total === 0) return null

  const acked = byStatus.acked ?? 0
  const uploading = byStatus.uploading ?? 0
  const failed = byStatus.failed ?? 0
  const local = byStatus.local ?? 0

  const ackedPct = (acked / total) * 100
  const uploadingPct = (uploading / total) * 100
  const failedPct = (failed / total) * 100
  const localPct = (local / total) * 100

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{acked}/{total} acked</span>
        {failed > 0 && <span className="text-red-400">{failed} failed</span>}
      </div>
      <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted/30">
        {ackedPct > 0 && (
          <div className="bg-emerald-400 transition-all" style={{ width: `${ackedPct}%` }} />
        )}
        {uploadingPct > 0 && (
          <div className="animate-pulse bg-blue-400 transition-all" style={{ width: `${uploadingPct}%` }} />
        )}
        {localPct > 0 && (
          <div className="bg-amber-400 transition-all" style={{ width: `${localPct}%` }} />
        )}
        {failedPct > 0 && (
          <div className="bg-red-400 transition-all" style={{ width: `${failedPct}%` }} />
        )}
      </div>
    </div>
  )
}
