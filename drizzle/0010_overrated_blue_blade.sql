CREATE TABLE "host_follows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "host_follows_user_id_host_id_unique" UNIQUE("user_id","host_id")
);
--> statement-breakpoint
ALTER TABLE "commission_configs" ADD COLUMN "host_id" uuid;--> statement-breakpoint
ALTER TABLE "host_follows" ADD CONSTRAINT "host_follows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "host_follows" ADD CONSTRAINT "host_follows_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commission_configs" ADD CONSTRAINT "commission_configs_host_id_users_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;