import { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/errors";
import { getUserById } from "../users/users.service";

export type AdminPermission = "finance" | "moderation" | "analytics";

// role=admin always has every permission implicitly (BR-ADM-03's "full
// admin" tier); role=sub_admin needs the specific permission on their own
// user row. Checked against the DB rather than trusted from the JWT, since
// the JWT only carries role — a permission grant/revoke this way takes
// effect on the sub-admin's very next request, not just their next login.
//
// The existence lookup below runs for a full admin too, not just sub_admin —
// a JWT stays valid for its full TTL even if the admin row behind it is
// deleted in the meantime (account removed, or a DB reset). Without this,
// req.user.sub gets written straight into FK-constrained columns downstream
// (kyc_submissions.reviewed_by_admin_id, audit_logs.admin_id) and a
// nonexistent id throws a raw Postgres FK violation — an unhandled 500
// instead of a clean session error.
export function requireAdminPermission(permission: AdminPermission) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (!req.user || (req.user.role !== "admin" && req.user.role !== "sub_admin")) {
      next(new AppError(403, "Admin access required"));
      return;
    }

    const admin = await getUserById(req.user.sub);
    if (!admin) {
      next(new AppError(401, "Your session is no longer valid — please log in again"));
      return;
    }
    if (req.user.role === "admin") {
      next();
      return;
    }

    if (!admin.permissions.includes(permission)) {
      next(new AppError(403, `Missing '${permission}' admin permission`));
      return;
    }
    next();
  };
}
