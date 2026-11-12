/**
 * Database schema.
 *
 * Every business table carries company_id (directly or through its project)
 * so one database can serve many contractors without data leaking between
 * them. Money is stored in birr as numeric(14,2); quantities as numeric(14,3).
 */

import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
const money = (name: string) => numeric(name, { precision: 14, scale: 2, mode: "number" });
const quantity = (name: string) => numeric(name, { precision: 14, scale: 3, mode: "number" });

export const EMBEDDING_DIMENSIONS = 768;

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const userRole = pgEnum("user_role", [
  "owner",
  "project_manager",
  "site_engineer",
  "supervisor",
  "subcontractor",
  "supplier",
  /** The client's engineer. Receives RFIs on Telegram and answers there; never signs in to the dashboard. */
  "consultant",
]);
export const language = pgEnum("language", ["en", "am"]);
export const linkType = pgEnum("link_type", ["FS", "SS", "FF", "SF"]);
export const activityKind = pgEnum("activity_kind", [
  "general",
  "excavation",
  "concrete_pour",
  "masonry",
  "roofing",
  "finishing",
  "mep",
  "milestone",
]);
export const dailyLogStatus = pgEnum("daily_log_status", ["collecting", "awaiting_answer", "complete"]);
export const messageDirection = pgEnum("message_direction", ["in", "out"]);
export const messageKind = pgEnum("message_kind", ["text", "voice", "photo", "document", "callback", "system"]);
export const materialTxKind = pgEnum("material_tx_kind", ["delivery", "usage", "adjustment"]);
export const purchaseStatus = pgEnum("purchase_status", [
  "draft",
  "pending_approval",
  "approved",
  "ordered",
  "delivered",
  "cancelled",
]);
export const costCategory = pgEnum("cost_category", ["material", "labour", "equipment", "subcontract", "other"]);
export const documentKind = pgEnum("document_kind", ["contract", "specification", "boq", "letter", "minutes", "other"]);
export const documentStatus = pgEnum("document_status", ["pending", "indexed", "failed"]);
export const claimCause = pgEnum("claim_cause", [
  "weather",
  "late_information",
  "late_payment",
  "client_change",
  "access",
  "supplier",
  "other",
]);
export const responsibleParty = pgEnum("responsible_party", ["client", "consultant", "contractor", "neutral"]);
export const claimStatus = pgEnum("claim_status", ["open", "notified", "closed"]);
export const rfiStatus = pgEnum("rfi_status", ["draft", "pending_approval", "sent", "answered", "closed"]);
export const approvalKind = pgEnum("approval_kind", [
  "schedule_change",
  "recovery_plan",
  "purchase_request",
  "supplier_message",
  "consultant_rfi",
  "delay_notice",
  "payment_claim",
  "client_report",
]);
export const approvalStatus = pgEnum("approval_status", [
  "pending",
  "approved",
  "rejected",
  "executed",
  "failed",
  "expired",
]);
export const actorType = pgEnum("actor_type", ["user", "agent", "system"]);
export const jobStatus = pgEnum("job_status", ["pending", "running", "done", "failed"]);
export const agentRunStatus = pgEnum("agent_run_status", ["ok", "error"]);
export const claimPaymentStatus = pgEnum("payment_claim_status", ["draft", "pending_approval", "submitted", "paid"]);

// ---------------------------------------------------------------------------
// Companies, people and access
// ---------------------------------------------------------------------------

