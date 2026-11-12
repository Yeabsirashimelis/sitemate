#!/usr/bin/env bash
# Type-checks and tests every package. Exits non-zero on the first failure,
# so it can gate a commit or a CI step.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm -r typecheck
pnpm -r test
