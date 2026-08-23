CREATE TYPE "public"."call_status" AS ENUM('ringing', 'ongoing', 'completed', 'rejected', 'missed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."ledger_direction" AS ENUM('debit', 'credit');--> statement-breakpoint
CREATE TYPE "public"."ledger_reference_type" AS ENUM('recharge', 'call_billing', 'gift', 'commission', 'withdrawal', 'refund', 'adjustment', 'dev_credit');--> statement-breakpoint
CREATE TYPE "public"."ledger_wallet_type" AS ENUM('user', 'host');--> statement-breakpoint
CREATE TABLE "beans_earn_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"paise_per_bean" integer NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "call_billing_ticks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"tick_number" integer NOT NULL,
	"amount_paise" integer NOT NULL,
	"beans_credited" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"status" "call_status" DEFAULT 'ringing' NOT NULL,
	"rate_per_minute_paise_snapshot" integer NOT NULL,
	"commission_basis_points_snapshot" integer NOT NULL,
	"paise_per_bean_snapshot" integer NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"total_amount_paise" integer DEFAULT 0 NOT NULL,
	"total_beans" integer DEFAULT 0 NOT NULL,
	"tick_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commission_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"basis_points" integer NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "host_wallets" (
	"host_id" uuid PRIMARY KEY NOT NULL,
	"bean_balance" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_type" "ledger_wallet_type" NOT NULL,
	"owner_id" uuid NOT NULL,
	"direction" "ledger_direction" NOT NULL,
	"amount" integer NOT NULL,
	"reference_type" "ledger_reference_type" NOT NULL,
	"reference_id" uuid,
	"balance_after" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "wallets" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance_paise" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_billing_ticks" ADD CONSTRAINT "call_billing_ticks_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calls" ADD CONSTRAINT "calls_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_wallets" ADD CONSTRAINT "host_wallets_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;