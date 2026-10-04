CREATE TYPE "public"."chat_message_type" AS ENUM('text', 'gift');--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "type" "chat_message_type" DEFAULT 'text' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "gift_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_gift_transaction_id_gift_transactions_id_fk" FOREIGN KEY ("gift_transaction_id") REFERENCES "public"."gift_transactions"("id") ON DELETE no action ON UPDATE no action;