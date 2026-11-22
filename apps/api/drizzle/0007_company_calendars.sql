ALTER TABLE "calendar_events" DROP CONSTRAINT "calendar_events_project_id_projects_id_fk";
--> statement-breakpoint
ALTER TABLE "calendar_events" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "calendar_id" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "google_calendar_id" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;