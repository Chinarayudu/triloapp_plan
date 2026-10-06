import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env";

const s3Configured = Boolean(
  env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION && env.AWS_S3_BUCKET_NAME,
);

const s3Client = s3Configured
  ? new S3Client({
      region: env.AWS_REGION,
      credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY! },
      // MinIO (CI/local dev) needs both: a fixed endpoint instead of
      // resolving *.amazonaws.com, and path-style addressing since it
      // doesn't do virtual-hosted-style (bucket.endpoint) by default.
      ...(env.AWS_S3_ENDPOINT ? { endpoint: env.AWS_S3_ENDPOINT, forcePathStyle: true } : {}),
    })
  : undefined;

const UPLOAD_URL_EXPIRY_SECONDS = 5 * 60;
const DOWNLOAD_URL_EXPIRY_SECONDS = 5 * 60;

function requireS3Client(): S3Client {
  if (!s3Client) {
    throw new Error(
      "Object storage not configured — set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_REGION/AWS_S3_BUCKET_NAME",
    );
  }
  return s3Client;
}

// Presigning is a local HMAC computation, not a network call — this is
// cheap and safe to run in every environment, including tests, unlike the
// OTP/dev-credit stubs elsewhere which exist specifically to avoid real
// network calls.
export async function generateUploadUrl(key: string, contentType: string): Promise<string> {
  const client = requireS3Client();
  const command = new PutObjectCommand({ Bucket: env.AWS_S3_BUCKET_NAME, Key: key, ContentType: contentType });
  return getSignedUrl(client, command, { expiresIn: UPLOAD_URL_EXPIRY_SECONDS });
}

export async function generateDownloadUrl(key: string, expiresInSeconds: number = DOWNLOAD_URL_EXPIRY_SECONDS): Promise<string> {
  const client = requireS3Client();
  const command = new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET_NAME, Key: key });
  return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
}

// Size and type of an uploaded object, or null if nothing was uploaded under
// that key. A presigned PUT can't cap the upload's size, so callers check it
// here before using the object.
export async function getObjectInfo(key: string): Promise<{ sizeBytes: number; contentType: string | null } | null> {
  const client = requireS3Client();
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: env.AWS_S3_BUCKET_NAME, Key: key }));
    return { sizeBytes: head.ContentLength ?? 0, contentType: head.ContentType ?? null };
  } catch (err) {
    if (err instanceof Error && (err.name === "NotFound" || err.name === "NoSuchKey")) return null;
    throw err;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await requireS3Client().send(new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET_NAME, Key: key }));
}

export function getBucketName(): string {
  requireS3Client();
  return env.AWS_S3_BUCKET_NAME!;
}

// Gallery media is meant to be publicly viewable on a host's profile,
// unlike KYC docs — this builds the final URL to store, not a short-lived
// presigned one. Requires the bucket (or this key's prefix) to actually be
// configured public-read; that's an S3 bucket-policy setting, not something
// this code can enforce.
export function getPublicUrl(key: string): string {
  if (env.AWS_S3_ENDPOINT) {
    return `${env.AWS_S3_ENDPOINT}/${env.AWS_S3_BUCKET_NAME}/${key}`; // MinIO path-style (CI/local dev)
  }
  return `https://${env.AWS_S3_BUCKET_NAME}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
}
