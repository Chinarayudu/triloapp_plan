import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "../config/env";

const s3Configured = Boolean(
  env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION && env.AWS_S3_BUCKET_NAME,
);

const s3Client = s3Configured
  ? new S3Client({
      region: env.AWS_REGION,
      credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY! },
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

export async function generateDownloadUrl(key: string): Promise<string> {
  const client = requireS3Client();
  const command = new GetObjectCommand({ Bucket: env.AWS_S3_BUCKET_NAME, Key: key });
  return getSignedUrl(client, command, { expiresIn: DOWNLOAD_URL_EXPIRY_SECONDS });
}
