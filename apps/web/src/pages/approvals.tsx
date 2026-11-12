import { useState } from "react";
import { ApprovalCard } from "../components/approval-card";
import { Empty, ErrorNote, Loading, PageHeader, cx } from "../components/ui";
import { useApprovals, usePortfolio } from "../lib/queries";

const FILTERS = [
  { value: "pending", label: "Waiting" },
  { value: "", label: "All" },
] as const;

export function ApprovalsPage() {
  const [filter, setFilter] = useState<string>("pending");
  const { data, isLoading, error } = useApprovals(filter || undefined);
  const portfolio = usePortfolio();
  const names = new Map(portfolio.data?.projects.map((p) => [p.id, p.name]));
  const approvals = data?.approvals ?? [];

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Approvals"
        meta="The agents collect, record and remind on their own. Anything that changes the plan, spends money or leaves the company waits here and on Telegram."
        actions={
          <div className="flex rounded-[4px] border border-rule-strong p-0.5" role="tablist">
            {FILTERS.map((f) => (
              <button
                key={f.label}
                role="tab"
                aria-selected={filter === f.value}
                onClick={() => setFilter(f.value)}
                className={cx("rounded-[3px] px-3 py-1 text-[13px]", filter === f.value ? "bg-ink text-page" : "text-ink-2 hover:text-ink")}
              >
                {f.label}
              </button>
            ))}
          </div>
        }
      />
      <ErrorNote error={error} />
      {isLoading ? <Loading /> : null}
      {!isLoading && approvals.length === 0 ? (
        <Empty title={filter === "pending" ? "Nothing is waiting for you" : "No requests yet"}>
          When an agent proposes a recovery plan, a purchase, a delay notice or a payment claim, it appears here.
        </Empty>
      ) : null}
      <div className="flex flex-col gap-4">
        {approvals.map((approval) => (
          <ApprovalCard key={approval.id} approval={approval} projectName={approval.projectId ? names.get(approval.projectId) : undefined} />
        ))}
      </div>
    </div>
  );
}
