CREATE TYPE "public"."support_kb_audience" AS ENUM('host', 'user', 'all');--> statement-breakpoint
ALTER TYPE "public"."support_sender" ADD VALUE 'user';--> statement-breakpoint
CREATE TABLE "support_bot_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enabled" boolean NOT NULL,
	"model" text NOT NULL,
	"max_replies_per_ticket" integer NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_kb_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"audience" "support_kb_audience" DEFAULT 'all' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "account_id" uuid;--> statement-breakpoint
-- Every existing ticket was opened by a host; host_id is dropped in 0030.
UPDATE "support_tickets" SET "account_id" = "host_id";--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "needs_agent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "handoff_reason" text;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_account_id_users_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;