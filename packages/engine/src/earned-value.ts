/**
 * Earned value.
 *
 * Planned value: the budget of the work that should be done by now.
 * Earned value: the budget of the work that is actually done.
 * Actual cost: what that work really cost.
 *
 * Comparing the three answers two questions with numbers instead of
 * feelings: are we behind (SPI) and are we over budget (CPI)?
 */

export interface BudgetedActivity {
  id: string;
  /** Budget from the BOQ items assigned to this activity, in birr. */
  budget: number;
  /** Baseline early start and finish, workday indexes (exclusive finish). */
  baselineStart: number;
  baselineFinish: number;
  /** 0 to 100, from measured progress. */
  percentComplete: number;
}

export interface EarnedValueSummary {
  budgetAtCompletion: number;
  plannedValue: number;
  earnedValue: number;
  actualCost: number;
  scheduleVariance: number;
  costVariance: number;
  /** Below 1 means behind schedule. Null when nothing was planned yet. */
  spi: number | null;
  /** Below 1 means over budget. Null when nothing has been spent yet. */
  cpi: number | null;
  /** Forecast final cost if the current cost performance continues. */
  estimateAtCompletion: number | null;
  varianceAtCompletion: number | null;
}

/** Budget planned by the end of `dataDay`, spreading each activity's budget evenly over its baseline days. */
export function plannedValue(activities: readonly BudgetedActivity[], dataDay: number): number {
  let total = 0;
  for (const activity of activities) {
    const span = activity.baselineFinish - activity.baselineStart;
    if (span <= 0) {
      if (dataDay >= activity.baselineStart) total += activity.budget;
      continue;
    }
    const done = Math.min(Math.max(dataDay - activity.baselineStart, 0), span);
    total += (activity.budget * done) / span;
  }
  return total;
}

export function earnedValue(activities: readonly BudgetedActivity[]): number {
  return activities.reduce((sum, a) => {
    if (a.percentComplete < 0 || a.percentComplete > 100) {
      throw new Error(`Activity "${a.id}" has invalid progress ${a.percentComplete}%`);
    }
    return sum + (a.budget * a.percentComplete) / 100;
  }, 0);
}

export function summarizeEarnedValue(
  activities: readonly BudgetedActivity[],
  dataDay: number,
  actualCost: number,
): EarnedValueSummary {
  const budgetAtCompletion = activities.reduce((sum, a) => sum + a.budget, 0);
  const pv = plannedValue(activities, dataDay);
  const ev = earnedValue(activities);
  const spi = pv > 0 ? ev / pv : null;
  const cpi = actualCost > 0 ? ev / actualCost : null;
  const estimateAtCompletion = cpi && cpi > 0 ? budgetAtCompletion / cpi : null;

  return {
    budgetAtCompletion,
    plannedValue: pv,
    earnedValue: ev,
    actualCost,
    scheduleVariance: ev - pv,
    costVariance: ev - actualCost,
    spi,
    cpi,
    estimateAtCompletion,
    varianceAtCompletion: estimateAtCompletion === null ? null : budgetAtCompletion - estimateAtCompletion,
  };
}
