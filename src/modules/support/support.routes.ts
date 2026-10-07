import { RequestHandler, Router } from "express";
import { z } from "zod";
import { writeAuditLog } from "../../lib/auditLog";
import { AppError } from "../../lib/errors";
import { requireAuth, requireRole } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { requireAdminPermission } from "../admin/permissions";
import {
  AccountRole,
  addAgentMessage,
  addOwnerMessage,
  createTicket,
  getOwnTicketWithMessages,
  getTicketWithMessages,
  issueSupportUploadUrl,
  listOwnTickets,
  listTicketsForAdmin,
  updateTicketAsAdmin,
} from "./support.service";
import { getCurrentBotConfig, listBotConfigs, scheduleBotReply, setBotConfig, SUPPORT_BOT_MODELS } from "./supportBot.service";
import { createArticle, deleteArticle, listArticles, updateArticle } from "./supportKb.service";

function parseId(raw: unknown, label: string): string {
  const result = z.string().uuid().safeParse(raw);
  if (!result.success) throw new AppError(400, `Invalid ${label}`);
  return result.data;
}

const contentSchema = z.object({ content: z.string().trim().min(1).max(2000) });

// ---- Host app + User app (mounted under /host and /user) ---------------------
// Same endpoints for both apps; each account only ever sees its own tickets.
// The bot's reply (if it's switched on) arrives afterwards as `support:message`.

export const supportRouter = Router();
const asAccount = [requireAuth, requireRole("host", "user")];

supportRouter.get("/me/support/tickets", ...asAccount, async (req, res, next) => {
  try {
    res.json(await listOwnTickets(req.user!.sub));
  } catch (err) {
    next(err);
  }
});

// A message is text, a photo (mediaKey from POST /me/support/attachments/upload-url), or both.
const mediaKeySchema = z.string().min(1).max(300).optional();
const needsTextOrPhoto = (m: { content: string; mediaKey?: string }) => m.content.length > 0 || Boolean(m.mediaKey);
const TEXT_OR_PHOTO = "A message needs text or a photo";

const createTicketSchema = z
  .object({
    subject: z.string().trim().min(1).max(120),
    category: z.string().trim().min(1).max(50),
    content: z.string().trim().max(2000).default(""),
    mediaKey: mediaKeySchema,
    // The call or withdrawal the ticket is about — must be the caller's own.
    refs: z.object({ callId: z.string().uuid().nullish(), withdrawalId: z.string().uuid().nullish() }).optional(),
  })
  .refine(needsTextOrPhoto, TEXT_OR_PHOTO);

const ownerMessageSchema = z
  .object({ content: z.string().trim().max(2000).default(""), mediaKey: mediaKeySchema })
  .refine(needsTextOrPhoto, TEXT_OR_PHOTO);

const uploadUrlSchema = z.object({ contentType: z.string().min(1).max(100) });

// Step 1 of attaching a photo: a presigned PUT (5 minutes) for a key tied to the caller.
supportRouter.post("/me/support/attachments/upload-url", ...asAccount, validateBody(uploadUrlSchema), async (req, res, next) => {
  try {
    const { contentType } = req.body as z.infer<typeof uploadUrlSchema>;
    res.status(201).json(await issueSupportUploadUrl(req.user!.sub, contentType));
  } catch (err) {
    next(err);
  }
});

