import type { ActivityFeed } from "./types";

const ACTIONS: Record<string, string> = {
  "daily_log.applied": "Daily log applied to the schedule and stock",
  "daily_log.corrected": "Daily log corrected",
  "approval.requested": "Asked for a decision",
  "approval.approved": "Approved a request",
  "approval.rejected": "Rejected a request",
  "schedule.imported": "Imported the schedule",
  "schedule.delay_recorded": "Recorded a delay on the schedule",
  "schedule.recovery_applied": "Applied a recovery plan",
  "weather.flagged": "Flagged a weather risk",
  "procurement.quotes_requested": "Asked suppliers for quotes",
  "procurement.quote_received": "Read a supplier quote",
  "rfi.reminded": "Reminded about an overdue RFI",
  "rfi.answered": "Recorded an RFI answer",
  "claims.notice_sent": "Sent a delay notice",
  "boq.imported": "Imported the bill of quantities",
  "document.uploaded": "Uploaded a document",
  "material.adjusted": "Corrected a stock count",
  "recovery_measure.created": "Priced a recovery measure",
  "project.created": "Created the project",
  "project.updated": "Updated the project settings",
  "telegram.linked": "Linked a Telegram account",
  "cost.recorded": "Recorded a cost",
  "calendar.synced": "Updated the Google Calendar",
  "user.created": "Added a team member",
  "user.updated": "Updated a team member",
  "company.created": "Set up the company",
  "action.notify.project": "Sent the project team an update",
  "action.claims.send_notice": "Sent a delay notice to the engineer",
  "action.rfi.send": "Sent an RFI",
  "action.cost.submit_claim": "Submitted a payment claim",
  "action.procurement.request_quotes": "Asked suppliers for quotes",
  "action.procurement.place_order": "Placed a purchase order",
  "action.schedule.apply_recovery": "Applied a recovery plan",
  "action.schedule.set_constraint": "Held an activity back",
  "action.failed": "An approved action could not be carried out",
};

export function describeAction(action: string): string {
  if (ACTIONS[action]) return ACTIONS[action];
  const words = action.replace(/^action\./, "").replace(/[._]/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const AGENT_NAMES: Record<string, string> = {
  site: "Site agent",
  schedule: "Schedule agent",
  weather: "Weather agent",
  procurement: "Procurement agent",
  cost: "Cost agent",
  planning: "Planning agent",
  documents: "Documents agent",
  claims: "Claims agent",
  calendar: "Calendar agent",
};

export type FeedEntry = ActivityFeed["entries"][number];

export interface FeedGroup {
  first: FeedEntry;
  count: number;
}

/** Folds runs of the same action by the same actor into one line with a count. */
export function groupFeed(entries: FeedEntry[]): FeedGroup[] {
  const groups: FeedGroup[] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last && last.first.action === entry.action && last.first.actorId === entry.actorId) last.count++;
    else groups.push({ first: entry, count: 1 });
  }
  return groups;
}
