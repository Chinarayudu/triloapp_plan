ALTER TABLE "support_tickets" DROP CONSTRAINT "support_tickets_host_id_users_id_fk";
--> statement-breakpoint
ALTER TABLE "support_tickets" ALTER COLUMN "account_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "support_tickets" DROP COLUMN "host_id";