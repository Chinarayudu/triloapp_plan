import {
  boolean,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

// Full role set per BRD.md BR-ACC-01, even though signup (auth.routes.ts)
// only ever creates USER/HOST rows — ADMIN/SUB_ADMIN accounts are
// provisioned out-of-band via `npm run db:seed-admin` (Phase 9), then
// authenticate through the same phone/OTP flow as everyone else.
export const roleEnum = pgEnum("role", ["user", "host", "admin", "sub_admin"]);
export const kycStatusEnum = pgEnum("kyc_status", [
  "not_submitted",
  "pending",
  "approved",
  "rejected",
]);
export const accountStatusEnum = pgEnum("account_status", ["active", "suspended", "banned"]);
// Restricted permission sets for SUB_ADMIN accounts (BR-ADM-03) — a full
// ADMIN implicitly has all of these (checked in admin/permissions.ts) and
// never needs this column populated. "finance" covers withdrawal approval
// and pricing/economics config; "moderation" covers KYC review, content
// reports, and account suspension; "analytics" is read-only dashboard access.
export const adminPermissionEnum = pgEnum("admin_permission", ["finance", "moderation", "analytics"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  role: roleEnum("role").notNull(),
  phone: text("phone").notNull().unique(),
  name: text("name"),
  email: text("email"),
  dob: text("dob"), // ISO date string; verified DOB comes from KYC review (Phase 9), not this field alone
  ageVerified: boolean("age_verified").notNull().default(false),
  // Denormalized mirror of the latest row in kycSubmissions (below) — kept
  // on the user row because almost every KYC-gate check in the codebase
  // (withdrawals, live 18+ gating, admin decisions) only cares about "what
  // is this user's KYC status right now," not their submission history.
  kycStatus: kycStatusEnum("kyc_status").notNull().default("not_submitted"),
  status: accountStatusEnum("status").notNull().default("active"),
  // Admin/sub-admin login only (Phase 9 follow-up — email+password,
  // matching the admin web app's design; Users/Hosts still authenticate
  // via phone/OTP only, BR-ACC-02). NULL for every other role.
  passwordHash: text("password_hash"),
  // Only meaningful for role=sub_admin (admin/permissions.ts) — empty for
  // every other role.
  permissions: adminPermissionEnum("permissions").array().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per HOST-role user. Presence (online/busy) is Redis-backed at
// runtime (BACKEND_PLAN.md §4), not stored here — this table is profile
// data only.
export const hostProfiles = pgTable("host_profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  bio: text("bio"),
  gallery: text("gallery").array().notNull().default([]),
  // Smallest currency unit (paise), same convention as wallet balances
  // (BACKEND_PLAN.md §1) — avoids float drift. This is the video-call rate;
  // voice and private-live have their own rates below (Rate Settings screen,
  // Host app design follow-up) since a host can price each differently.
  ratePerMinutePaise: integer("rate_per_minute_paise"),
  voiceRatePerMinutePaise: integer("voice_rate_per_minute_paise"),
  // Stored ahead of a consuming feature — no private-live billing flow
  // exists yet, same "field before the feature" precedent as this table's
  // original payoutDetails placeholder.
  privateLiveRatePerMinutePaise: integer("private_live_rate_per_minute_paise"),
  autoAcceptCalls: boolean("auto_accept_calls").notNull().default(true),
  voiceCallsOnlyAfterMidnight: boolean("voice_calls_only_after_midnight").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// A host's public photo/video gallery, structured (media type + video
// duration) rather than hostProfiles.gallery's bare URL strings — needed so
// admin can view/moderate individual items (delete one video without
// touching the rest). hostProfiles.gallery is untouched/still used by the
// existing PATCH /me/host-profile bulk-set; this is the new, separate way
// forward (POST /me/host-profile/gallery adds one item at a time).
export const galleryMediaTypeEnum = pgEnum("gallery_media_type", ["photo", "video"]);

export const hostGalleryItems = pgTable("host_gallery_items", {
  id: uuid("id").primaryKey().defaultRandom(),
  hostId: uuid("host_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  mediaType: galleryMediaTypeEnum("media_type").notNull(),
  url: text("url").notNull(),
  durationSeconds: integer("duration_seconds"), // only meaningful for mediaType=video
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A host's payout destinations (Host app design follow-up) — replaces the
// old single hostProfiles.payoutDetails JSON blob. A host can hold several
// (e.g. a primary bank account + a backup UPI id); exactly one is primary
// at a time, and withdrawal.service.ts snapshots the primary one onto each
// withdrawal request at creation time, same "snapshot, don't reference"
// convention as every other _snapshot field in this schema.
export const payoutMethodTypeEnum = pgEnum("payout_method_type", ["upi", "bank"]);

export const payoutMethods = pgTable("payout_methods", {
  id: uuid("id").primaryKey().defaultRandom(),
  hostId: uuid("host_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  type: payoutMethodTypeEnum("type").notNull(),
  detailsJson: text("details_json").notNull(), // JSON string — { type: "upi", vpa } or { type: "bank", accountHolderName, accountNumber, ifsc }
  isPrimary: boolean("is_primary").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// KYC submissions (BR-ACC-03/04) — admin design follow-up. Previously a
// single kycDocumentKey column on users, overwritten on every resubmission
// with no history and no way to show "which attempt is this" or review
// more than one document. Now a real submission history: one row per
// attempt, each with 1-4 documents (front/back/selfie/address proof).
// users.kycStatus mirrors whichever submission is latest.
// ---------------------------------------------------------------------------

export const kycSubmissionStatusEnum = pgEnum("kyc_submission_status", ["pending", "approved", "rejected"]);
export const kycDocumentTypeEnum = pgEnum("kyc_document_type", [
  "id_front",
  "id_back",
  "selfie",
  "address_proof",
]);

export const kycSubmissions = pgTable("kyc_submissions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // 1st, 2nd, 3rd submission for this user — computed at insert time as
  // (their previous submission count + 1), not a DB sequence, since it's
  // scoped per-user, not global.
  attemptNumber: integer("attempt_number").notNull(),
  status: kycSubmissionStatusEnum("status").notNull().default("pending"),
  reviewedByAdminId: uuid("reviewed_by_admin_id").references(() => users.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  rejectionReason: text("rejection_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const kycDocuments = pgTable("kyc_documents", {
  id: uuid("id").primaryKey().defaultRandom(),
  submissionId: uuid("submission_id")
    .notNull()
    .references(() => kycSubmissions.id, { onDelete: "cascade" }),
  documentType: kycDocumentTypeEnum("document_type").notNull(),
  // Private S3 object key, same "presign a GET URL on demand, don't store
  // one" convention as the column this replaced.
  objectKey: text("object_key").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A USER following a HOST (BR-NOTIF-01's "a followed/favorite host going
// live") — nothing more than that trigger consumes this today, kept as its
// own small table rather than folded into hostProfiles since it's a
// many-to-many relationship, not profile data.
export const hostFollows = pgTable(
  "host_follows",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    hostId: uuid("host_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.userId, table.hostId)],
);

// A safety tool distinct from moderationReports below (BRD.md lists
// "block/report" as two separate host safety tools) — blocking has an
// immediate, mechanical effect (calls.service.ts/chat.service.ts reject
// between blocked pairs) rather than routing through human review.
// blockerId -> blockedId is directional: only the blocker's calls/messages
// to the blocked party (and vice versa) are affected, not a mutual state.
export const userBlocks = pgTable(
  "user_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    blockerId: uuid("blocker_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedId: uuid("blocked_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.blockerId, table.blockedId)],
);

export const otpCodes = pgTable("otp_codes", {
  id: uuid("id").primaryKey().defaultRandom(),
  phone: text("phone").notNull(),
  codeHash: text("code_hash").notNull(),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const refreshTokens = pgTable("refresh_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per successful login (BACKEND_PLAN.md §8 "Fraud" — Phase 11).
// Deliberately a standing history, not derived from refreshTokens: a
// refresh token gets rotated/revoked constantly (that's its whole job),
// which would make fraud analysis over "who logged in from what device"
// lossy if it were the only record. deviceFingerprint is optional and
// frontend-supplied (there's no way to force a client to send one) — the
// multi-accounting check in fraud.service.ts simply skips accounts that
// never send it, same "configure/react, can't force" posture as the
// screenshot-capture flag in Phase 10.
export const loginEvents = pgTable("login_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  deviceFingerprint: text("device_fingerprint"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Per-user push/notification toggle preferences (Host app Notification
// Settings screen, design follow-up) — one row per user, created at signup
// (users.service.ts's createUser) alongside the wallet row, same "exactly
// one place this can come into being" convention. Defaults below match the
// toggle states shown in the design (calls/gifts/withdrawal-updates on,
// reminders/summary/promos off, DND 1-7AM on).
export const notificationPreferences = pgTable("notification_preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  incomingCalls: boolean("incoming_calls").notNull().default(true),
  missedCalls: boolean("missed_calls").notNull().default(true),
  newMessages: boolean("new_messages").notNull().default(true),
  callReminders: boolean("call_reminders").notNull().default(false),
  giftsReceived: boolean("gifts_received").notNull().default(true),
  withdrawalUpdates: boolean("withdrawal_updates").notNull().default(true),
  weeklyEarningsSummary: boolean("weekly_earnings_summary").notNull().default(false),
  promotionsAndTips: boolean("promotions_and_tips").notNull().default(false),
  dndEnabled: boolean("dnd_enabled").notNull().default(true),
  dndStartHour: integer("dnd_start_hour").notNull().default(1), // 0-23, local-time-naive (BACKEND_PLAN.md has no per-user timezone concept yet)
  dndEndHour: integer("dnd_end_hour").notNull().default(7),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Wallet & ledger (BACKEND_PLAN.md §1). Real money only ever enters via a
// payment gateway (not built yet — see wallet.routes.ts's dev-credit escape
// hatch) and leaves via withdrawal (Phase 8). Everything between is this
// ledger — the wallet balance columns are a cached derived value, the
// ledger rows are the source of truth.
// ---------------------------------------------------------------------------

export const ledgerWalletTypeEnum = pgEnum("ledger_wallet_type", ["user", "host"]);
export const ledgerDirectionEnum = pgEnum("ledger_direction", ["debit", "credit"]);
// Full set from BACKEND_PLAN.md §1, even though only call_billing and
// dev_credit are emitted so far — recharge/gift/withdrawal/refund/
// commission/adjustment arrive with their respective phases.
export const ledgerReferenceTypeEnum = pgEnum("ledger_reference_type", [
  "recharge",
  "call_billing",
  "gift",
  "commission",
  "withdrawal",
  "refund",
  "adjustment",
  "dev_credit",
]);

// USER-role wallets only. Balance is real currency (paise), never an
// internal unit — see BACKEND_PLAN.md §1.
export const wallets = pgTable("wallets", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  balancePaise: integer("balance_paise").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// HOST-role wallets only. Beans, not currency — the one deliberate
// internal-currency layer in the system (BACKEND_PLAN.md §1).
export const hostWallets = pgTable("host_wallets", {
  hostId: uuid("host_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  beanBalance: integer("bean_balance").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ledgerEntries = pgTable("ledger_entries", {
  id: uuid("id").primaryKey().defaultRandom(),
  walletType: ledgerWalletTypeEnum("wallet_type").notNull(),
  ownerId: uuid("owner_id")
    .notNull()
    .references(() => users.id),
  direction: ledgerDirectionEnum("direction").notNull(),
  // Paise for wallet_type=user, beans for wallet_type=host.
  amount: integer("amount").notNull(),
  referenceType: ledgerReferenceTypeEnum("reference_type").notNull(),
  referenceId: uuid("reference_id"),
  balanceAfter: integer("balance_after").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Admin-tunable levers (BACKEND_PLAN.md §5), managed via admin.routes.ts
// (Phase 9) and seeded with a default row by `npm run db:seed`. Read via
// wallet.service.ts. Never updated in place — admin changes insert a new
// row with a later effectiveFrom, and the "currently active" row is
// whichever one has the latest effectiveFrom that isn't in the future.
// A call snapshots the currently-active row onto itself at creation time,
// so a later admin change never retroactively alters an in-flight or
// completed call (BR-COM-02).
// hostId NULL = a global rate; non-NULL = a negotiated override for that
// one host (BR-COM-03 — "per individual host, e.g. for negotiated rates
// with top earners"). getCurrentCommissionBasisPoints (wallet.service.ts)
// prefers an active host-specific row over the global one; every other
// host with no override of their own just falls through to global.
export const commissionConfigs = pgTable("commission_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  basisPoints: integer("basis_points").notNull(), // out of 10000 — e.g. 2000 = 20%
  hostId: uuid("host_id").references(() => users.id),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const beansEarnConfigs = pgTable("beans_earn_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  paisePerBean: integer("paise_per_bean").notNull(), // e.g. 1 = beans track net paise 1:1 at credit time
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// The global 18+ toggle (BACKEND_PLAN.md §5, BR-MOD-01) — same versioned
// "latest effectiveFrom wins" pattern as the two configs above. Gates
// whether a HOST is allowed to mark a broadcast `isAdultContent` (see
// liveBroadcasts below) at all; it does not retroactively degrade a
// broadcast already marked adult if later flipped off (Phase 10, admin.service.ts).
export const adultModeConfigs = pgTable("adult_mode_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  enabled: boolean("enabled").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Calls (BACKEND_PLAN.md §4). State machine simplified from the original
// design doc: REQUESTED/ACCEPTED aren't persisted as distinct states since
// nothing in this implementation behaves differently during those instants
// (a call is created directly as "ringing", and accept moves straight to
// "ongoing").
// ---------------------------------------------------------------------------

export const callStatusEnum = pgEnum("call_status", [
  "ringing",
  "ongoing",
  "completed",
  "rejected",
  "missed",
  "failed",
]);
// video is the default (the only type that existed before this column was
// added — Host app design follow-up), so existing rows backfill as video.
export const callTypeEnum = pgEnum("call_type", ["video", "voice"]);

export const calls = pgTable("calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  hostId: uuid("host_id")
    .notNull()
    .references(() => users.id),
  status: callStatusEnum("status").notNull().default("ringing"),
  type: callTypeEnum("type").notNull().default("video"),
  // Snapshotted at call creation so later admin config changes can't alter
  // an in-flight or already-settled call (BR-COM-02).
  ratePerMinutePaiseSnapshot: integer("rate_per_minute_paise_snapshot").notNull(),
  commissionBasisPointsSnapshot: integer("commission_basis_points_snapshot").notNull(),
  paisePerBeanSnapshot: integer("paise_per_bean_snapshot").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  endReason: text("end_reason"),
  totalAmountPaise: integer("total_amount_paise").notNull().default(0),
  totalBeans: integer("total_beans").notNull().default(0),
  tickCount: integer("tick_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const callBillingTicks = pgTable("call_billing_ticks", {
  id: uuid("id").primaryKey().defaultRandom(),
  callId: uuid("call_id")
    .notNull()
    .references(() => calls.id, { onDelete: "cascade" }),
  tickNumber: integer("tick_number").notNull(),
  amountPaise: integer("amount_paise").notNull(),
  beansCredited: integer("beans_credited").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A 1-5 star rating either call participant leaves for the other after the
// call ends (Host app's call-ended screen; BR-DIS-02 needs the resulting
// host-side aggregate for discovery sort/filter). One rating per
// (call, rater) — a host's aggregate rating is avg(stars) where
// ratedUserId = that host, computed on read (ratings.service.ts) rather
// than a maintained cache column, since it's not on any hot path.
export const callRatings = pgTable(
  "call_ratings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    callId: uuid("call_id")
      .notNull()
      .references(() => calls.id, { onDelete: "cascade" }),
    raterId: uuid("rater_id")
      .notNull()
      .references(() => users.id),
    ratedUserId: uuid("rated_user_id")
      .notNull()
      .references(() => users.id),
    stars: integer("stars").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.callId, table.raterId)],
);

// ---------------------------------------------------------------------------
// Chat (BACKEND_PLAN.md §4 — self-built, not routed through a vendor
// product). Free per BRD.md BR-CHAT-03's still-open decision, resolved
// here as free-by-default; per-message billing would reuse the same
// wallet-debit pattern as calls (wallet.service.ts) if that changes.
// A conversation is a real row (not a derived pair id) because the UX
// spec needs a "list my chats" screen with a stable id and a
// last-message timestamp to sort by.
// ---------------------------------------------------------------------------

export const chatConversations = pgTable(
  "chat_conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    hostId: uuid("host_id")
      .notNull()
      .references(() => users.id),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.userId, table.hostId)],
);

export const chatMessages = pgTable("chat_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => chatConversations.id, { onDelete: "cascade" }),
  senderId: uuid("sender_id")
    .notNull()
    .references(() => users.id),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Gifting (BACKEND_PLAN.md §1/§4, BRD.md BR-GIFT-*). Priced in real
// currency like the wallet, not an abstract unit — same debit/commission/
// credit mechanism as call billing (wallet.service.ts's
// transferUserToHost), reused rather than reimplemented so both paths
// can't silently drift apart on the commission math.
// ---------------------------------------------------------------------------

export const gifts = pgTable("gifts", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  iconUrl: text("icon_url"),
  pricePaise: integer("price_paise").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const giftContextEnum = pgEnum("gift_context", ["call", "chat", "live"]);

export const giftTransactions = pgTable("gift_transactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  senderId: uuid("sender_id")
    .notNull()
    .references(() => users.id),
  recipientId: uuid("recipient_id")
    .notNull()
    .references(() => users.id),
  giftId: uuid("gift_id")
    .notNull()
    .references(() => gifts.id),
  // Optional — a gift isn't required to be tied to a specific call/chat
  // instance; contextId polymorphically references calls.id or
  // chat_conversations.id depending on context, so no FK constraint here.
  context: giftContextEnum("context"),
  contextId: uuid("context_id"),
  pricePaiseSnapshot: integer("price_paise_snapshot").notNull(),
  commissionBasisPointsSnapshot: integer("commission_basis_points_snapshot").notNull(),
  paisePerBeanSnapshot: integer("paise_per_bean_snapshot").notNull(),
  beansCredited: integer("beans_credited").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Live broadcasting (BACKEND_PLAN.md §4, BRD.md BR-LIVE-*). Same Agora
// project as calls — the host publishes, viewers subscribe, one channel
// per broadcast. Live chat is NOT persisted here (unlike 1:1 chat) —
// it's pure real-time fan-out over a Socket.io room; BR-LIVE-02 only
// requires messages be visible to current viewers, not retrievable
// history. Gifting reuses gift_transactions/gifts as-is via
// context="live" — no schema change needed for that part.
// ---------------------------------------------------------------------------

export const liveBroadcastStatusEnum = pgEnum("live_broadcast_status", ["live", "ended"]);

export const liveBroadcasts = pgTable("live_broadcasts", {
  id: uuid("id").primaryKey().defaultRandom(),
  hostId: uuid("host_id")
    .notNull()
    .references(() => users.id),
  status: liveBroadcastStatusEnum("status").notNull().default("live"),
  peakViewerCount: integer("peak_viewer_count").notNull().default(0),
  // BR-MOD-01/02 (Phase 10) — set at start time only, requires
  // adultModeConfigs' global toggle to currently be on and the host to be
  // age-verified (live.service.ts's startBroadcast). Once set, stays true
  // for the life of the broadcast even if the global toggle is later
  // flipped off — a later admin change never retroactively re-opens
  // already-gated content to unverified viewers.
  isAdultContent: boolean("is_adult_content").notNull().default(false),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
});

export const liveViewers = pgTable("live_viewers", {
  id: uuid("id").primaryKey().defaultRandom(),
  broadcastId: uuid("broadcast_id")
    .notNull()
    .references(() => liveBroadcasts.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  // NULL while still watching — this is how "currently watching" and
  // "concurrent viewer count" are computed (BR-LIVE-04), not a separate
  // counter that could drift from reality.
  leftAt: timestamp("left_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Withdrawals (BACKEND_PLAN.md §1 "Withdrawals", BRD.md BR-EARN-02..06).
// Beans convert to real currency at withdrawal time via an admin-tiered
// slab table — a different rate than the one used when beans were earned
// (BACKEND_PLAN.md §1). The actual bank/UPI transfer goes through a
// payment gateway's Payout/Transfer API (BACKEND_PLAN.md §2); Razorpay
// payout credentials aren't verified yet, so that one call is dev-stubbed
// the same way OTP SMS is (src/lib/otpSender.ts) — see src/lib/payout.ts.
// ---------------------------------------------------------------------------

export const withdrawalStatusEnum = pgEnum("withdrawal_status", [
  "pending", // above auto-approve threshold, awaiting manual admin approval (admin.routes.ts)
  "approved", // approved (auto or manual), payout not yet initiated
  "processing", // payout initiated at the gateway, outcome not yet confirmed
  "paid",
  "rejected", // admin rejected a pending request — beans reversed
  "failed", // payout failed after being initiated — beans reversed (BR-EARN-06)
]);

// Tiered payout rates (BR-EARN-02) — e.g. withdrawing a larger bean amount
// at once can unlock a better paise-per-bean rate. Several rows can be
// active at once, one per [minBeans, maxBeans) range; requestWithdrawal
// picks the row whose range contains the requested bean amount.
export const withdrawalSlabs = pgTable("withdrawal_slabs", {
  id: uuid("id").primaryKey().defaultRandom(),
  minBeans: integer("min_beans").notNull(),
  maxBeans: integer("max_beans"), // null = no upper bound
  paisePerBean: integer("paise_per_bean").notNull(),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// BR-EARN-04 (minimum withdrawal amount + max frequency) and BR-EARN-05
// (auto-approve threshold) as one config row, same "latest active row"
// pattern as commissionConfigs — kept as one table since these levers are
// always read together at request time and change together as a single
// "withdrawal policy" admin decision, unlike commission vs. beans-rate
// which are genuinely independent.
export const withdrawalPolicyConfigs = pgTable("withdrawal_policy_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  minAmountPaise: integer("min_amount_paise").notNull(),
  maxRequestsPerWindow: integer("max_requests_per_window").notNull(),
  windowDays: integer("window_days").notNull(),
  autoApproveThresholdPaise: integer("auto_approve_threshold_paise").notNull(),
  // Confirm-withdrawal screen breakdown (Host app design follow-up) — a
  // flat processing fee plus TDS (tax deducted at source, out of 10000,
  // e.g. 100 = 1%), both deducted from the payout, never from the beans
  // debited (withdrawal.service.ts's requestWithdrawal).
  processingFeePaise: integer("processing_fee_paise").notNull().default(0),
  tdsBasisPoints: integer("tds_basis_points").notNull().default(0),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const withdrawalRequests = pgTable("withdrawal_requests", {
  id: uuid("id").primaryKey().defaultRandom(),
  hostId: uuid("host_id")
    .notNull()
    .references(() => users.id),
  beans: integer("beans").notNull(),
  // Direct value snapshot (not an FK to withdrawal_slabs), same convention
  // as calls.ratePerMinutePaiseSnapshot — a later slab table change must
  // never retroactively alter an already-created request.
  paisePerBeanSnapshot: integer("paise_per_bean_snapshot").notNull(),
  // Gross amount (beans * slab rate) — unchanged meaning. The three fields
  // below are the fee/TDS breakdown deducted from this to get what's
  // actually sent to the payout gateway (netPayoutPaise); beans debited
  // from the host's wallet are always the full requested amount, never
  // reduced by these.
  convertedAmountPaise: integer("converted_amount_paise").notNull(),
  processingFeePaise: integer("processing_fee_paise").notNull().default(0),
  tdsPaise: integer("tds_paise").notNull().default(0),
  netPayoutPaise: integer("net_payout_paise").notNull().default(0),
  status: withdrawalStatusEnum("status").notNull().default("pending"),
  payoutDetailsSnapshot: text("payout_details_snapshot").notNull(),
  payoutTxnId: text("payout_txn_id"),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Admin panel (BACKEND_PLAN.md §6/§8, BRD.md BR-ADM-*, BR-MOD-04/05) — Phase 9.
// ---------------------------------------------------------------------------

// A report a User/Host files against another account or a piece of content
// (BR-MOD-04) — targetId is polymorphic (points into users/chat_messages/
// calls/live_broadcasts depending on targetType), same convention as
// giftTransactions.contextId, so no FK constraint here.
export const moderationTargetTypeEnum = pgEnum("moderation_target_type", [
  "user",
  "host",
  "chat_message",
  "call",
  "live_broadcast",
]);
export const moderationStatusEnum = pgEnum("moderation_status", ["pending", "resolved", "dismissed"]);

export const moderationReports = pgTable("moderation_reports", {
  id: uuid("id").primaryKey().defaultRandom(),
  reporterId: uuid("reporter_id")
    .notNull()
    .references(() => users.id),
  targetType: moderationTargetTypeEnum("target_type").notNull(),
  targetId: uuid("target_id").notNull(),
  reason: text("reason").notNull(),
  status: moderationStatusEnum("status").notNull().default("pending"),
  resolvedByAdminId: uuid("resolved_by_admin_id").references(() => users.id),
  resolutionNote: text("resolution_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// Every privileged action that changes money-affecting config or account
// status is logged here (BR-ADM-04) — who, what, when, on what. metadata is
// a JSON string of whatever's useful to review later (e.g. the new
// basisPoints, a rejection reason); kept free-form rather than one column
// per possible action, since the set of admin actions will keep growing.
export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  adminId: uuid("admin_id")
    .notNull()
    .references(() => users.id),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: uuid("target_id"),
  metadata: text("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Screenshot/recording capture events (BACKEND_PLAN.md §5, BR-MOD-03) —
// Phase 10. The actual blocking is client-side (Android FLAG_SECURE, iOS
// capture-change detection); the backend's job is only to log a reported
// capture attempt and escalate for human review after enough of them
// (moderation.service.ts's logCaptureEvent) — never to auto-ban on this
// alone, since capture detection can false-positive.
// ---------------------------------------------------------------------------

export const captureEventContextEnum = pgEnum("capture_event_context", ["call", "chat", "live"]);

export const captureEvents = pgTable("capture_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  context: captureEventContextEnum("context").notNull(),
  // Polymorphic (calls.id / chat_conversations.id / live_broadcasts.id
  // depending on context), same convention as moderationReports.targetId —
  // optional since the client may not always have a specific session id at
  // hand when it detects the capture.
  contextId: uuid("context_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Broadcast messaging (admin design follow-up) — a titled message an admin
// sends to every User, every Host, or both at once (platform announcements,
// scheduled-maintenance notices). Delivered the same way every other
// notification in this codebase is: a socket event now, a push fallback
// for whoever isn't currently connected — see admin.routes.ts.
// ---------------------------------------------------------------------------

export const broadcastRecipientsEnum = pgEnum("broadcast_recipients", ["all_users", "all_hosts", "all"]);

export const broadcastMessages = pgTable("broadcast_messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  recipients: broadcastRecipientsEnum("recipients").notNull(),
  sentByAdminId: uuid("sent_by_admin_id")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
