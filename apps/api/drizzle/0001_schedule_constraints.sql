ALTER TABLE "activities" ADD COLUMN "start_no_earlier_than" date;--> statement-breakpoint
ALTER TABLE "recovery_measures" ADD COLUMN "applied_at" timestamp with time zone;