/** Shapes of the API responses the dashboard reads. */

export type Role = "owner" | "project_manager" | "site_engineer" | "supervisor" | "subcontractor" | "supplier";

export interface User {
  id: string;
  companyId: string;
  name: string;
  email: string | null;
  role: Role;
  phone: string | null;
  language: "en" | "am";
  telegramUserId: number | null;
  active: boolean;
}

export interface Company {
  id: string;
  name: string;
}

export interface Project {
  id: string;
  name: string;
  client: string | null;
  consultant: string | null;
  locationName: string | null;
  latitude: number | null;
  longitude: number | null;
  startDate: string;
  contractFinish: string;
  dataDate: string;
  calendar: { workingWeekdays: number[]; holidays: string[] };
  liquidatedDamagesPerDay: number | null;
  retentionPercent: number;
  checkInTime: string;
  labourRates: Record<string, number>;
  active: boolean;
}

export interface ProjectMember {
  id: string;
  name: string;
  role: Role;
  linkedToTelegram: boolean;
}

export interface PortfolioCard {
  id: string;
  name: string;
  locationName: string | null;
  dataDate: string;
  contractFinish: string;
  forecastFinish: string | null;
  slipDays: number | null;
  criticalPath: string[];
  spi: number | null;
  cpi: number | null;
  earnedValue: number;
  budgetAtCompletion: number;
  pendingApprovals: number;
  openClaims: number;
  materialsToOrder: number;
  nextForecast: { date: string; precipitationMm: number; precipitationProbability: number | null; windKmh: number | null } | null;
  lastLogDate: string | null;
}

export interface ScheduleActivity {
  id: string;
  code: string;
  name: string;
  kind: string;
  zone: string | null;
  status: "not_started" | "in_progress" | "complete";
  duration: number;
  percentComplete: number;
  startDate: string;
  finishDate: string;
  earlyStart: number;
  earlyFinish: number;
  lateStart: number;
  lateFinish: number;
  totalFloat: number;
  freeFloat: number;
  critical: boolean;
  baselineStart: number | null;
  baselineFinish: number | null;
  startNoEarlierThan: string | null;
  actualStart: string | null;
  actualFinish: string | null;
}

export interface Schedule {
  dataDate: string;
  finishDate: string;
  slipDays: number;
  criticalPath: string[];
  activities: ScheduleActivity[];
  calculatedAt: string;
  reason: string;
}

export interface WhatIfResult {
  activityCode: string;
  days: number;
  floatBefore: number;
  slipDays: number;
  finishBefore: string;
  finishAfter: string;
  newlyCritical: string[];
  criticalPath: string[];
  recovery: {
    options: Array<{ measureId: string; description: string; daysRecovered: number; cost: number; costPerDay: number; risk: string }>;
    plan: { measureIds: string[]; totalCost: number; daysRecovered: number; finishDate: string; remainingSlip: number };
  };
}

