import { DetectModerationLabelsCommand, RekognitionClient } from "@aws-sdk/client-rekognition";
import { env } from "../config/env";

// Automated check of chat photos with AWS Rekognition's moderation labels,
// run on the uploaded S3 object before the photo is delivered. Uses the same
// AWS credentials as S3 (the IAM user also needs
// rekognition:DetectModerationLabels). Not run against MinIO (local dev and
// tests), where there's no Rekognition to call.

const moderationConfigured = Boolean(
  env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY && env.AWS_REGION && env.AWS_S3_BUCKET_NAME && !env.AWS_S3_ENDPOINT,
);

const client = moderationConfigured
  ? new RekognitionClient({
      region: env.AWS_REGION,
      credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY! },
    })
  : undefined;

// Top-level Rekognition categories (both label taxonomy versions) that are
// never allowed in chat: 18+ content is prohibited on this platform, and so
// is violent or hateful imagery. Swimwear, alcohol and similar are allowed.
const BLOCKED_CATEGORIES = new Set(["Explicit Nudity", "Explicit", "Violence", "Graphic Violence", "Visually Disturbing", "Hate Symbols"]);
const MIN_CONFIDENCE = 80;

export type ImageCheck = { checked: false } | { checked: true; allowed: boolean; labels: string[] };

// Throws if Rekognition can't be reached — the caller refuses the photo
// rather than delivering it unchecked.
export async function checkChatImage(key: string): Promise<ImageCheck> {
  if (!client) return { checked: false };
  const result = await client.send(
    new DetectModerationLabelsCommand({
      Image: { S3Object: { Bucket: env.AWS_S3_BUCKET_NAME, Name: key } },
      MinConfidence: MIN_CONFIDENCE,
    }),
  );
  const labels = (result.ModerationLabels ?? []).filter(
    (l) => BLOCKED_CATEGORIES.has(l.Name ?? "") || BLOCKED_CATEGORIES.has(l.ParentName ?? ""),
  );
  return { checked: true, allowed: labels.length === 0, labels: labels.map((l) => l.Name ?? "") };
}
