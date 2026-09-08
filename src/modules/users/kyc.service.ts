import { and, count, desc, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { kycDocuments, kycSubmissions, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateDownloadUrl } from "../../lib/s3";

type KycSubmission = typeof kycSubmissions.$inferSelect;
type DocumentInput = { documentType: (typeof kycDocuments.$inferSelect)["documentType"]; key: string };

// One row per attempt (BR-ACC-03/04) — replaces the old single
// users.kycDocumentKey column, which had no history and only ever held one
// document. attemptNumber is computed here (not a DB sequence) since it's
// scoped per-user: this user's 1st, 2nd, 3rd... submission, not a global
// counter.
export async function createSubmission(userId: string, documents: DocumentInput[]): Promise<KycSubmission> {
  const [{ value: priorCount }] = await db
    .select({ value: count() })
    .from(kycSubmissions)
    .where(eq(kycSubmissions.userId, userId));

  return db.transaction(async (tx) => {
    const [submission] = await tx
      .insert(kycSubmissions)
      .values({ userId, attemptNumber: priorCount + 1 })
      .returning();

    await tx.insert(kycDocuments).values(
      documents.map((d) => ({ submissionId: submission.id, documentType: d.documentType, objectKey: d.key })),
    );
    await tx.update(users).set({ kycStatus: "pending", updatedAt: new Date() }).where(eq(users.id, userId));

    return submission;
  });
}

export async function getLatestSubmission(userId: string): Promise<KycSubmission | undefined> {
  const [row] = await db
    .select()
    .from(kycSubmissions)
    .where(eq(kycSubmissions.userId, userId))
    .orderBy(desc(kycSubmissions.attemptNumber))
    .limit(1);
  return row;
}

export async function getLatestPendingSubmission(userId: string): Promise<KycSubmission | undefined> {
  const [row] = await db
    .select()
    .from(kycSubmissions)
    .where(and(eq(kycSubmissions.userId, userId), eq(kycSubmissions.status, "pending")))
    .orderBy(desc(kycSubmissions.attemptNumber))
    .limit(1);
  return row;
}

// Presigns a fresh download URL per document rather than storing one —
// same "URLs expire, keys don't" reasoning as the column this replaced.
export async function getSubmissionDocuments(submissionId: string) {
  const rows = await db.select().from(kycDocuments).where(eq(kycDocuments.submissionId, submissionId));
  return Promise.all(
    rows.map(async (doc) => ({
      documentType: doc.documentType,
      documentViewUrl: await generateDownloadUrl(doc.objectKey),
    })),
  );
}

export async function decideSubmission(
  submissionId: string,
  decision: "approve" | "reject",
  adminId: string,
  reason?: string,
): Promise<KycSubmission> {
  const [submission] = await db.select().from(kycSubmissions).where(eq(kycSubmissions.id, submissionId)).limit(1);
  if (!submission) throw new AppError(404, "KYC submission not found");
  if (submission.status !== "pending") throw new AppError(409, `Submission is ${submission.status}, not pending`);

  const [updated] = await db
    .update(kycSubmissions)
    .set({
      status: decision === "approve" ? "approved" : "rejected",
      reviewedByAdminId: adminId,
      reviewedAt: new Date(),
      rejectionReason: decision === "reject" ? reason : null,
    })
    .where(eq(kycSubmissions.id, submissionId))
    .returning();

  return updated;
}
