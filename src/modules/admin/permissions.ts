import { NextFunction, Request, Response } from "express";
import { AppError } from "../../lib/errors";
import { getUserById } from "../users/users.service";

export type AdminPermission = "finance" | "moderation" | "analytics";

// role=admin always has every permission implicitly (BR-ADM-03's "full
// admin" tier); role=sub_admin needs the specific permission on their own
// user row. Checked against the DB rather than trusted from the JWT, since
// the JWT only carries role — a permission grant/revoke this way takes
// effect on the sub-admin's very next request, not just their next login.
export function requireAdminPermission(permission: AdminPermission) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    if (!req.user || (req.user.role !== "admin" && req.user.role !== "sub_admin")) {
      next(new AppError(403, "Admin access required"));
      return;
    }
    if (req.user.role === "admin") {
      next();
      return;
    }

    const admin = await getUserById(req.user.sub);
    if (!admin || !admin.permissions.includes(permission)) {
      next(new AppError(403, `Missing '${permission}' admin permission`));
      return;
    }
    next();
  };
}
