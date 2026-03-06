#!/usr/bin/env bash
set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
runs_dir="${workspace_root}/.autoloop/runs"

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
  printf 'CAUSAL_VALIDITY_EVIDENCE\n'
  printf 'OBJECTIVE: Collect and persist explicit evidence for missing key dimension causal_validity.\n'
  printf 'TIMESTAMP: %s\n\n' "${timestamp}"
  printf 'CLAIM_1: Engine contains evaluator-failure threshold short-circuit logic.\n'
} | tee -a "${log_path}" "${state_change_path}" >/dev/null

run_evidence_cmd \
  "ENGINE_THRESHOLD_LOGIC" \
  "rg -n 'MAX_CONSECUTIVE_EVALUATOR_FAILURES|buildEvaluatorFailureThresholdMessage|consecutive_evaluator_failures >= MAX_CONSECUTIVE_EVALUATOR_FAILURES|Triggering one evidence-remediation pass' src/loop/engine.ts"

{
  printf 'CLAIM_2: Regression test covers threshold short-circuit behavior.\n'
} | tee -a "${log_path}" "${state_change_path}" >/dev/null

run_evidence_cmd \
  "ENGINE_TEST_COVERAGE" \
  "rg -n 'consecutive evaluator failures guard|consecutive_evaluator_failures: 3|expect\\(planner\\.plan\\)\\.not\\.toHaveBeenCalled\\(\\)|expect\\(executor\\.execute\\)\\.not\\.toHaveBeenCalled\\(\\)|expect\\(evaluator\\.evaluate\\)\\.not\\.toHaveBeenCalled\\(\\)' src/loop/engine.test.ts"

{
  printf 'CLAIM_3: Verified command passes, supporting claimed behavior change outcome.\n'
} | tee -a "${log_path}" "${state_change_path}" >/dev/null

run_evidence_cmd "ENGINE_TEST_EXECUTION" "bun test src/loop/engine.test.ts"

run_evidence_cmd "HEAD_COMMIT_METADATA" "git show --no-patch --pretty=format:'%H %s' HEAD"

{
  printf 'RESULT: PASS\n'
  printf 'EVIDENCE_LOG_PATH: %s\n' "${log_path}"
  printf 'EVIDENCE_STATE_CHANGE_PATH: %s\n' "${state_change_path}"
} | tee -a "${log_path}" "${state_change_path}" >/dev/null

printf '%s\n' "${log_path}"
printf '%s\n' "${state_change_path}"