export const companies = pgTable("companies", {
  id: id(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const users = pgTable(
  "users",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    email: text("email"),
    passwordHash: text("password_hash"),
    role: userRole("role").notNull(),
    phone: text("phone"),
    language: language("language").notNull().default("en"),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }),
    /** Local hours (0-23) during which nobody is chased. */
    quietFrom: integer("quiet_from").notNull().default(20),
    quietTo: integer("quiet_to").notNull().default(7),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("users_email_key").on(sql`lower(${t.email})`),
    uniqueIndex("users_telegram_user_id_key").on(t.telegramUserId),
    index("users_company_idx").on(t.companyId),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the session token. The token itself is never stored. */
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** One-time codes that link a Telegram account to a user: /start <code>. */
export const invites = pgTable("invites", {
  code: text("code").primaryKey(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Projects and schedule
// ---------------------------------------------------------------------------

export interface ProjectCalendar {
  workingWeekdays: number[];
  holidays: string[];
}

export const projects = pgTable(
  "projects",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    client: text("client"),
    consultant: text("consultant"),
    locationName: text("location_name"),
    latitude: doublePrecision("latitude"),
    longitude: doublePrecision("longitude"),
    startDate: date("start_date").notNull(),
    contractFinish: date("contract_finish").notNull(),
    /** Status date of the latest schedule update. */
    dataDate: date("data_date").notNull(),
    calendar: jsonb("calendar").$type<ProjectCalendar>().notNull(),
    /** Penalty per day of delay, from the contract. */
    liquidatedDamagesPerDay: money("liquidated_damages_per_day"),
    retentionPercent: numeric("retention_percent", { precision: 5, scale: 2, mode: "number" }).notNull().default(5),
    /** Daily labour rates in birr by trade, e.g. { mason: 900, labourer: 450 }. "default" covers other trades. */
    labourRates: jsonb("labour_rates").$type<Record<string, number>>().notNull().default({}),
    /** Local time the evening check-in goes out, HH:MM. */
    checkInTime: text("check_in_time").notNull().default("17:00"),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("projects_company_idx").on(t.companyId)],
);

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] }), index("project_members_user_idx").on(t.userId)],
);

export const activities = pgTable(
  "activities",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** The activity id used in the contractor's own schedule, e.g. "A1040". */
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: activityKind("kind").notNull().default("general"),
    zone: text("zone"),
    duration: integer("duration").notNull(),
    /** Baseline dates as workday indexes, set when the baseline is approved. */
    baselineStart: integer("baseline_start"),
    baselineFinish: integer("baseline_finish"),
    /** Held until this date, e.g. a pour moved past forecast rain. */
    startNoEarlierThan: date("start_no_earlier_than"),
    actualStart: date("actual_start"),
    actualFinish: date("actual_finish"),
    remainingDuration: integer("remaining_duration"),
    percentComplete: numeric("percent_complete", { precision: 5, scale: 2, mode: "number" }).notNull().default(0),
    /** Unit progress is measured in, e.g. m2 of blockwork. */
    progressUnit: text("progress_unit"),
    plannedQuantity: quantity("planned_quantity"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("activities_project_code_key").on(t.projectId, t.code)],
);

export const activityLinks = pgTable(
  "activity_links",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    fromActivityId: uuid("from_activity_id")
      .notNull()
      .references(() => activities.id, { onDelete: "cascade" }),
    toActivityId: uuid("to_activity_id")
      .notNull()
      .references(() => activities.id, { onDelete: "cascade" }),
    type: linkType("type").notNull().default("FS"),
    lag: integer("lag").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.fromActivityId, t.toActivityId] }),
    index("activity_links_project_idx").on(t.projectId),
  ],
);

