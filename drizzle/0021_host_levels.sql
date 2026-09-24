ALTER TYPE "public"."ledger_reference_type" ADD VALUE 'chat_message' BEFORE 'commission';--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "charged_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "commission_basis_points_snapshot" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "paise_per_bean_snapshot" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "beans_credited" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "host_profiles" ADD COLUMN "message_rate_paise" integer;--> statement-breakpoint
ALTER TABLE "host_wallets" ADD COLUMN "lifetime_earned_beans" integer DEFAULT 0 NOT NULL;