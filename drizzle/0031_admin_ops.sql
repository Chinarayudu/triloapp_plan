CREATE TYPE "public"."capture_event_type" AS ENUM('SCREENSHOT_ATTEMPT', 'SCREEN_RECORDING_SUSPECTED', 'PAGE_HIDDEN', 'DEVTOOLS_OPENED');--> statement-breakpoint
CREATE TYPE "public"."gift_request_status" AS ENUM('pending', 'accepted', 'declined');--> statement-breakpoint
CREATE TYPE "public"."support_ticket_priority" AS ENUM('low', 'medium', 'high', 'urgent');--> statement-breakpoint
ALTER TYPE "public"."chat_message_type" ADD VALUE 'image';--> statement-breakpoint
ALTER TYPE "public"."support_ticket_status" ADD VALUE 'in_progress';--> statement-breakpoint
ALTER TYPE "public"."support_ticket_status" ADD VALUE 'waiting_on_customer';--> statement-breakpoint
ALTER TYPE "public"."support_ticket_status" ADD VALUE 'resolved';--> statement-breakpoint
CREATE TABLE "app_settings_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"daily_goal_seconds" integer NOT NULL,
	"call_quality_good_from_seconds" integer NOT NULL,
	"call_quality_excellent_from_seconds" integer NOT NULL,
	"message_price_min_paise" integer NOT NULL,
	"message_price_max_paise" integer NOT NULL,
	"live_comment_max_length" integer NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gift_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"suggested_gift_id" uuid,
	"note" text,
	"status" "gift_request_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "wallet_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"reason" text NOT NULL,
	"reference" text,
	"balance_after_paise" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capture_events" ADD COLUMN "type" "capture_event_type";--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "media_key" text;--> statement-breakpoint
ALTER TABLE "live_broadcasts" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "live_broadcasts" ADD COLUMN "comments_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "priority" "support_ticket_priority" DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "assignee_id" uuid;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "ref_call_id" uuid;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "ref_withdrawal_id" uuid;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD COLUMN "summary" text;--> statement-breakpoint
ALTER TABLE "gift_requests" ADD CONSTRAINT "gift_requests_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_requests" ADD CONSTRAINT "gift_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_requests" ADD CONSTRAINT "gift_requests_suggested_gift_id_gifts_id_fk" FOREIGN KEY ("suggested_gift_id") REFERENCES "public"."gifts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_adjustments" ADD CONSTRAINT "wallet_adjustments_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_ref_call_id_calls_id_fk" FOREIGN KEY ("ref_call_id") REFERENCES "public"."calls"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_tickets" ADD CONSTRAINT "support_tickets_ref_withdrawal_id_withdrawal_requests_id_fk" FOREIGN KEY ("ref_withdrawal_id") REFERENCES "public"."withdrawal_requests"("id") ON DELETE no action ON UPDATE no action;