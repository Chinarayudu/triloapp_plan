CREATE TYPE "public"."call_media_mode" AS ENUM('agora', 'p2p', 'auto');--> statement-breakpoint
CREATE TYPE "public"."live_media_provider" AS ENUM('agora', 'cloudflare');--> statement-breakpoint
CREATE TABLE "call_media_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"reporter_id" uuid NOT NULL,
	"media_provider" "call_media_provider" NOT NULL,
	"connected" boolean NOT NULL,
	"connect_ms" integer,
	"relayed" boolean,
	"avg_rtt_ms" integer,
	"packet_loss_percent" real,
	"avg_video_kbps" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_media_reports_call_id_reporter_id_unique" UNIQUE("call_id","reporter_id")
);
--> statement-breakpoint
CREATE TABLE "live_media_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "live_media_provider" NOT NULL,
	"agora_kick_on_end" boolean DEFAULT false NOT NULL,
	"pause_hidden_video" boolean DEFAULT false NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "call_media_configs" ALTER COLUMN "provider" SET DATA TYPE "public"."call_media_mode" USING "provider"::text::"public"."call_media_mode";--> statement-breakpoint
ALTER TABLE "call_media_configs" ADD COLUMN "auto_p2p_percent" integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE "call_media_configs" ADD COLUMN "agora_kick_on_end" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "agora_fallback_allowed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "media_fallback_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "live_broadcasts" ADD COLUMN "media_provider" "live_media_provider" DEFAULT 'agora' NOT NULL;--> statement-breakpoint
ALTER TABLE "live_broadcasts" ADD COLUMN "sfu_session_id" text;--> statement-breakpoint
ALTER TABLE "live_broadcasts" ADD COLUMN "sfu_track_names" jsonb;--> statement-breakpoint
ALTER TABLE "live_viewers" ADD COLUMN "sfu_session_id" text;--> statement-breakpoint
ALTER TABLE "call_media_reports" ADD CONSTRAINT "call_media_reports_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "call_media_reports" ADD CONSTRAINT "call_media_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;