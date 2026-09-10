CREATE TYPE "public"."grievance_nature" AS ENUM('content_objection', 'nudity_pornography', 'reinstatement', 'copyright_violation', 'judicial_order', 'government_request', 'privacy', 'impersonation', 'child_safety', 'other');--> statement-breakpoint
CREATE TYPE "public"."grievance_status" AS ENUM('pending', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."recharge_txn_status" AS ENUM('created', 'success', 'failed');--> statement-breakpoint
CREATE TYPE "public"."vip_subscription_status" AS ENUM('active', 'cancelled', 'expired');--> statement-breakpoint
ALTER TYPE "public"."account_status" ADD VALUE 'deleted';--> statement-breakpoint
CREATE TABLE "grievances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"first_name" text NOT NULL,
	"last_name" text NOT NULL,
	"contact_number" text NOT NULL,
	"email" text NOT NULL,
	"nature_of_complaint" "grievance_nature" NOT NULL,
	"description" text NOT NULL,
	"evidence_keys" text[] DEFAULT '{}' NOT NULL,
	"status" "grievance_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "recharge_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"price_paise" integer NOT NULL,
	"mrp_paise" integer,
	"display_beans" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recharge_txns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"package_id" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"display_beans" integer NOT NULL,
	"gateway" text DEFAULT 'dev-stub' NOT NULL,
	"gateway_txn_id" text,
	"status" "recharge_txn_status" DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vip_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_discount_basis_points" integer NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vip_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"duration_days" integer NOT NULL,
	"price_paise" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vip_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" "vip_subscription_status" DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "host_profiles" ADD COLUMN "languages" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "host_profiles" ADD COLUMN "talks_about_tags" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "host_profiles" ADD COLUMN "hobbies" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "host_profiles" ADD COLUMN "sports" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "live_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "call_summaries" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD COLUMN "wallet_activity_alerts" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "username" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "languages" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "grievances" ADD CONSTRAINT "grievances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recharge_txns" ADD CONSTRAINT "recharge_txns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recharge_txns" ADD CONSTRAINT "recharge_txns_package_id_recharge_packages_id_fk" FOREIGN KEY ("package_id") REFERENCES "public"."recharge_packages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vip_subscriptions" ADD CONSTRAINT "vip_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vip_subscriptions" ADD CONSTRAINT "vip_subscriptions_plan_id_vip_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."vip_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_username_unique" UNIQUE("username");