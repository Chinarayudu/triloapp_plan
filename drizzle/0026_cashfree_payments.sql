CREATE TYPE "public"."vip_purchase_status" AS ENUM('created', 'success', 'failed');--> statement-breakpoint
CREATE TABLE "vip_purchases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"gateway" text DEFAULT 'dev-stub' NOT NULL,
	"gateway_txn_id" text,
	"gateway_order_id" text,
	"payment_session_id" text,
	"status" "vip_purchase_status" DEFAULT 'created' NOT NULL,
	"subscription_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vip_purchases_gateway_order_id_unique" UNIQUE("gateway_order_id")
);
--> statement-breakpoint
ALTER TABLE "recharge_txns" ADD COLUMN "gateway_order_id" text;--> statement-breakpoint
ALTER TABLE "recharge_txns" ADD COLUMN "payment_session_id" text;--> statement-breakpoint
ALTER TABLE "vip_purchases" ADD CONSTRAINT "vip_purchases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vip_purchases" ADD CONSTRAINT "vip_purchases_plan_id_vip_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."vip_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vip_purchases" ADD CONSTRAINT "vip_purchases_subscription_id_vip_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."vip_subscriptions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recharge_txns" ADD CONSTRAINT "recharge_txns_gateway_order_id_unique" UNIQUE("gateway_order_id");