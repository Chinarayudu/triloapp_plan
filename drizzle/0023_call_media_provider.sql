CREATE TYPE "public"."call_media_provider" AS ENUM('agora', 'p2p');--> statement-breakpoint
CREATE TABLE "call_media_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "call_media_provider" NOT NULL,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "calls" ADD COLUMN "media_provider" "call_media_provider" DEFAULT 'agora' NOT NULL;