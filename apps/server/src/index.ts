import { env } from "@my-better-t-app/env/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import { ensureBucket } from "./lib/s3";
import { chunksRouter } from "./routes/chunks";
import { transcriptionRouter } from "./routes/transcription";

const app = new Hono();

app.onError((err, c) => {
  console.error("[unhandled error]", {
    path: c.req.path,
    method: c.req.method,
    message: err.message,
    stack: err.stack,
    cause: (err as { cause?: unknown }).cause,
  });
  return c.json(
    {
      error: "Internal server error",
      message: err.message,
      path: c.req.path,
    },
    500,
  );
});

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 86400,
  }),
);

// Health check
app.get("/", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Mount routes
app.route("/api/chunks", chunksRouter);
app.route("/api/transcription", transcriptionRouter);

// Ensure S3 bucket exists on startup
ensureBucket().catch((err) => {
  console.error("Failed to ensure S3 bucket:", err);
});

export default app;
