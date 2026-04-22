import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { env } from "@my-better-t-app/env/server";

let _client: S3Client | null = null;

export function getS3Client(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY,
        secretAccessKey: env.S3_SECRET_KEY,
      },
    });
  }
  return _client;
}

export async function ensureBucket(): Promise<void> {
  const client = getS3Client();
  try {
    await client.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
  }
}

export async function uploadChunkToS3(
  key: string,
  body: Uint8Array | Buffer,
  contentType = "audio/wav",
): Promise<{ etag: string }> {
  const client = getS3Client();
  const result = await client.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
  return { etag: result.ETag ?? "" };
}

export async function chunkExistsInS3(key: string): Promise<boolean> {
  const client = getS3Client();
  try {
    await client.send(
      new HeadObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export async function getChunkFromS3(key: string): Promise<Uint8Array | null> {
  const client = getS3Client();
  try {
    const result = await client.send(
      new GetObjectCommand({
        Bucket: env.S3_BUCKET,
        Key: key,
      }),
    );
    if (!result.Body) return null;
    return new Uint8Array(await result.Body.transformToByteArray());
  } catch {
    return null;
  }
}
