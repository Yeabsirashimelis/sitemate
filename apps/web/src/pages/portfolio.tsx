import { ArrowUpRight, CloudRain } from "lucide-react";
import { Link } from "react-router";
import { Code, Empty, ErrorNote, Loading, PageHeader, Status, cx } from "../components/ui";
import { useAuth } from "../lib/auth";
import { birrCompact, dayDate, longDate, number, perfIndex, slipText } from "../lib/format";
import { usePortfolio } from "../lib/queries";
import { indexTone, slipTone } from "../lib/status";
import type { PortfolioCard } from "../lib/types";

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
}

/** Planned progress against earned progress, as one thin bar. */
function ProgressLine({ card }: { card: PortfolioCard }) {
  const earned = card.budgetAtCompletion > 0 ? Math.min(1, card.earnedValue / card.budgetAtCompletion) : 0;
  return (
    <div>
      <div className="flex justify-between text-[12px] text-ink-3">
        <span>Work done by value</span>
        <span className="tabular text-ink-2">{Math.round(earned * 100)}%</span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-sunken">
        <div className="h-full rounded-full bg-ink" style={{ width: `${earned * 100}%` }} />
      </div>
    </div>
  );
}

function ProjectRow({ card }: { card: PortfolioCard }) {
  const tone = slipTone(card.slipDays);
  const needs = [
    card.pendingApprovals ? `${card.pendingApprovals} waiting for a decision` : null,
    card.materialsToOrder ? `${card.materialsToOrder} material${card.materialsToOrder > 1 ? "s" : ""} to order` : null,
    card.openClaims ? `${card.openClaims} open claim${card.openClaims > 1 ? "s" : ""}` : null,
  ].filter(Boolean);
  const rain = card.nextForecast && card.nextForecast.precipitationMm >= 5;

  return (
    <Link
      to={`/projects/${card.id}`}
      className="group grid gap-x-8 gap-y-4 border-b border-rule py-6 transition-colors hover:bg-surface sm:px-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1fr)]"
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2 className="truncate text-[17px] font-semibold tracking-[-0.01em]">{card.name}</h2>
          <ArrowUpRight className="size-4 shrink-0 text-ink-3 opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
        </div>
        <div className="mt-0.5 text-[13px] text-ink-2">{card.locationName}</div>
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-3">
          <span>Status as of {dayDate(card.dataDate)}</span>
          <span>{card.lastLogDate ? `Last site report ${dayDate(card.lastLogDate)}` : "No site report yet"}</span>
        </div>
      </div>

      <div>
        <div className="text-[12px] text-ink-3">Forecast handover</div>
        <div className="mt-1 text-[22px] font-semibold leading-none tracking-[-0.01em]">{longDate(card.forecastFinish)}</div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Status tone={tone}>{slipText(card.slipDays)}</Status>
          <span className="text-[12px] text-ink-3">Contract {longDate(card.contractFinish)}</span>
        </div>
        {card.criticalPath.length > 0 ? (
          <div className="mt-2 truncate text-[12px] text-ink-3">
            Driven by <Code>{card.criticalPath.slice(-3).join(" › ")}</Code>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-3">
        <ProgressLine card={card} />
        <div className="flex gap-6 text-[12px]">
          <div>
            <div className="text-ink-3">SPI</div>
            <div className="mt-0.5 flex items-center gap-1.5 font-medium tabular">
              <Status tone={indexTone(card.spi)}>{perfIndex(card.spi)}</Status>
            </div>
          </div>
          <div>
            <div className="text-ink-3">CPI</div>
            <div className="mt-0.5 font-medium tabular">
              <Status tone={indexTone(card.cpi)}>{perfIndex(card.cpi)}</Status>
            </div>
          </div>
          <div>
            <div className="text-ink-3">Earned</div>
            <div className="mt-0.5 font-medium tabular">{birrCompact(card.earnedValue)}</div>
          </div>
        </div>
        <div className={cx("text-[12px]", needs.length ? "text-ink" : "text-ink-3")}>
          {needs.length ? needs.join(" · ") : "Nothing waiting on you"}
          {rain ? (
            <span className="mt-1 flex items-center gap-1 text-ink-2">
              <CloudRain className="size-3.5" aria-hidden /> {number(card.nextForecast!.precipitationMm, 1)} mm rain forecast {dayDate(card.nextForecast!.date)}
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}

export function PortfolioPage() {
  const { session } = useAuth();
  const { data, isLoading, error } = usePortfolio();
  const projects = data?.projects ?? [];
  const late = projects.filter((p) => (p.slipDays ?? 0) > 0).length;
  const waiting = projects.reduce((sum, p) => sum + p.pendingApprovals, 0);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={session?.company.name}
        title={`${greeting()}, ${session?.user.name.split(" ")[0] ?? ""}`}
        meta={
          projects.length
            ? `${projects.length} active project${projects.length > 1 ? "s" : ""}. ${late ? `${late} forecast to finish late.` : "All on or ahead of the contract date."} ${waiting ? `${waiting} decision${waiting > 1 ? "s" : ""} waiting for you.` : ""}`
            : undefined
        }
      />
      <ErrorNote error={error} />
      {isLoading ? <Loading /> : null}
      {!isLoading && projects.length === 0 && !error ? (
        <Empty title="No projects yet">Create a project and import its schedule to start. Supervisors then report from site on Telegram.</Empty>
      ) : null}
      <div>
        {projects.map((card) => (
          <ProjectRow key={card.id} card={card} />
        ))}
      </div>
    </div>
  );
}
