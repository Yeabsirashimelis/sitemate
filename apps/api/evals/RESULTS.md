# Evaluation results

Run on 2026-11-13 against gemini-3.5-flash-lite (42 of 42 answers came from the backup model because the main one was busy). Median time per answer: 4.8 s. 0 calls got no answer at first and were retried, as the job queue does in production.

Each case is a message written the way a supervisor or supplier actually sends it, with the answer a careful project engineer would take from it. The model's output goes through the same checks as in production before it is scored. Progress counts as right within 10 percentage points; worker counts and quantities have to match.

## Site reports

| | Worker count | Right activities | Percent complete | Materials used | Materials received | Problems flagged | All correct |
|---|---:|---:|---:|---:|---:|---:|---:|
| English (8) | 8/8 | 8/8 | 7/7 | 8/8 | 8/8 | 4/4 | 8/8 |
| English, informal (6) | 6/6 | 6/6 | 6/6 | 6/6 | 6/6 | 1/1 | 6/6 |
| Amharic (8) | 8/8 | 8/8 | 7/7 | 8/8 | 8/8 | 3/3 | 8/8 |
| Amharic and English mixed (3) | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 1/1 | 3/3 |
| Hard cases (5) | 5/5 | 5/5 | 3/3 | 5/5 | 5/5 | 2/2 | 5/5 |
| **Overall** | **100%** | **100%** | **100%** | **100%** | **100%** | **100%** | **100%** |

## Supplier prices

| | Is it a price | Price | Currency | Delivery days | Reference | All correct |
|---|---:|---:|---:|---:|---:|---:|
| Supplier prices (12) | 12/12 | 10/10 | 10/10 | 10/10 | 1/1 | 12/12 |
| **Overall** | **100%** | **100%** | **100%** | **100%** | **100%** | **100%** |

## What it got wrong

None.

Cases are in `evals/cases.ts`. Run again with `pnpm --filter @sitemate/api eval`.
