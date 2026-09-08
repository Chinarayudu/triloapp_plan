import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../app";
import { env } from "../../config/env";
import { registerAndLogin } from "../../test/helpers";

// Presigned URLs are generated locally (no network call), but this suite
// also exercises the real S3 round trip (actual PUT + GET against the
// real bucket) rather than mocking it — same "test against the real
// dependency" philosophy already applied to Postgres. Cleans up every
// object it creates.
const s3 = new S3Client({
  region: env.AWS_REGION,
  credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID!, secretAccessKey: env.AWS_SECRET_ACCESS_KEY! },
  ...(env.AWS_S3_ENDPOINT ? { endpoint: env.AWS_S3_ENDPOINT, forcePathStyle: true } : {}),
});

describe("KYC document upload", () => {
  const keysToCleanUp: string[] = [];

  afterEach(async () => {
    while (keysToCleanUp.length > 0) {
      const key = keysToCleanUp.pop()!;
      await s3.send(new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET_NAME, Key: key }));
    }
  });

  it("uploads real files to S3 for two document types, submits them, and can view them back via presigned URLs", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app);

    async function uploadOne(fileContent: string) {
      const uploadUrlRes = await request(app)
        .post("/me/kyc/upload-url")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ contentType: "application/pdf" });
      expect(uploadUrlRes.status).toBe(200);
      expect(uploadUrlRes.body.key).toMatch(/^kyc\//);
      keysToCleanUp.push(uploadUrlRes.body.key);

      const putRes = await fetch(uploadUrlRes.body.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/pdf" },
        body: fileContent,
      });
      expect(putRes.status).toBe(200);
      return uploadUrlRes.body.key as string;
    }

    const frontContent = "fake id-front content for test";
    const selfieContent = "fake selfie content for test";
    const frontKey = await uploadOne(frontContent);
    const selfieKey = await uploadOne(selfieContent);

    const submitRes = await request(app)
      .post("/me/kyc")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        documents: [
          { documentType: "id_front", key: frontKey },
          { documentType: "selfie", key: selfieKey },
        ],
      });
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.kycStatus).toBe("pending");
    expect(submitRes.body.attemptNumber).toBe(1);

    const viewRes = await request(app).get("/me/kyc").set("Authorization", `Bearer ${accessToken}`);
    expect(viewRes.status).toBe(200);
    expect(viewRes.body.kycStatus).toBe("pending");
    expect(viewRes.body.attemptNumber).toBe(1);
    expect(viewRes.body.documents).toHaveLength(2);

    const frontDoc = viewRes.body.documents.find((d: { documentType: string }) => d.documentType === "id_front");
    const downloaded = await fetch(frontDoc.documentViewUrl);
    expect(await downloaded.text()).toBe(frontContent);
  });

  it("returns no documents when nothing has been submitted yet", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app);
    const res = await request(app).get("/me/kyc").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.kycStatus).toBe("not_submitted");
    expect(res.body.attemptNumber).toBeNull();
    expect(res.body.documents).toEqual([]);
  });

  it("rejects an unsupported content type", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app);
    const res = await request(app)
      .post("/me/kyc/upload-url")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ contentType: "text/plain" });
    expect(res.status).toBe(400);
  });

  it("rejects submitting a document key that doesn't belong to the caller", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app);
    const res = await request(app)
      .post("/me/kyc")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ documents: [{ documentType: "id_front", key: "kyc/some-other-user-id/file.pdf" }] });
    expect(res.status).toBe(403);
  });

  it("rejects submitting the same document type twice in one attempt", async () => {
    const app = createApp();
    const { accessToken, user } = await registerAndLogin(app);
    const res = await request(app)
      .post("/me/kyc")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({
        documents: [
          { documentType: "id_front", key: `kyc/${user.id}/a.pdf` },
          { documentType: "id_front", key: `kyc/${user.id}/b.pdf` },
        ],
      });
    expect(res.status).toBe(400);
  });
});
