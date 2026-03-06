#!/usr/bin/env bash
set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runs_dir="${workspace_root}/.ailoop/runs"

if [[ $# -ge 1 && -n "${1}" ]]; then
  timestamp="$1"
else
  timestamp="$(date -u +"%Y-%m-%dT%H-%M-%S-%3NZ")"
fi

log_path="${runs_dir}/${timestamp}.round.log"
state_change_path="${runs_dir}/${timestamp}.round.state_change.txt"

mkdir -p "${runs_dir}"
: > "${log_path}"
: > "${state_change_path}"

run_evidence_cmd() {
  local title="$1"
  local command="$2"

  {
    printf '=== %s ===\n' "$title"
    printf 'COMMAND: %s\n' "$command"
  } | tee -a "${log_path}" "${state_change_path}" >/dev/null

  set +e
  local output
  output="$(cd "${workspace_root}" && bash -lc "$command" 2>&1)"
  local exit_code=$?
  set -e

  {
    printf 'EXIT_CODE: %s\n' "${exit_code}"
    printf '%s\n\n' "$output"
  } | tee -a "${log_path}" "${state_change_path}" >/dev/null

  if [[ ${exit_code} -ne 0 ]]; then
    printf 'Evidence collection failed for "%s" (exit %s)\n' "$title" "${exit_code}" >&2
    return "${exit_code}"
  fi
}

{
  printf 'KEY_DIMENSION_EVIDENCE\n'
  printf 'OBJECTIVE: Collect and persist explicit evidence for missing key dimensions goal_alignment and causal_validity.\n'
  printf 'TIMESTAMP: %s\n\n' "${timestamp}"
  printf 'DIMENSION: goal_alignment\n'
  printf 'CLAIM_1: Required objective behavior exists in the project path equivalent files.\n'
} | tee -a "${log_path}" "${state_change_path}" >/dev/null

run_evidence_cmd \
  "PATH_EQUIVALENCE_CHECK" \
  "for file in src/engine/round_runner.ts src/engine/round_runner.test.ts src/loop/engine.ts src/loop/engine.budget.test.ts; do if [[ -f \"\$file\" ]]; then printf 'exists %s\n' \"\$file\"; else printf 'missing %s\n' \"\$file\"; fi; done"

{
  printf 'CLAIM_2: Time-budget guard and pause semantics are present in the equivalent implementation and test.\n'
} | tee -a "${log_path}" "${state_change_path}" >/dev/null

run_evidence_cmd \
  "TIME_BUDGET_GUARD_SOURCE_LINES" \
  "rg -n 'enforceBudgetBeforeAction|elapsedMs >= timeLimitMs|BudgetBreach|next_state_hint|time budget' src/loop/engine.ts src/loop/engine.budget.test.ts"

{
  printf '\nDIMENSION: causal_validity\n'
  printf 'CLAIM_3: Causal chain is evidenced by source assertions, executable verification, and commit history.\n'
} | tee -a "${log_path}" "${state_change_path}" >/dev/null

run_evidence_cmd \
  "CAUSAL_ASSERTION_LINES" \
  "rg -n 'records BudgetBreach failure with pause next_state_hint on pre-action time guard|previous_tool_result\\.error\\.type|previous_tool_result\\.next_state_hint' src/loop/engine.budget.test.ts"

{
  printf 'CLAIM_4: Focused test run validates behavior from current source state.\n'
} | tee -a "${log_path}" "${state_change_path}" >/dev/null

run_evidence_cmd "FOCUSED_TEST_EXECUTION" "bun test src/loop/engine.budget.test.ts"

run_evidence_cmd "RELEVANT_COMMIT_HISTORY" "git log --oneline --max-count=10 -- src/loop/engine.ts src/loop/engine.budget.test.ts"
run_evidence_cmd "HEAD_COMMIT_METADATA" "git show --no-patch --pretty=format:'%H %s' HEAD"

{
  printf 'RESULT: PASS\n'
  printf 'EVIDENCE_LOG_PATH: %s\n' "${log_path}"
  printf 'EVIDENCE_STATE_CHANGE_PATH: %s\n' "${state_change_path}"
} | tee -a "${log_path}" "${state_change_path}" >/dev/null

printf '%s\n' "${log_path}"
printf '%s\n' "${state_change_path}"
