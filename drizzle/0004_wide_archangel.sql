CREATE TYPE "public"."gift_context" AS ENUM('call', 'chat', 'live');--> statement-breakpoint
CREATE TABLE "gift_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"gift_id" uuid NOT NULL,
	"context" "gift_context",
	"context_id" uuid,
	"price_paise_snapshot" integer NOT NULL,
	"commission_basis_points_snapshot" integer NOT NULL,
	"paise_per_bean_snapshot" integer NOT NULL,
	"beans_credited" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"icon_url" text,
	"price_paise" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_recipient_id_users_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gift_transactions" ADD CONSTRAINT "gift_transactions_gift_id_gifts_id_fk" FOREIGN KEY ("gift_id") REFERENCES "public"."gifts"("id") ON DELETE no action ON UPDATE no action;