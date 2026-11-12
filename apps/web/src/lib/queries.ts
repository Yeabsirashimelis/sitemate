import { useMutation, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api } from "./api";
import type {
  ActivityFeed,
  Approval,
  ClaimEvent,
  CostReport,
  DailyLog,
  DocumentRow,
  Lookahead,
  MaterialRow,
  PaymentClaim,
  PortfolioCard,
  Project,
  ProjectMember,
  PurchaseRequest,
  RecoveryMeasure,
  Rfi,
  Schedule,
  User,
} from "./types";

/** Agents act in the background, so screens refresh on their own. */
const LIVE = { refetchInterval: 30_000 } as const;

const get = <T,>(path: string) => () => api<T>(path);

export const keys = {
  portfolio: ["portfolio"] as QueryKey,
  project: (id: string) => ["project", id] as QueryKey,
  schedule: (id: string) => ["project", id, "schedule"] as QueryKey,
  lookahead: (id: string) => ["project", id, "lookahead"] as QueryKey,
  calendar: (id: string) => ["project", id, "calendar"] as QueryKey,
  suppliers: ["suppliers"] as QueryKey,
  measures: (id: string) => ["project", id, "measures"] as QueryKey,
  materials: (id: string) => ["project", id, "materials"] as QueryKey,
  purchases: (id: string) => ["project", id, "purchases"] as QueryKey,
  cost: (id: string) => ["project", id, "cost"] as QueryKey,
  claims: (id: string) => ["project", id, "claims"] as QueryKey,
  paymentClaims: (id: string) => ["project", id, "payment-claims"] as QueryKey,
  rfis: (id: string) => ["project", id, "rfis"] as QueryKey,
  logs: (id: string) => ["project", id, "logs"] as QueryKey,
  documents: (id: string) => ["project", id, "documents"] as QueryKey,
  activity: (id: string) => ["project", id, "activity"] as QueryKey,
  approvals: (status?: string) => ["approvals", status ?? "all"] as QueryKey,
  users: ["users"] as QueryKey,
};

export const usePortfolio = () => useQuery({ queryKey: keys.portfolio, queryFn: get<{ projects: PortfolioCard[] }>("/portfolio"), ...LIVE });

export const useProject = (id: string) =>
  useQuery({ queryKey: keys.project(id), queryFn: get<{ project: Project; members: ProjectMember[] }>(`/projects/${id}`) });

export const useSchedule = (id: string) =>
  useQuery({ queryKey: keys.schedule(id), queryFn: get<{ schedule: Schedule }>(`/projects/${id}/schedule`), ...LIVE });

export const useLookahead = (id: string) => useQuery({ queryKey: keys.lookahead(id), queryFn: get<Lookahead>(`/projects/${id}/lookahead`), ...LIVE });

export interface CalendarStatus {
  connected: boolean;
  events: number;
  lastSyncedAt: string | null;
}

export const useCalendarStatus = (id: string) => useQuery({ queryKey: keys.calendar(id), queryFn: get<CalendarStatus>(`/projects/${id}/calendar`) });

export interface Supplier {
  id: string;
  name: string;
  userId: string | null;
  phone: string | null;
  materials: string[];
  telegramLinked: boolean;
}

export const useSuppliers = () => useQuery({ queryKey: keys.suppliers, queryFn: get<{ suppliers: Supplier[] }>("/suppliers") });

export const useMeasures = (id: string) =>
  useQuery({ queryKey: keys.measures(id), queryFn: get<{ measures: RecoveryMeasure[] }>(`/projects/${id}/recovery-measures`) });

export const useMaterials = (id: string) =>
  useQuery({ queryKey: keys.materials(id), queryFn: get<{ materials: MaterialRow[] }>(`/projects/${id}/materials`), ...LIVE });

export const usePurchases = (id: string) =>
  useQuery({ queryKey: keys.purchases(id), queryFn: get<{ purchaseRequests: PurchaseRequest[] }>(`/projects/${id}/purchase-requests`), ...LIVE });

export const useCost = (id: string) => useQuery({ queryKey: keys.cost(id), queryFn: get<CostReport>(`/projects/${id}/cost`), ...LIVE });

export const usePaymentClaims = (id: string) =>
  useQuery({ queryKey: keys.paymentClaims(id), queryFn: get<{ claims: PaymentClaim[] }>(`/projects/${id}/payment-claims`), ...LIVE });

export const useClaims = (id: string) =>
  useQuery({
    queryKey: keys.claims(id),
    queryFn: get<{ events: ClaimEvent[]; totals: { open: number; claimableDays: number } }>(`/projects/${id}/claims`),
    ...LIVE,
  });

export const useRfis = (id: string) => useQuery({ queryKey: keys.rfis(id), queryFn: get<{ rfis: Rfi[] }>(`/projects/${id}/rfis`), ...LIVE });

export const useDailyLogs = (id: string) =>
  useQuery({ queryKey: keys.logs(id), queryFn: get<{ logs: DailyLog[] }>(`/projects/${id}/daily-logs`), ...LIVE });

export const useDocuments = (id: string) =>
  useQuery({
    queryKey: keys.documents(id),
    queryFn: get<{ documents: DocumentRow[] }>(`/projects/${id}/documents`),
    refetchInterval: (query) => (query.state.data?.documents.some((d) => d.status === "pending") ? 3000 : 30_000),
  });

export const useActivity = (id: string) => useQuery({ queryKey: keys.activity(id), queryFn: get<ActivityFeed>(`/projects/${id}/activity`), ...LIVE });

export const useApprovals = (status?: string) =>
  useQuery({
    queryKey: keys.approvals(status),
    queryFn: get<{ approvals: Approval[] }>(`/approvals${status ? `?status=${status}` : ""}`),
    refetchInterval: 15_000,
  });

export const useUsers = () => useQuery({ queryKey: keys.users, queryFn: get<{ users: User[] }>("/users") });

/** Approve or reject, then refresh everything an approved action may have changed. */
export function useDecide() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision, note }: { id: string; decision: "approve" | "reject"; note?: string }) =>
      api<{ approval: Approval }>(`/approvals/${id}/decision`, { body: { decision, ...(note ? { note } : {}) } }),
    onSettled: () => queryClient.invalidateQueries(),
  });
}
