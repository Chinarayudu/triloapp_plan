ALTER TABLE "users" DROP CONSTRAINT "users_phone_unique";--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_phone_role_unique" UNIQUE("phone","role");