/** Recovery moves the PM has said are possible, priced in advance. */
export const recoveryMeasures = pgTable("recovery_measures", {
  id: id(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  activityId: uuid("activity_id")
    .notNull()
    .references(() => activities.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  /** "shorten" with days, or "relink" with from activity, type and lag. */
  change: jsonb("change")
    .$type<
      | { kind: "shorten"; days: number }
      | { kind: "relink"; fromActivityId: string; type: "FS" | "SS" | "FF" | "SF"; lag: number }
    >()
    .notNull(),
  cost: money("cost").notNull(),
  risk: text("risk", { enum: ["low", "medium", "high"] }).notNull(),
  /** Set once the measure has been put into the schedule, so it is not offered again. */
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/** Result of every schedule calculation, kept for history and the dashboard. */
export const scheduleSnapshots = pgTable(
  "schedule_snapshots",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    dataDate: date("data_date").notNull(),
    finishDate: date("finish_date").notNull(),
    /** Workdays of slip against the contract finish; negative means ahead. */
    slipDays: integer("slip_days").notNull(),
    criticalPath: jsonb("critical_path").$type<string[]>().notNull(),
    activities: jsonb("activities").$type<unknown[]>().notNull(),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("schedule_snapshots_project_idx").on(t.projectId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Site reporting
// ---------------------------------------------------------------------------

export interface LogWorkers {
  trade: string;
  count: number;
}
export interface LogProgress {
  activityCode: string;
  percentComplete: number;
  quantityDone?: number;
  note?: string;
}
export interface LogMaterial {
  material: string;
  quantity: number;
  unit: string;
}
export interface LogIssue {
  kind: "delay" | "safety" | "quality" | "material" | "weather" | "information" | "other";
  description: string;
  activityCode?: string;
  severity: "low" | "medium" | "high";
  delayDays?: number;
}

export const dailyLogs = pgTable(
  "daily_logs",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    supervisorId: uuid("supervisor_id")
      .notNull()
      .references(() => users.id),
    logDate: date("log_date").notNull(),
    status: dailyLogStatus("status").notNull().default("collecting"),
    summary: text("summary"),
    weather: text("weather"),
    workers: jsonb("workers").$type<LogWorkers[]>().notNull().default([]),
    progress: jsonb("progress").$type<LogProgress[]>().notNull().default([]),
    materialsReceived: jsonb("materials_received").$type<LogMaterial[]>().notNull().default([]),
    materialsUsed: jsonb("materials_used").$type<LogMaterial[]>().notNull().default([]),
    issues: jsonb("issues").$type<LogIssue[]>().notNull().default([]),
    followUpQuestion: text("follow_up_question"),
    followUpsAsked: integer("follow_ups_asked").notNull().default(0),
    confidence: numeric("confidence", { precision: 3, scale: 2, mode: "number" }),
    correctedBy: uuid("corrected_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("daily_logs_unique_day").on(t.projectId, t.supervisorId, t.logDate)],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id),
    dailyLogId: uuid("daily_log_id").references(() => dailyLogs.id, { onDelete: "set null" }),
    direction: messageDirection("direction").notNull(),
    kind: messageKind("kind").notNull(),
    text: text("text"),
    telegramChatId: bigint("telegram_chat_id", { mode: "number" }),
    telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
    telegramFileId: text("telegram_file_id"),
    mimeType: text("mime_type"),
    createdAt: createdAt(),
  },
  (t) => [
    index("messages_daily_log_idx").on(t.dailyLogId),
    index("messages_project_idx").on(t.projectId, t.createdAt),
  ],
);

/** Raw Telegram updates, stored before processing so a retry never double counts. */
export const telegramUpdates = pgTable("telegram_updates", {
  updateId: bigint("update_id", { mode: "number" }).primaryKey(),
  payload: jsonb("payload").notNull(),
  receivedAt: createdAt(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

// ---------------------------------------------------------------------------
// Materials and purchasing
// ---------------------------------------------------------------------------

export const materials = pgTable(
  "materials",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    unit: text("unit").notNull(),
    onHand: quantity("on_hand").notNull().default(0),
    /** Unit of the progress it is consumed against, e.g. m2. */
    progressUnit: text("progress_unit"),
    usagePerUnit: numeric("usage_per_unit", { precision: 14, scale: 4, mode: "number" }),
    leadTimeDays: integer("lead_time_days").notNull().default(3),
    safetyDays: integer("safety_days").notNull().default(2),
    lastUnitPrice: money("last_unit_price"),
    /** Activity kinds that consume this material, for the look ahead. */
    consumedBy: jsonb("consumed_by").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("materials_project_name_key").on(t.projectId, sql`lower(${t.name})`)],
);

export const materialTransactions = pgTable(
  "material_transactions",
  {
    id: id(),
    materialId: uuid("material_id")
      .notNull()
      .references(() => materials.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    kind: materialTxKind("kind").notNull(),
    quantity: quantity("quantity").notNull(),
    /** Progress achieved with this usage, in the material's progress unit. */
    progress: quantity("progress"),
    dailyLogId: uuid("daily_log_id").references(() => dailyLogs.id, { onDelete: "set null" }),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("material_tx_material_idx").on(t.materialId, t.date)],
);

export const suppliers = pgTable("suppliers", {
  id: id(),
  companyId: uuid("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  userId: uuid("user_id").references(() => users.id),
  phone: text("phone"),
  email: text("email"),
  materials: jsonb("materials").$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
});

export const purchaseRequests = pgTable(
  "purchase_requests",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    materialId: uuid("material_id")
      .notNull()
      .references(() => materials.id, { onDelete: "cascade" }),
    quantity: quantity("quantity").notNull(),
    neededBy: date("needed_by").notNull(),
    status: purchaseStatus("status").notNull().default("draft"),
    reason: text("reason").notNull(),
    selectedQuoteId: uuid("selected_quote_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("purchase_requests_project_idx").on(t.projectId, t.status)],
);

export const quotes = pgTable("quotes", {
  id: id(),
  purchaseRequestId: uuid("purchase_request_id")
    .notNull()
    .references(() => purchaseRequests.id, { onDelete: "cascade" }),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => suppliers.id),
  unitPrice: money("unit_price").notNull(),
  currency: text("currency").notNull().default("ETB"),
  unitPriceEtb: money("unit_price_etb").notNull(),
  leadTimeDays: integer("lead_time_days").notNull(),
  note: text("note"),
  receivedAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export const boqItems = pgTable(
  "boq_items",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    itemNo: text("item_no").notNull(),
    description: text("description").notNull(),
    unit: text("unit").notNull(),
    quantity: quantity("quantity").notNull(),
    rate: money("rate").notNull(),
    activityId: uuid("activity_id").references(() => activities.id, { onDelete: "set null" }),
  },
  (t) => [uniqueIndex("boq_items_project_item_key").on(t.projectId, t.itemNo)],
);

export const costEntries = pgTable(
  "cost_entries",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    category: costCategory("category").notNull(),
    amount: money("amount").notNull(),
    description: text("description").notNull(),
    /** Where it came from, e.g. "daily_log:<id>" or "purchase:<id>". Unique so a source is never costed twice. */
    sourceRef: text("source_ref"),
    createdAt: createdAt(),
  },
  (t) => [
    index("cost_entries_project_idx").on(t.projectId, t.date),
    uniqueIndex("cost_entries_source_key").on(t.sourceRef),
  ],
);

export interface PaymentClaimLine {
  boqItemId: string;
  itemNo: string;
  description: string;
  unit: string;
  rate: number;
  contractQuantity: number;
  previousQuantity: number;
  cumulativeQuantity: number;
  thisPeriodAmount: number;
  evidence: string[];
}

export const paymentClaims = pgTable(
  "payment_claims",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    periodEnd: date("period_end").notNull(),
    status: claimPaymentStatus("status").notNull().default("draft"),
    cumulativeGross: money("cumulative_gross").notNull(),
    previousGross: money("previous_gross").notNull(),
    retention: money("retention").notNull(),
    netThisPeriod: money("net_this_period").notNull(),
    lines: jsonb("lines").$type<PaymentClaimLine[]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("payment_claims_project_number_key").on(t.projectId, t.number)],
);

// ---------------------------------------------------------------------------
// Documents, information requests and claims
// ---------------------------------------------------------------------------

export const documents = pgTable("documents", {
  id: id(),
  projectId: uuid("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  kind: documentKind("kind").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  status: documentStatus("status").notNull().default("pending"),
  error: text("error"),
  uploadedBy: uuid("uploaded_by").references(() => users.id),
  createdAt: createdAt(),
});

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: id(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    /** Clause or section number, e.g. "14.3". */
    clause: text("clause"),
    heading: text("heading"),
    page: integer("page"),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
  },
  (t) => [
    index("document_chunks_document_idx").on(t.documentId, t.ordinal),
    index("document_chunks_project_idx").on(t.projectId),
    index("document_chunks_fts_idx").using("gin", sql`to_tsvector('simple', ${t.content})`),
  ],
);

export const rfis = pgTable(
  "rfis",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    question: text("question").notNull(),
    activityId: uuid("activity_id").references(() => activities.id, { onDelete: "set null" }),
    status: rfiStatus("status").notNull().default("draft"),
    raisedOn: date("raised_on").notNull(),
    dueOn: date("due_on").notNull(),
    answer: text("answer"),
    answeredOn: date("answered_on"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("rfis_project_number_key").on(t.projectId, t.number)],
);

export interface ClaimEvidence {
  type: "daily_log" | "message" | "photo" | "weather" | "rfi" | "schedule" | "payment" | "document";
  ref: string;
  date: string;
  note: string;
}

export const claimEvents = pgTable(
  "claim_events",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    cause: claimCause("cause").notNull(),
    responsible: responsibleParty("responsible").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    startedOn: date("started_on").notNull(),
    endedOn: date("ended_on"),
    activityIds: jsonb("activity_ids").$type<string[]>().notNull().default([]),
    /** Impact on the completion date from time impact analysis, in workdays. */
    delayDays: integer("delay_days").notNull().default(0),
    evidence: jsonb("evidence").$type<ClaimEvidence[]>().notNull().default([]),
    clauseRefs: jsonb("clause_refs").$type<string[]>().notNull().default([]),
    noticeDraft: text("notice_draft"),
    status: claimStatus("status").notNull().default("open"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("claim_events_project_idx").on(t.projectId, t.status)],
);

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

export const weatherForecasts = pgTable(
  "weather_forecasts",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    precipitationMm: doublePrecision("precipitation_mm").notNull(),
    precipitationProbability: integer("precipitation_probability"),
    windKmh: doublePrecision("wind_kmh"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.date] })],
);

// ---------------------------------------------------------------------------
// Approvals, audit and agent runs
// ---------------------------------------------------------------------------

export interface ApprovalEvidence {
  label: string;
  ref?: string;
}

export const approvals = pgTable(
  "approvals",
  {
    id: id(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    kind: approvalKind("kind").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    /** The exact action that runs if approved. Validated again before it runs. */
    action: jsonb("action").$type<{ type: string; [key: string]: unknown }>().notNull(),
    evidence: jsonb("evidence").$type<ApprovalEvidence[]>().notNull().default([]),
    requestedBy: text("requested_by").notNull(),
    approverRole: userRole("approver_role").notNull(),
    status: approvalStatus("status").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionNote: text("decision_note"),
    result: jsonb("result"),
    telegramMessages: jsonb("telegram_messages").$type<Array<{ chatId: number; messageId: number }>>().notNull().default([]),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("approvals_company_status_idx").on(t.companyId, t.status, t.createdAt)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    companyId: uuid("company_id")
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    actorType: actorType("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    reason: text("reason"),
    data: jsonb("data"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_project_idx").on(t.projectId, t.createdAt)],
);

export const agentRuns = pgTable(
  "agent_runs",
  {
    id: id(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(),
    trigger: text("trigger").notNull(),
    model: text("model").notNull(),
    input: jsonb("input"),
    output: jsonb("output"),
    status: agentRunStatus("status").notNull(),
    error: text("error"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    durationMs: integer("duration_ms").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("agent_runs_project_idx").on(t.projectId, t.createdAt)],
);

/** Users chased by the agents, for quiet hours and weekly caps. */
export const reminders = pgTable(
  "reminders",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    sentAt: createdAt(),
  },
  (t) => [index("reminders_user_idx").on(t.userId, t.sentAt)],
);

// ---------------------------------------------------------------------------
// Job queue
// ---------------------------------------------------------------------------

export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: jobStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    /** Same key twice means the same job: the second insert is ignored. */
    idempotencyKey: text("idempotency_key"),
    createdAt: createdAt(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("jobs_ready_idx").on(t.status, t.runAt),
    uniqueIndex("jobs_idempotency_key").on(t.idempotencyKey),
  ],
);

// ---------------------------------------------------------------------------
// Weekly planning
// ---------------------------------------------------------------------------

/**
 * The work committed for a week, so the following week the plan can be
 * scored: percent plan complete is the share of committed activities that
 * were actually finished.
 */
export const weeklyPlans = pgTable(
  "weekly_plans",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    weekStart: date("week_start").notNull(),
    weekEnd: date("week_end").notNull(),
    /** Activities planned to finish within the week. */
    committed: jsonb("committed").$type<string[]>().notNull(),
    /** Filled in when the week is scored. */
    completed: jsonb("completed").$type<string[]>(),
    percentPlanComplete: numeric("percent_plan_complete", { precision: 5, scale: 1, mode: "number" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("weekly_plans_project_week_key").on(t.projectId, t.weekStart)],
);

// ---------------------------------------------------------------------------
// Document files
// ---------------------------------------------------------------------------

const bytea = customType<{ data: Buffer; driverData: Buffer | Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) => (Buffer.isBuffer(value) ? value : Buffer.from(value)),
});

/** The uploaded file, kept until it has been read and indexed, then removed. */
export const documentFiles = pgTable("document_files", {
  documentId: uuid("document_id")
    .primaryKey()
    .references(() => documents.id, { onDelete: "cascade" }),
  data: bytea("data").notNull(),
});

// ---------------------------------------------------------------------------
// Google Calendar sync
// ---------------------------------------------------------------------------

/** One event SiteMate keeps on the company calendar, so a sync only touches what changed. */
export const calendarEvents = pgTable(
  "calendar_events",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** What the event stands for, e.g. "activity:B2100" or "rfi:<id>". */
    key: text("key").notNull(),
    googleEventId: text("google_event_id").notNull(),
    /** Hash of the event body last sent, to skip unchanged events. */
    contentHash: text("content_hash").notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("calendar_events_project_key").on(t.projectId, t.key)],
);
