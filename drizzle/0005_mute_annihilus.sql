CREATE TYPE "public"."live_broadcast_status" AS ENUM('live', 'ended');--> statement-breakpoint
CREATE TABLE "live_broadcasts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"status" "live_broadcast_status" DEFAULT 'live' NOT NULL,
	"peak_viewer_count" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "live_viewers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"broadcast_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "live_broadcasts" ADD CONSTRAINT "live_broadcasts_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_viewers" ADD CONSTRAINT "live_viewers_broadcast_id_live_broadcasts_id_fk" FOREIGN KEY ("broadcast_id") REFERENCES "public"."live_broadcasts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "live_viewers" ADD CONSTRAINT "live_viewers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;