supportRouter.post("/me/support/tickets", ...asAccount, validateBody(createTicketSchema), async (req, res, next) => {
  try {
    const { subject, category, content, mediaKey, refs } = req.body as z.infer<typeof createTicketSchema>;
    const created = await createTicket(
      req.user!.sub,
      req.user!.role as AccountRole,
      subject,
      category,
      content,
      { callId: refs?.callId ?? undefined, withdrawalId: refs?.withdrawalId ?? undefined },
      mediaKey ?? null,
    );
    scheduleBotReply(created.ticket.id);
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

supportRouter.get("/me/support/tickets/:id", ...asAccount, async (req, res, next) => {
  try {
    res.json(await getOwnTicketWithMessages(req.user!.sub, parseId(req.params.id, "ticket id")));
  } catch (err) {
    next(err);
  }
});

supportRouter.post("/me/support/tickets/:id/messages", ...asAccount, validateBody(ownerMessageSchema), async (req, res, next) => {
  try {
    const ticketId = parseId(req.params.id, "ticket id");
    const { content, mediaKey } = req.body as z.infer<typeof ownerMessageSchema>;
    const message = await addOwnerMessage(req.user!.sub, req.user!.role as AccountRole, ticketId, content, mediaKey ?? null);
    scheduleBotReply(ticketId);
    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

// ---- Admin dashboard (mounted once at the root, like adminRouter) ------------
// Support reuses the "moderation" admin permission (account-facing work)
// rather than adding a new permission to the sub-admin system. Every write is
// audit-logged.

export const supportAdminRouter = Router();
const asSupportAdmin = [requireAuth, requireAdminPermission("moderation")];

const TICKET_STATUSES = ["open", "in_progress", "waiting_on_customer", "resolved", "closed"] as const;

const ticketListQuery = z.object({
  status: z.enum([...TICKET_STATUSES, "all"]).optional(),
  role: z.enum(["user", "host"]).optional(),
  category: z.string().trim().min(1).max(50).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  // "true" = the queue of tickets the bot handed to a person.
  needsAgent: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true")),
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});

supportAdminRouter.get("/admin/support/tickets", ...asSupportAdmin, async (req, res, next) => {
  try {
    const query = ticketListQuery.safeParse(req.query);
    if (!query.success) throw new AppError(400, query.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join(", "));
    const { status, ...rest } = query.data;
    res.json(await listTicketsForAdmin({ ...rest, status: status === "all" ? undefined : status }));
  } catch (err) {
    next(err);
  }
});

supportAdminRouter.get("/admin/support/tickets/:id", ...asSupportAdmin, async (req, res, next) => {
  try {
    res.json(await getTicketWithMessages(parseId(req.params.id, "ticket id")));
  } catch (err) {
    next(err);
  }
});

supportAdminRouter.post("/admin/support/tickets/:id/messages", ...asSupportAdmin, validateBody(contentSchema), async (req, res, next) => {
  try {
    const ticketId = parseId(req.params.id, "ticket id");
    const { content } = req.body as z.infer<typeof contentSchema>;
    const message = await addAgentMessage(req.user!.sub, ticketId, content);
    await writeAuditLog(req.user!.sub, "support.reply", "support_ticket", ticketId);
    res.status(201).json(message);
  } catch (err) {
    next(err);
  }
});

const ticketUpdateSchema = z
  .object({
    status: z.enum(TICKET_STATUSES),
    priority: z.enum(["low", "medium", "high", "urgent"]),
    assigneeId: z.string().uuid().nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

supportAdminRouter.patch("/admin/support/tickets/:id", ...asSupportAdmin, validateBody(ticketUpdateSchema), async (req, res, next) => {
  try {
    const ticketId = parseId(req.params.id, "ticket id");
    const update = req.body as z.infer<typeof ticketUpdateSchema>;
    const { before, after } = await updateTicketAsAdmin(ticketId, update);
    const changed = Object.keys(update) as (keyof typeof update)[];
    await writeAuditLog(req.user!.sub, update.status ? `support.${update.status}` : "support.update", "support_ticket", ticketId, {
      before: Object.fromEntries(changed.map((k) => [k, before[k]])),
      after: update,
    });
    res.json(after);
  } catch (err) {
    next(err);
  }
});

// ---- Bot settings ------------------------------------------------------------
// Two path sets for the same settings: /bot-config (first built) and
// /bot-settings (the admin dashboard's Support Bot page).

const botConfigSchema = z.object({
  enabled: z.boolean(),
  model: z.enum(SUPPORT_BOT_MODELS),
  maxRepliesPerTicket: z.number().int().min(1).max(20),
});

supportAdminRouter.get("/admin/support/bot-config", ...asSupportAdmin, async (_req, res, next) => {
  try {
    res.json({ current: await getCurrentBotConfig(), models: SUPPORT_BOT_MODELS, configs: await listBotConfigs() });
  } catch (err) {
    next(err);
  }
});

supportAdminRouter.post("/admin/support/bot-config", ...asSupportAdmin, validateBody(botConfigSchema), async (req, res, next) => {
  try {
    res.status(201).json(await setBotConfig(req.user!.sub, req.body as z.infer<typeof botConfigSchema>));
  } catch (err) {
    next(err);
  }
});

supportAdminRouter.get("/admin/support/bot-settings", ...asSupportAdmin, async (_req, res, next) => {
  try {
    res.json({ ...(await getCurrentBotConfig()), models: SUPPORT_BOT_MODELS });
  } catch (err) {
    next(err);
  }
});

// Fields left out keep their current value.
const botSettingsPatchSchema = botConfigSchema.partial().refine((v) => Object.keys(v).length > 0, "Nothing to update");

supportAdminRouter.patch("/admin/support/bot-settings", ...asSupportAdmin, validateBody(botSettingsPatchSchema), async (req, res, next) => {
  try {
    const current = await getCurrentBotConfig();
    await setBotConfig(req.user!.sub, { ...current, ...(req.body as z.infer<typeof botSettingsPatchSchema>) });
    res.json({ ...(await getCurrentBotConfig()), models: SUPPORT_BOT_MODELS });
  } catch (err) {
    next(err);
  }
});

// ---- Help articles -------------------------------------------------------------
// Served at both /kb (first built) and /articles (the admin dashboard's paths).

const articleFields = {
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(10_000),
  audience: z.enum(["host", "user", "all"]),
};
const articleSchema = z.object({ ...articleFields, active: z.boolean().default(true) });
// No default on `active` here — editing a title must not re-activate a switched-off article.
const articlePatchSchema = z
  .object({ ...articleFields, active: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to update");

const listArticlesHandler: RequestHandler = async (_req, res, next) => {
  try {
    res.json({ articles: await listArticles() });
  } catch (err) {
    next(err);
  }
};

const createArticleHandler: RequestHandler = async (req, res, next) => {
  try {
    const article = await createArticle(req.body as z.infer<typeof articleSchema>);
    await writeAuditLog(req.user!.sub, "support.kb.create", "support_kb_article", article.id, { after: article });
    res.status(201).json(article);
  } catch (err) {
    next(err);
  }
};

const updateArticleHandler: RequestHandler = async (req, res, next) => {
  try {
    const id = parseId(req.params.id, "article id");
    const article = await updateArticle(id, req.body as z.infer<typeof articlePatchSchema>);
    await writeAuditLog(req.user!.sub, "support.kb.update", "support_kb_article", id, { after: req.body });
    res.json(article);
  } catch (err) {
    next(err);
  }
};

const deleteArticleHandler: RequestHandler = async (req, res, next) => {
  try {
    const id = parseId(req.params.id, "article id");
    const article = await deleteArticle(id);
    await writeAuditLog(req.user!.sub, "support.kb.delete", "support_kb_article", id, { before: article });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
};

for (const base of ["/admin/support/kb", "/admin/support/articles"]) {
  supportAdminRouter.get(base, ...asSupportAdmin, listArticlesHandler);
  supportAdminRouter.post(base, ...asSupportAdmin, validateBody(articleSchema), createArticleHandler);
  supportAdminRouter.patch(`${base}/:id`, ...asSupportAdmin, validateBody(articlePatchSchema), updateArticleHandler);
  supportAdminRouter.delete(`${base}/:id`, ...asSupportAdmin, deleteArticleHandler);
}
