# External Validation Plan

## Phase 3: External Validation Path

### Goal
Prove AILoop can work on a second repository without relying on self-iteration familiarity.

### Target Outcome
- A small pilot workflow exists for trying AILoop on another project with bounded risk.
- Success criteria are measurable and comparable to self-iteration results.

---

## Completed Groundwork

The following Phase 3 foundations are already shipped and should not be redefined as the active slice:

- Candidate-repository preflight for pass/fail eligibility checks
- Aggregate external-validation checklist metrics from persisted run artifacts
- Aggregate baseline-vs-pilot checklist comparison
- Manual pre-run verification checklist guidance
- Read-only `First Pilot Scope` boundary in the Web Console
- Per-task pilot telemetry drill-down inside the checklist

---

## Slice 3.1: Pilot Repository Selection Criteria

### Selection Matrix

| Criterion | Required | Weight | Rationale |
|-----------|----------|--------|-----------|
| Language | TypeScript/JavaScript | Mandatory | Tool compatibility, LLM context quality |
| Project Size | < 5,000 LOC | High | Bounded risk, fast feedback cycles |
| Test Coverage | Existing test suite required | Mandatory | Verifiable outcomes, regression detection |
| Operational Risk | Low | Mandatory | No production dependencies, safe to modify |
| Maintenance Status | Active or recently active | Medium | Realistic validation scenario |
| Complexity | Low to Medium | High | Contained blast radius |
| Dependency Count | < 50 direct deps | Medium | Reduced failure surface |

### Specific Requirements

1. **Project Type**
   - Library or small application
   - No database migrations required
   - No external API integrations that could incur costs
   - No sensitive data or secrets

2. **Test Infrastructure**
   - Must have existing test suite (Jest, Vitest, or similar)
   - Tests must be runnable locally without complex setup
   - Test execution time < 60 seconds

3. **Operational Constraints**
   - No production deployments
   - No CI/CD pipelines that could be affected
   - Local-only development workflow preferred
   - Easy to revert changes (git-based preferred)

4. **Governance Alignment**
   - Suitable for testing structural maintenance governance
   - Contains at least one "hot file" candidate (>400 LOC or touched frequently)
   - Has clear, bounded tasks available for pilot

### Recommended Project Sources

1. **Personal/Internal Projects**
   - Small side projects
   - Internal tools
   - Learning experiments

2. **Open Source Candidates**
   - Well-maintained small libraries
   - TypeScript utilities
   - Minimal dependencies

3. **Synthetic Projects**
   - Created specifically for validation
   - Contained scope
   - Known edge cases

### Rejection Criteria (Hard Stops)

- Production systems or critical infrastructure
- Projects with complex setup (Docker, multiple services)
- Closed-source or proprietary code
- Projects without version control
- Repositories requiring authentication for basic operations

---

## Slice 3.2: Verification Checklist

### Pre-Run Verification

- [ ] Project meets all selection criteria
- [ ] Local clone or access confirmed
- [ ] Test suite runs successfully on baseline
- [ ] Known working state documented
- [ ] Rollback plan prepared

### Run Tracking Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Rounds per task | < 5 | Count |
| Human interventions | < 2 | Count |
| Token usage | < 100K/round | API logs |
| Cost | < $5/task | API billing |
| Evaluator failures | 0 | Error count |
| Hot-file growth | 0 | LOC delta |

### Post-Run Verification

- [ ] All tests pass
- [ ] No unintended changes
- [ ] Rollback successful if needed
- [ ] Metrics captured
- [ ] Lessons documented

---

## Slice 3.3: Pilot Scope Definition

### Delivered Scope Boundary

The documented `First Pilot Scope` boundary is already implemented as a read-only Web Console panel. It remains the governing pilot boundary, but it is not the active implementation target anymore.

### Narrow First Scope

The first pilot is intentionally cut to a single bounded task in a single external repository. That task may be only one of the following:

1. **Bounded Bugfix**
   - Small, isolated bug
   - Clear reproduction steps
   - Testable outcome

2. **Small Feature**
   - Single-file addition
   - No architecture changes
   - Contained scope

