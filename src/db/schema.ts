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

// Full role set per BRD.md BR-ACC-01, even though this phase only ever
// creates USER/HOST rows — ADMIN/SUB_ADMIN accounts are provisioned
// separately in the Phase 9 admin build, not through OTP signup.
export const roleEnum = pgEnum("role", ["user", "host", "admin", "sub_admin"]);
export const kycStatusEnum = pgEnum("kyc_status", [
  "not_submitted",
  "pending",
  "approved",
  "rejected",
]);
export const accountStatusEnum = pgEnum("account_status", ["active", "suspended", "banned"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  role: roleEnum("role").notNull(),
  phone: text("phone").notNull().unique(),
  name: text("name"),
  email: text("email"),
  dob: text("dob"), // ISO date string; verified DOB comes from KYC review (Phase 9), not this field alone
  ageVerified: boolean("age_verified").notNull().default(false),
  kycStatus: kycStatusEnum("kyc_status").notNull().default("not_submitted"),
  // A private S3 object key, not a URL — the bucket blocks all public
  // access, so viewing this requires generating a short-lived presigned
  // GET URL on demand (see users.routes.ts's GET /me/kyc), not storing
  // one directly (it would go stale).
  kycDocumentKey: text("kyc_document_key"),
  status: accountStatusEnum("status").notNull().default("active"),
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
  // Smallest currency unit (paise), same convention as wallet balances (BACKEND_PLAN.md §1) — avoids float drift.
  ratePerMinutePaise: integer("rate_per_minute_paise"),
  payoutDetails: text("payout_details"), // JSON string; structure finalized when withdrawals (Phase 8) land
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

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

// Admin-tunable levers (BACKEND_PLAN.md §5). No admin UI exists yet
// (Phase 9) — these are read via wallet.service.ts and seeded with a
// default row by `npm run db:seed`. A call snapshots the currently-active
// row onto itself at creation time, so a later config change never
// retroactively alters an in-flight or completed call (BR-COM-02).
export const commissionConfigs = pgTable("commission_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  basisPoints: integer("basis_points").notNull(), // out of 10000 — e.g. 2000 = 20%
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const beansEarnConfigs = pgTable("beans_earn_configs", {
  id: uuid("id").primaryKey().defaultRandom(),
  paisePerBean: integer("paise_per_bean").notNull(), // e.g. 1 = beans track net paise 1:1 at credit time
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

export const calls = pgTable("calls", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id),
  hostId: uuid("host_id")
    .notNull()
    .references(() => users.id),
  status: callStatusEnum("status").notNull().default("ringing"),
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
  "pending", // above auto-approve threshold, awaiting manual admin approval (Phase 9)
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
  convertedAmountPaise: integer("converted_amount_paise").notNull(),
  status: withdrawalStatusEnum("status").notNull().default("pending"),
  payoutDetailsSnapshot: text("payout_details_snapshot").notNull(),
  payoutTxnId: text("payout_txn_id"),
  failureReason: text("failure_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
