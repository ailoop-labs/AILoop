# External Validation Plan

## Phase 3: External Validation Path

### Goal
Prove AILoop can work on a second repository without relying on self-iteration familiarity.

### Target Outcome
- A small pilot workflow exists for trying AILoop on another project with bounded risk.
- Success criteria are measurable and comparable to self-iteration results.

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

### Narrow First Scope

1. **Bugfix Task**
   - Small, isolated bug
   - Clear reproduction steps
   - Testable outcome

2. **Small Feature Task**
   - Single-file addition
   - No architecture changes
   - Contained scope

3. **Structural Maintenance Task**
   - Hot-file extraction
   - Module reorganization
   - Test-preserving refactor

### Success Criteria

- Task completes within budget (time, cost, actions)
- Human intervention required < 2 times
- Evaluator confirms success
- No regressions in test suite

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

After Slice 3.1 approval:
- Proceed to Slice 3.2: Implement verification checklist
- Proceed to Slice 3.3: Execute first pilot task
- Iterate on criteria based on pilot results