3. **Structural-Maintenance Task**
   - Hot-file extraction
   - Module reorganization
   - Test-preserving refactor

---

## Slice 3.4: Task-Level Baseline Comparison

### Why This Slice

Round 119 already added per-task pilot telemetry drill-down to the existing checklist, and earlier slices already added the aggregate baseline overlay plus the `First Pilot Scope` and manual checklist surfaces. The remaining narrow gap is that operators still cannot compare a pilot task against its self-iteration baseline inside the same drill-down. This slice closes that gap without reopening repository selection, pilot execution, or broader workflow work.

### Concrete Scope Cut Proposal

#### Behavior to Change
- Extend the current `External Validation Checklist` task drill-down so matched tasks show baseline, pilot, and delta values.
- Match baseline tasks to pilot tasks by `stable_id` only.
- Limit task-level comparison to the five existing checklist metrics:
  - rounds
  - human interventions
  - average cost per round
  - evaluator infrastructure failures
  - hot-file growth
- When a pilot task has no matching baseline task, show an explicit pilot-only state rather than hiding the task or fabricating a comparison.
- Preserve the current aggregate checklist comparison and the current task drill-down structure.

#### Files / Surfaces Affected
- `.ailoop/product-requirements/current.md`
- `docs/plans/external-validation.md`
- `src/types/contracts.ts`
- `src/reporting/metrics.ts`
- `src/reporting/metrics.test.ts`
- `src/server.ts`
- `src/server.test.ts`
- `web/src/App.tsx`
- `web/src/App.test.tsx`

### Acceptance Criteria

- The active Phase 3 requirement no longer names the already-shipped `First Pilot Scope` panel as the next implementation target.
- When a baseline overlay is active, task cards can render matched baseline, pilot, and delta values for the five documented metrics.
- Matching is keyed by `stable_id`; title or objective text is not used as a fallback join key.
- Unmatched pilot tasks remain visible with an explicit pilot-only treatment.
- Aggregate checklist cards and current pilot-only drill-down behavior remain intact when no baseline overlay is active.
- The slice stays within existing reporting, API, and checklist-view surfaces.

### Out of Scope

- Reworking the shipped `First Pilot Scope` panel
- Running or automating a real external-validation pilot
- Repository auto-discovery, cloning, or persistence
- New metrics beyond the five documented checklist metrics
- Aggregate checklist math changes
- CLI task-level baseline comparison output
- Multi-repo comparisons or repository history tracking
- Persistence-schema changes, budget-policy changes, or evaluator-governance changes
- Broad Web Console redesign beyond the existing checklist and task drill-down

---

## Runbook: External Validation Execution

### Step 1: Select Repository
1. Review selection criteria matrix
2. Confirm no hard stops apply
3. Document selection rationale

### Step 2: Prepare Environment
1. Clone or confirm access
2. Run baseline tests
3. Document working state
4. Create backup/checkpoint

### Step 3: Define First Task
1. Choose narrow scope (bugfix, feature, or maintenance)
2. Write success criteria
3. Set budget limits
4. Prepare evaluator prompts

### Step 4: Execute Run
1. Monitor round progress
2. Track metrics in real-time
3. Intervene only if budget at risk
4. Document decisions

### Step 5: Evaluate Results
1. Run full test suite
2. Compare to baseline
3. Capture metrics
4. Review evaluator output

### Step 6: Document & Report
1. Summarize outcomes
2. Note unexpected behaviors
3. Capture lessons learned
4. Update criteria if needed

---

## Risk Mitigation

### Before Run
- Full backup of project state
- Clear rollback procedure
- Defined abort criteria

### During Run
- Budget monitoring at each round
- Early termination triggers defined
- Human check-in points

### After Run
- Complete state comparison
- Test suite verification
- Metrics archival

---

## Next Steps

- Keep Slices 3.1-3.3 as completed groundwork and pilot guardrails.
- Proceed with Slice 3.4: task-level baseline comparison inside the existing checklist drill-down.
- Defer real pilot execution until the task-level comparison slice is complete and reviewable.
