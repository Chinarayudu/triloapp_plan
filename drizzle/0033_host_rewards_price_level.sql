CREATE TYPE "public"."host_reward_period" AS ENUM('daily', 'weekly');--> statement-breakpoint
ALTER TYPE "public"."ledger_reference_type" ADD VALUE 'host_reward';--> statement-breakpoint
ALTER TYPE "public"."notification_type" ADD VALUE 'host_reward';--> statement-breakpoint
CREATE TABLE "host_reward_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period" "host_reward_period" NOT NULL,
	"enabled" boolean NOT NULL,
	"min_qualifying_beans" integer NOT NULL,
	"tiers" jsonb NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_reward_payouts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"settlement_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"beans_earned" integer NOT NULL,
	"reward_beans" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "host_reward_payouts_settlement_rank_unique" UNIQUE("settlement_id","rank"),
	CONSTRAINT "host_reward_payouts_settlement_host_unique" UNIQUE("settlement_id","host_id")
);
--> statement-breakpoint
CREATE TABLE "host_reward_settlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period" "host_reward_period" NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"config_id" uuid,
	"settled_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "host_reward_settlements_period_start_unique" UNIQUE("period","period_start")
);
--> statement-breakpoint
ALTER TABLE "host_profiles" ADD COLUMN "price_level" integer;--> statement-breakpoint
ALTER TABLE "host_reward_payouts" ADD CONSTRAINT "host_reward_payouts_settlement_id_host_reward_settlements_id_fk" FOREIGN KEY ("settlement_id") REFERENCES "public"."host_reward_settlements"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_reward_payouts" ADD CONSTRAINT "host_reward_payouts_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_reward_settlements" ADD CONSTRAINT "host_reward_settlements_config_id_host_reward_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."host_reward_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Hosts who had typed in their own rates: pick the highest level, up to the one
-- they've unlocked, whose prices are all at or below the rates they set (so no
-- user pays more after this change). Level prices (hosts/levels.ts): voice
-- 2000 + (L-1)*2000, video 3000 + (L-1)*2000, message 500 + (L-1)*2000 paise.
-- Hosts who never set a rate stay null = "my unlocked level".
UPDATE "host_profiles" AS hp
SET "price_level" = GREATEST(1, LEAST(
  LEAST(20, 1 + floor(hw."lifetime_earned_beans" / 100000)),
  COALESCE(floor((hp."rate_per_minute_paise" - 3000) / 2000.0) + 1, 20),
  COALESCE(floor((hp."voice_rate_per_minute_paise" - 2000) / 2000.0) + 1, 20),
  COALESCE(floor((hp."message_rate_paise" - 500) / 2000.0) + 1, 20)
))::integer
FROM "host_wallets" AS hw
WHERE hw."host_id" = hp."user_id"
  AND (hp."rate_per_minute_paise" IS NOT NULL OR hp."voice_rate_per_minute_paise" IS NOT NULL OR hp."message_rate_paise" IS NOT NULL);
