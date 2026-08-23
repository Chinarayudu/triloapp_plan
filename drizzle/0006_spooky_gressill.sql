CREATE TYPE "public"."withdrawal_status" AS ENUM('pending', 'approved', 'processing', 'paid', 'rejected', 'failed');--> statement-breakpoint
CREATE TABLE "withdrawal_policy_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"min_amount_paise" integer NOT NULL,
	"max_requests_per_window" integer NOT NULL,
	"window_days" integer NOT NULL,
	"auto_approve_threshold_paise" integer NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "withdrawal_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"beans" integer NOT NULL,
	"paise_per_bean_snapshot" integer NOT NULL,
	"converted_amount_paise" integer NOT NULL,
	"status" "withdrawal_status" DEFAULT 'pending' NOT NULL,
	"payout_details_snapshot" text NOT NULL,
	"payout_txn_id" text,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "withdrawal_slabs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"min_beans" integer NOT NULL,
	"max_beans" integer,
	"paise_per_bean" integer NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "withdrawal_requests" ADD CONSTRAINT "withdrawal_requests_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;