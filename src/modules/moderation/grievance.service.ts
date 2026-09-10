import { db } from "../../db/client";
import { grievances } from "../../db/schema";

type GrievanceNature = (typeof grievances.$inferInsert)["natureOfComplaint"];

// The India IT-Rules-style formal complaint form (User app design
// follow-up, Terms & Policies screen's "Grievance Officer... response
// within 15 days") — distinct from moderation.service.ts's createReport:
// slower SLA, structured contact fields, fixed complaint-nature taxonomy,
// file evidence. No admin review screen for this exists yet (not in the
// admin app's design) — submission + storage only for now.
export async function submitGrievance(params: {
  userId: string;
  firstName: string;
  lastName: string;
  contactNumber: string;
  email: string;
  natureOfComplaint: GrievanceNature;
  description: string;
  evidenceKeys: string[];
}) {
  const [row] = await db.insert(grievances).values(params).returning();
  return row;
}