export interface RecoveryMeasure {
  id: string;
  activityCode: string;
  activityName: string;
  description: string;
  change: { kind: "shorten"; days: number } | { kind: "relink"; fromActivityId: string; type: string; lag: number };
  cost: number;
  risk: "low" | "medium" | "high";
  appliedAt: string | null;
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "executed" | "failed" | "expired";

export interface Approval {
  id: string;
  projectId: string | null;
  kind: string;
  title: string;
  summary: string;
  evidence: Array<{ label: string; ref?: string }>;
  requestedBy: string;
  approverRole: Role;
  status: ApprovalStatus;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  result: unknown;
  expiresAt: string | null;
  createdAt: string;
}

export interface Constraint {
  kind: "predecessor" | "material" | "information" | "weather";
  description: string;
  severity: "warning" | "blocking";
}

export interface LookaheadItem {
  code: string;
  name: string;
  zone: string | null;
  startDate: string;
  finishDate: string;
  status: "not_started" | "in_progress";
  critical: boolean;
  totalFloat: number;
  readiness: "ready" | "at_risk" | "blocked";
  constraints: Constraint[];
}

export interface Lookahead {
  from: string;
  to: string;
  items: LookaheadItem[];
  plans: Array<{ weekStart: string; weekEnd: string; committed: string[]; completed: string[] | null; percentPlanComplete: number | null }>;
}

export interface MaterialRow {
  id: string;
  name: string;
  unit: string;
  onHand: number;
  usagePerUnit: number | null;
  dailyUse: number;
  runOutDate: string | null;
  orderBy: string | null;
  status: "ok" | "order_soon" | "order_now" | "no_usage_data";
  openOrderQuantity: number;
  leadTimeDays: number;
  lastUnitPrice: number | null;
}

export interface PurchaseRequest {
  id: string;
  quantity: number;
  neededBy: string;
  status: "draft" | "pending_approval" | "approved" | "ordered" | "delivered" | "cancelled";
  reason: string;
  createdAt: string;
  material: { id: string; name: string; unit: string };
  quotes: Array<{ id: string; supplierName: string; unitPriceEtb: number; unitPrice: number; currency: string; leadTimeDays: number; note: string | null }>;
  selectedQuoteId: string | null;
  suppliersAsked: number | null;
  /** The decision this request is waiting on, if any. */
  approval: { id: string; title: string; approverRole: string; step: "quotes" | "order" } | null;
}

export interface CostReport {
  dataDate: string;
  summary: {
    budgetAtCompletion: number;
    plannedValue: number;
    earnedValue: number;
    actualCost: number;
    scheduleVariance: number;
    costVariance: number;
    spi: number | null;
    cpi: number | null;
    estimateAtCompletion: number | null;
    varianceAtCompletion: number | null;
  };
  series: Array<{ date: string; plannedValue: number; earnedValue: number; actualCost: number }>;
  costByCategory: Record<string, number>;
}

export interface PaymentClaim {
  id: string;
  number: number;
  periodEnd: string;
  status: "draft" | "pending_approval" | "submitted" | "paid";
  cumulativeGross: number;
  previousGross: number;
  retention: number;
  netThisPeriod: number;
  lines: Array<{ itemNo: string; description: string; unit: string; contractQuantity: number; cumulativeQuantity: number; thisPeriodAmount: number }>;
}

export interface ClaimEvent {
  id: string;
  cause: string;
  responsible: string;
  title: string;
  description: string;
  startedOn: string;
  delayDays: number;
  evidence: Array<{ type: string; ref: string; date: string; note: string }>;
  clauseRefs: string[];
  noticeDraft: string | null;
  status: "open" | "notified" | "closed";
}

export interface Rfi {
  id: string;
  number: number;
  question: string;
  activityCode: string | null;
  status: "draft" | "pending_approval" | "sent" | "answered" | "closed";
  raisedOn: string;
  dueOn: string;
  answer: string | null;
  answeredOn: string | null;
}

export interface DailyLog {
  id: string;
  logDate: string;
  status: "collecting" | "awaiting_answer" | "complete";
  supervisorName: string;
  summary: string | null;
  weather: string | null;
  workers: Array<{ trade: string; count: number }>;
  progress: Array<{ activityCode: string; percentComplete: number; quantityDone?: number; note?: string }>;
  materialsReceived: Array<{ material: string; quantity: number; unit: string }>;
  materialsUsed: Array<{ material: string; quantity: number; unit: string }>;
  issues: Array<{ kind: string; description: string; activityCode?: string; severity: string; delayDays?: number }>;
  followUpQuestion: string | null;
  confidence: number | null;
  correctedBy: string | null;
  messages: Array<{ id: string; direction: "in" | "out"; kind: string; text: string | null; createdAt: string }>;
}

export interface DocumentRow {
  id: string;
  title: string;
  kind: string;
  fileName: string;
  status: "pending" | "indexed" | "failed";
  error: string | null;
  chunks: number;
  createdAt: string;
}

export interface SearchHit {
  id: string;
  documentTitle: string;
  clause: string | null;
  heading: string | null;
  page: number | null;
  content: string;
}

export interface Answer {
  found: boolean;
  answer: string;
  sources: Array<{ id: string; label: string; ref: string }>;
}

export interface ActivityFeed {
  entries: Array<{ id: number; actorType: "user" | "agent" | "system"; actorId: string; action: string; reason: string | null; createdAt: string }>;
  agents: Array<{ agent: string; runs: number; errors: number; inputTokens: number; outputTokens: number; avgMs: number }>;
  recentRuns: Array<{ id: string; agent: string; trigger: string; status: "ok" | "error"; error: string | null; durationMs: number; createdAt: string }>;
}
