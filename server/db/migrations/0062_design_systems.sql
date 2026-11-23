CREATE TABLE "design_systems" (
	"name" text PRIMARY KEY NOT NULL,
	"workspace_id" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"latest_version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "design_systems_workspace_idx" ON "design_systems" USING btree ("workspace_id");
--> statement-breakpoint
CREATE TABLE "design_system_releases" (
	"name" text NOT NULL,
	"version" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"files" jsonb NOT NULL,
	"total_bytes" integer NOT NULL,
	"notes" text,
	"published_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "design_system_releases_name_version_pk" PRIMARY KEY("name","version")
);
--> statement-breakpoint
CREATE INDEX "design_system_releases_name_created_idx" ON "design_system_releases" USING btree ("name","created_at");
