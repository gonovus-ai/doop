ALTER TABLE "custom_agents" ADD COLUMN "webhook_headers" text;
--> statement-breakpoint
ALTER TABLE "custom_agents" ADD COLUMN "webhook_payload_format" text;
