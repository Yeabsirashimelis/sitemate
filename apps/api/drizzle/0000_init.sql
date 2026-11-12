CREATE TYPE "public"."activity_kind" AS ENUM('general', 'excavation', 'concrete_pour', 'masonry', 'roofing', 'finishing', 'mep', 'milestone');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('user', 'agent', 'system');--> statement-breakpoint
CREATE TYPE "public"."agent_run_status" AS ENUM('ok', 'error');--> statement-breakpoint
CREATE TYPE "public"."approval_kind" AS ENUM('schedule_change', 'recovery_plan', 'purchase_request', 'supplier_message', 'consultant_rfi', 'delay_notice', 'payment_claim', 'client_report');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected', 'executed', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."claim_cause" AS ENUM('weather', 'late_information', 'late_payment', 'client_change', 'access', 'supplier', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_claim_status" AS ENUM('draft', 'pending_approval', 'submitted', 'paid');--> statement-breakpoint
CREATE TYPE "public"."claim_status" AS ENUM('open', 'notified', 'closed');--> statement-breakpoint
CREATE TYPE "public"."cost_category" AS ENUM('material', 'labour', 'equipment', 'subcontract', 'other');--> statement-breakpoint
CREATE TYPE "public"."daily_log_status" AS ENUM('collecting', 'awaiting_answer', 'complete');--> statement-breakpoint
CREATE TYPE "public"."document_kind" AS ENUM('contract', 'specification', 'boq', 'letter', 'minutes', 'other');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('pending', 'indexed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."language" AS ENUM('en', 'am');--> statement-breakpoint
CREATE TYPE "public"."link_type" AS ENUM('FS', 'SS', 'FF', 'SF');--> statement-breakpoint
CREATE TYPE "public"."material_tx_kind" AS ENUM('delivery', 'usage', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."message_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TYPE "public"."message_kind" AS ENUM('text', 'voice', 'photo', 'document', 'callback', 'system');--> statement-breakpoint
CREATE TYPE "public"."purchase_status" AS ENUM('draft', 'pending_approval', 'approved', 'ordered', 'delivered', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."responsible_party" AS ENUM('client', 'consultant', 'contractor', 'neutral');--> statement-breakpoint
CREATE TYPE "public"."rfi_status" AS ENUM('draft', 'pending_approval', 'sent', 'answered', 'closed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('owner', 'project_manager', 'site_engineer', 'supervisor', 'subcontractor', 'supplier');--> statement-breakpoint
CREATE TABLE "activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"kind" "activity_kind" DEFAULT 'general' NOT NULL,
	"zone" text,
	"duration" integer NOT NULL,
	"baseline_start" integer,
	"baseline_finish" integer,
	"actual_start" date,
	"actual_finish" date,
	"remaining_duration" integer,
	"percent_complete" numeric(5, 2) DEFAULT 0 NOT NULL,
	"progress_unit" text,
	"planned_quantity" numeric(14, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "activity_links" (
	"project_id" uuid NOT NULL,
	"from_activity_id" uuid NOT NULL,
	"to_activity_id" uuid NOT NULL,
	"type" "link_type" DEFAULT 'FS' NOT NULL,
	"lag" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "activity_links_from_activity_id_to_activity_id_pk" PRIMARY KEY("from_activity_id","to_activity_id")
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid,
	"project_id" uuid,
	"agent" text NOT NULL,
	"trigger" text NOT NULL,
	"model" text NOT NULL,
	"input" jsonb,
	"output" jsonb,
	"status" "agent_run_status" NOT NULL,
	"error" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"kind" "approval_kind" NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"action" jsonb NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"requested_by" text NOT NULL,
	"approver_role" "user_role" NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"result" jsonb,
	"telegram_messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"subject_type" text,
	"subject_id" text,
	"reason" text,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "boq_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"item_no" text NOT NULL,
	"description" text NOT NULL,
	"unit" text NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"rate" numeric(14, 2) NOT NULL,
	"activity_id" uuid
);
--> statement-breakpoint
CREATE TABLE "claim_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"cause" "claim_cause" NOT NULL,
	"responsible" "responsible_party" NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"started_on" date NOT NULL,
	"ended_on" date,
	"activity_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"delay_days" integer DEFAULT 0 NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"clause_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notice_draft" text,
	"status" "claim_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cost_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"date" date NOT NULL,
	"category" "cost_category" NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"description" text NOT NULL,
	"source_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"supervisor_id" uuid NOT NULL,
	"log_date" date NOT NULL,
	"status" "daily_log_status" DEFAULT 'collecting' NOT NULL,
	"summary" text,
	"weather" text,
	"workers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"progress" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"materials_received" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"materials_used" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"follow_up_question" text,
	"follow_ups_asked" integer DEFAULT 0 NOT NULL,
	"confidence" numeric(3, 2),
	"corrected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"clause" text,
	"heading" text,
	"page" integer,
	"content" text NOT NULL,
	"embedding" vector(768)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"kind" "document_kind" NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"status" "document_status" DEFAULT 'pending' NOT NULL,
	"error" text,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"code" text PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "material_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"material_id" uuid NOT NULL,
	"date" date NOT NULL,
	"kind" "material_tx_kind" NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"progress" numeric(14, 3),
	"daily_log_id" uuid,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"unit" text NOT NULL,
	"on_hand" numeric(14, 3) DEFAULT 0 NOT NULL,
	"progress_unit" text,
	"usage_per_unit" numeric(14, 4),
	"lead_time_days" integer DEFAULT 3 NOT NULL,
	"safety_days" integer DEFAULT 2 NOT NULL,
	"last_unit_price" numeric(14, 2),
	"consumed_by" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"project_id" uuid,
	"user_id" uuid,
	"daily_log_id" uuid,
	"direction" "message_direction" NOT NULL,
	"kind" "message_kind" NOT NULL,
	"text" text,
	"telegram_chat_id" bigint,
	"telegram_message_id" bigint,
	"telegram_file_id" text,
	"mime_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"period_end" date NOT NULL,
	"status" "payment_claim_status" DEFAULT 'draft' NOT NULL,
	"cumulative_gross" numeric(14, 2) NOT NULL,
	"previous_gross" numeric(14, 2) NOT NULL,
	"retention" numeric(14, 2) NOT NULL,
	"net_this_period" numeric(14, 2) NOT NULL,
	"lines" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_members_project_id_user_id_pk" PRIMARY KEY("project_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"client" text,
	"consultant" text,
	"location_name" text,
	"latitude" double precision,
	"longitude" double precision,
	"start_date" date NOT NULL,
	"contract_finish" date NOT NULL,
	"data_date" date NOT NULL,
	"calendar" jsonb NOT NULL,
	"liquidated_damages_per_day" numeric(14, 2),
	"retention_percent" numeric(5, 2) DEFAULT 5 NOT NULL,
	"check_in_time" text DEFAULT '17:00' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"material_id" uuid NOT NULL,
	"quantity" numeric(14, 3) NOT NULL,
	"needed_by" date NOT NULL,
	"status" "purchase_status" DEFAULT 'draft' NOT NULL,
	"reason" text NOT NULL,
	"selected_quote_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purchase_request_id" uuid NOT NULL,
	"supplier_id" uuid NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'ETB' NOT NULL,
	"unit_price_etb" numeric(14, 2) NOT NULL,
	"lead_time_days" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recovery_measures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"activity_id" uuid NOT NULL,
	"description" text NOT NULL,
	"change" jsonb NOT NULL,
	"cost" numeric(14, 2) NOT NULL,
	"risk" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rfis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"question" text NOT NULL,
	"activity_id" uuid,
	"status" "rfi_status" DEFAULT 'draft' NOT NULL,
	"raised_on" date NOT NULL,
	"due_on" date NOT NULL,
	"answer" text,
	"answered_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedule_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"data_date" date NOT NULL,
	"finish_date" date NOT NULL,
	"slip_days" integer NOT NULL,
	"critical_path" jsonb NOT NULL,
	"activities" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"user_id" uuid,
	"phone" text,
	"email" text,
	"materials" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "telegram_updates" (
	"update_id" bigint PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"password_hash" text,
	"role" "user_role" NOT NULL,
	"phone" text,
	"language" "language" DEFAULT 'en' NOT NULL,
	"telegram_user_id" bigint,
	"telegram_chat_id" bigint,
	"quiet_from" integer DEFAULT 20 NOT NULL,
	"quiet_to" integer DEFAULT 7 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "weather_forecasts" (
	"project_id" uuid NOT NULL,
	"date" date NOT NULL,
	"precipitation_mm" double precision NOT NULL,
	"precipitation_probability" integer,
	"wind_kmh" double precision,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weather_forecasts_project_id_date_pk" PRIMARY KEY("project_id","date")
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_links" ADD CONSTRAINT "activity_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_links" ADD CONSTRAINT "activity_links_from_activity_id_activities_id_fk" FOREIGN KEY ("from_activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_links" ADD CONSTRAINT "activity_links_to_activity_id_activities_id_fk" FOREIGN KEY ("to_activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boq_items" ADD CONSTRAINT "boq_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boq_items" ADD CONSTRAINT "boq_items_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "claim_events" ADD CONSTRAINT "claim_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cost_entries" ADD CONSTRAINT "cost_entries_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_logs" ADD CONSTRAINT "daily_logs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_logs" ADD CONSTRAINT "daily_logs_supervisor_id_users_id_fk" FOREIGN KEY ("supervisor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_logs" ADD CONSTRAINT "daily_logs_corrected_by_users_id_fk" FOREIGN KEY ("corrected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_transactions" ADD CONSTRAINT "material_transactions_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "material_transactions" ADD CONSTRAINT "material_transactions_daily_log_id_daily_logs_id_fk" FOREIGN KEY ("daily_log_id") REFERENCES "public"."daily_logs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "materials" ADD CONSTRAINT "materials_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_daily_log_id_daily_logs_id_fk" FOREIGN KEY ("daily_log_id") REFERENCES "public"."daily_logs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_claims" ADD CONSTRAINT "payment_claims_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_requests" ADD CONSTRAINT "purchase_requests_material_id_materials_id_fk" FOREIGN KEY ("material_id") REFERENCES "public"."materials"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_purchase_request_id_purchase_requests_id_fk" FOREIGN KEY ("purchase_request_id") REFERENCES "public"."purchase_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_measures" ADD CONSTRAINT "recovery_measures_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_measures" ADD CONSTRAINT "recovery_measures_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfis" ADD CONSTRAINT "rfis_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfis" ADD CONSTRAINT "rfis_activity_id_activities_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_snapshots" ADD CONSTRAINT "schedule_snapshots_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weather_forecasts" ADD CONSTRAINT "weather_forecasts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activities_project_code_key" ON "activities" USING btree ("project_id","code");--> statement-breakpoint
CREATE INDEX "activity_links_project_idx" ON "activity_links" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "agent_runs_project_idx" ON "agent_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "approvals_company_status_idx" ON "approvals" USING btree ("company_id","status","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_project_idx" ON "audit_log" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "boq_items_project_item_key" ON "boq_items" USING btree ("project_id","item_no");--> statement-breakpoint
CREATE INDEX "claim_events_project_idx" ON "claim_events" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "cost_entries_project_idx" ON "cost_entries" USING btree ("project_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "cost_entries_source_key" ON "cost_entries" USING btree ("source_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "daily_logs_unique_day" ON "daily_logs" USING btree ("project_id","supervisor_id","log_date");--> statement-breakpoint
CREATE INDEX "document_chunks_document_idx" ON "document_chunks" USING btree ("document_id","ordinal");--> statement-breakpoint
CREATE INDEX "document_chunks_project_idx" ON "document_chunks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "document_chunks_fts_idx" ON "document_chunks" USING gin (to_tsvector('simple', "content"));--> statement-breakpoint
CREATE INDEX "jobs_ready_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idempotency_key" ON "jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "material_tx_material_idx" ON "material_transactions" USING btree ("material_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "materials_project_name_key" ON "materials" USING btree ("project_id",lower("name"));--> statement-breakpoint
CREATE INDEX "messages_daily_log_idx" ON "messages" USING btree ("daily_log_id");--> statement-breakpoint
CREATE INDEX "messages_project_idx" ON "messages" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_claims_project_number_key" ON "payment_claims" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "project_members_user_idx" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "projects_company_idx" ON "projects" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "purchase_requests_project_idx" ON "purchase_requests" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "reminders_user_idx" ON "reminders" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "rfis_project_number_key" ON "rfis" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "schedule_snapshots_project_idx" ON "schedule_snapshots" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "users_telegram_user_id_key" ON "users" USING btree ("telegram_user_id");--> statement-breakpoint
CREATE INDEX "users_company_idx" ON "users" USING btree ("company_id");