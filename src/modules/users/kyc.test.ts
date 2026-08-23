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
});

describe("KYC document upload", () => {
  let keyToCleanUp: string | undefined;

  afterEach(async () => {
    if (keyToCleanUp) {
      await s3.send(new DeleteObjectCommand({ Bucket: env.AWS_S3_BUCKET_NAME, Key: keyToCleanUp }));
      keyToCleanUp = undefined;
    }
  });

  it("uploads a real file to S3, submits it, and can view it back via a presigned URL", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app);

    const uploadUrlRes = await request(app)
      .post("/me/kyc/upload-url")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ contentType: "application/pdf" });
    expect(uploadUrlRes.status).toBe(200);
    expect(uploadUrlRes.body.key).toMatch(/^kyc\//);
    keyToCleanUp = uploadUrlRes.body.key;

    const fileContent = "fake pdf content for test";
    const putRes = await fetch(uploadUrlRes.body.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: fileContent,
    });
    expect(putRes.status).toBe(200);

    const submitRes = await request(app)
      .post("/me/kyc")
      .set("Authorization", `Bearer ${accessToken}`)
      .send({ key: uploadUrlRes.body.key });
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.kycStatus).toBe("pending");

    const viewRes = await request(app).get("/me/kyc").set("Authorization", `Bearer ${accessToken}`);
    expect(viewRes.status).toBe(200);
    expect(viewRes.body.kycStatus).toBe("pending");
    expect(viewRes.body.documentViewUrl).toBeTruthy();

    const downloaded = await fetch(viewRes.body.documentViewUrl);
    expect(await downloaded.text()).toBe(fileContent);
  });

  it("returns no documentViewUrl when nothing has been submitted yet", async () => {
    const app = createApp();
    const { accessToken } = await registerAndLogin(app);
    const res = await request(app).get("/me/kyc").set("Authorization", `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.kycStatus).toBe("not_submitted");
    expect(res.body.documentViewUrl).toBeNull();
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
      .send({ key: "kyc/some-other-user-id/file.pdf" });
    expect(res.status).toBe(403);
  });
});
