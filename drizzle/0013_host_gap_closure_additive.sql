CREATE TYPE "public"."call_type" AS ENUM('video', 'voice');--> statement-breakpoint
CREATE TYPE "public"."payout_method_type" AS ENUM('upi', 'bank');--> statement-breakpoint
CREATE TABLE "call_ratings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"rater_id" uuid NOT NULL,
	"rated_user_id" uuid NOT NULL,
	"stars" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_ratings_call_id_rater_id_unique" UNIQUE("call_id","rater_id")
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"incoming_calls" boolean DEFAULT true NOT NULL,
	"missed_calls" boolean DEFAULT true NOT NULL,
	"new_messages" boolean DEFAULT true NOT NULL,
	"call_reminders" boolean DEFAULT false NOT NULL,
	"gifts_received" boolean DEFAULT true NOT NULL,
	"withdrawal_updates" boolean DEFAULT true NOT NULL,
	"weekly_earnings_summary" boolean DEFAULT false NOT NULL,
	"promotions_and_tips" boolean DEFAULT false NOT NULL,
	"dnd_enabled" boolean DEFAULT true NOT NULL,
	"dnd_start_hour" integer DEFAULT 1 NOT NULL,
	"dnd_end_hour" integer DEFAULT 7 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"type" "payout_method_type" NOT NULL,
	"details_json" text NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_blocks_blocker_id_blocked_id_unique" UNIQUE("blocker_id","blocked_id")
);
--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "type" "call_type" DEFAULT 'video' NOT NULL;--> statement-breakpoint
ALTER TABLE "host_profiles" ADD COLUMN "voice_rate_per_minute_paise" integer;--> statement-breakpoint
ALTER TABLE "host_profiles" ADD COLUMN "private_live_rate_per_minute_paise" integer;--> statement-breakpoint
ALTER TABLE "host_profiles" ADD COLUMN "auto_accept_calls" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "host_profiles" ADD COLUMN "voice_calls_only_after_midnight" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "withdrawal_policy_configs" ADD COLUMN "processing_fee_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "withdrawal_policy_configs" ADD COLUMN "tds_basis_points" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD COLUMN "processing_fee_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD COLUMN "tds_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD COLUMN "net_payout_paise" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "call_ratings" ADD CONSTRAINT "call_ratings_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_ratings" ADD CONSTRAINT "call_ratings_rater_id_users_id_fk" FOREIGN KEY ("rater_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_ratings" ADD CONSTRAINT "call_ratings_rated_user_id_users_id_fk" FOREIGN KEY ("rated_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_methods" ADD CONSTRAINT "payout_methods_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_blocks" ADD CONSTRAINT "user_blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;