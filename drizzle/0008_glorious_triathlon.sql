CREATE TYPE "public"."capture_event_context" AS ENUM('call', 'chat', 'live');--> statement-breakpoint
CREATE TABLE "adult_mode_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"enabled" boolean NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capture_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"context" "capture_event_context" NOT NULL,
	"context_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "live_broadcasts" ADD COLUMN "is_adult_content" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "capture_events" ADD CONSTRAINT "capture_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;