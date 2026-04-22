import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    CORS_ORIGIN: z.url(),
    NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

    // S3 / MinIO
    S3_ENDPOINT: z.string().min(1).default("http://localhost:9000"),
    S3_REGION: z.string().default("us-east-1"),
    S3_BUCKET: z.string().default("audio-chunks"),
    S3_ACCESS_KEY: z.string().min(1).default("minioadmin"),
    S3_SECRET_KEY: z.string().min(1).default("minioadmin"),
    S3_FORCE_PATH_STYLE: z
      .string()
      .default("true")
      .transform((v) => v === "true"),

    // Transcription
    WHISPER_API_URL: z.string().default("http://localhost:8080"),
    OPENAI_API_KEY: z.string().default(""),
    GROQ_API_KEY: z.string().default(""),
    GROQ_WHISPER_MODEL: z.string().default("whisper-large-v3-turbo"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: false,
});
