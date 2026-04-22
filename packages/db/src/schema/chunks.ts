import { index, integer, pgEnum, pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

export const chunkStatusEnum = pgEnum("chunk_status", [
  "uploaded",
  "acked",
  "processing",
  "transcribed",
  "failed",
]);

export const chunks = pgTable(
  "chunks",
  {
    chunkId: varchar("chunk_id", { length: 64 }).primaryKey(),
    sessionId: varchar("session_id", { length: 64 }).notNull(),
    checksum: varchar("checksum", { length: 128 }).notNull(),
    status: chunkStatusEnum("status").notNull().default("uploaded"),
    bucketKey: text("bucket_key").notNull(),
    durationMs: integer("duration_ms"),
    sampleRate: integer("sample_rate").default(16000),
    retries: integer("retries").default(0),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ackedAt: timestamp("acked_at", { withTimezone: true }),
  },
  (table) => [
    index("chunks_session_idx").on(table.sessionId),
    index("chunks_status_idx").on(table.status),
    index("chunks_created_idx").on(table.createdAt),
  ],
);

export const transcripts = pgTable(
  "transcripts",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    chunkId: varchar("chunk_id", { length: 64 })
      .notNull()
      .references(() => chunks.chunkId),
    sessionId: varchar("session_id", { length: 64 }).notNull(),
    rawText: text("raw_text").notNull(),
    cleanedText: text("cleaned_text"),
    speakers: text("speakers"), // JSON array of speaker segments
    confidence: integer("confidence"), // 0-100
    language: varchar("language", { length: 16 }),
    processingTimeMs: integer("processing_time_ms"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("transcripts_chunk_idx").on(table.chunkId),
    index("transcripts_session_idx").on(table.sessionId),
  ],
);
