import { Database } from "bun:sqlite";
import path from "node:path";
import type { LoopStateData } from "../types/contracts";

export interface DBConfig {
  dbPath: string;
}

export class DatabaseManager {
  private db: Database;

  constructor(config: DBConfig) {
    this.db = new Database(config.dbPath, { create: true });
    this.initializeSchema();
  }

  private initializeSchema() {
    // Current Singleton State of the Loop
    this.db.run(`
      CREATE TABLE IF NOT EXISTS system_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        state TEXT NOT NULL,
        round INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        pid INTEGER,
        last_error TEXT,
        consecutive_evaluator_failures INTEGER NOT NULL DEFAULT 0,
        previous_tool_result_json TEXT,
        previous_evaluation_dimensions_json TEXT,
        current_budget_json TEXT
      )
    `);

    // Historical Rounds & Metrics
    this.db.run(`
      CREATE TABLE IF NOT EXISTS rounds (
        round_id INTEGER PRIMARY KEY,
        run_timestamp TEXT,
        state TEXT,
        last_error TEXT,
        consecutive_evaluator_failures INTEGER DEFAULT 0,
        usd_used REAL DEFAULT 0,
        actions_used INTEGER DEFAULT 0,
        elapsed_ms INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Evaluations with Root Cause Analysis
    this.db.run(`
      CREATE TABLE IF NOT EXISTS evaluations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id INTEGER,
        decision TEXT,
        justification TEXT,
        root_cause TEXT,
        dimensions_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(round_id) REFERENCES rounds(round_id)
      )
    `);

    // Leader Strategic Decisions
    this.db.run(`
      CREATE TABLE IF NOT EXISTS leader_strategies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id INTEGER,
        rationale TEXT,
        action TEXT,
        instructions_json TEXT,
        diagnosis_type TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(round_id) REFERENCES rounds(round_id)
      )
    `);

    // CCB Sessions for Constitutional Changes
    this.db.run(`
      CREATE TABLE IF NOT EXISTS ccb_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id INTEGER,
        proposed_change TEXT,
        final_decision TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(round_id) REFERENCES rounds(round_id)
      )
    `);

    // Expert Opinions within a CCB Session
    this.db.run(`
      CREATE TABLE IF NOT EXISTS expert_opinions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER,
        expert_role TEXT,
        vote TEXT,
        rationale TEXT,
        incapacity_flag INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(session_id) REFERENCES ccb_sessions(id)
      )
    `);
  }

  async getLoopState(): Promise<Partial<LoopStateData> | null> {
    const row = this.db.query("SELECT * FROM system_state WHERE id = 1").get() as any;
    if (!row) return null;

    return {
      state: row.state,
      round: row.round,
      updated_at: row.updated_at,
      pid: row.pid,
      last_error: row.last_error,
      consecutive_evaluator_failures: row.consecutive_evaluator_failures,
      previous_tool_result: row.previous_tool_result_json ? JSON.parse(row.previous_tool_result_json) : null,
      previous_evaluation_dimensions: row.previous_evaluation_dimensions_json ? JSON.parse(row.previous_evaluation_dimensions_json) : undefined,
      current_budget: row.current_budget_json ? JSON.parse(row.current_budget_json) : null
    };
  }

  async setLoopState(state: LoopStateData) {
    const query = this.db.prepare(`
      INSERT INTO system_state (
        id, state, round, updated_at, pid, last_error, 
        consecutive_evaluator_failures, previous_tool_result_json, 
        previous_evaluation_dimensions_json, current_budget_json
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state = excluded.state,
        round = excluded.round,
        updated_at = excluded.updated_at,
        pid = excluded.pid,
        last_error = excluded.last_error,
        consecutive_evaluator_failures = excluded.consecutive_evaluator_failures,
        previous_tool_result_json = excluded.previous_tool_result_json,
        previous_evaluation_dimensions_json = excluded.previous_evaluation_dimensions_json,
        current_budget_json = excluded.current_budget_json
    `);

    query.run(
      state.state,
      state.round,
      state.updated_at,
      state.pid,
      state.last_error,
      state.consecutive_evaluator_failures,
      state.previous_tool_result ? JSON.stringify(state.previous_tool_result) : null,
      state.previous_evaluation_dimensions ? JSON.stringify(state.previous_evaluation_dimensions) : null,
      state.current_budget ? JSON.stringify(state.current_budget) : null
    );

    // Also sync to rounds history for metrics
    const upsertRound = this.db.prepare(`
      INSERT INTO rounds (round_id, run_timestamp, state, last_error, consecutive_evaluator_failures, usd_used, actions_used, elapsed_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(round_id) DO UPDATE SET
        state = excluded.state,
        last_error = excluded.last_error,
        consecutive_evaluator_failures = excluded.consecutive_evaluator_failures,
        usd_used = excluded.usd_used,
        actions_used = excluded.actions_used,
        elapsed_ms = excluded.elapsed_ms
    `);

    upsertRound.run(
      state.round,
      state.previous_tool_result?.artifacts.log_path ? path.basename(state.previous_tool_result.artifacts.log_path).split('.')[0] : null,
      state.state,
      state.last_error,
      state.consecutive_evaluator_failures,
      state.current_budget?.usage.usdUsed ?? 0,
      state.current_budget?.usage.actionsUsed ?? 0,
      state.current_budget?.usage.elapsedMs ?? 0
    );
  }

  async saveEvaluation(roundId: number, evaluation: any) {
    const query = this.db.prepare(`
      INSERT INTO evaluations (round_id, decision, justification, root_cause, dimensions_json)
      VALUES (?, ?, ?, ?, ?)
    `);

    query.run(
      roundId,
      evaluation.decision,
      evaluation.justification,
      evaluation.root_cause || null,
      evaluation.dimensions ? JSON.stringify(evaluation.dimensions) : null
    );
  }

  async saveLeaderStrategy(roundId: number, strategy: any) {
    const query = this.db.prepare(`
      INSERT INTO leader_strategies (round_id, rationale, action, instructions_json, diagnosis_type)
      VALUES (?, ?, ?, ?, ?)
    `);

    query.run(
      roundId,
      strategy.rationale,
      strategy.action,
      strategy.instructions ? JSON.stringify(strategy.instructions) : null,
      strategy.diagnosis_type
    );
  }

  async saveCCBSession(roundId: number, session: any) {
    const sessionQuery = this.db.prepare(`
      INSERT INTO ccb_sessions (round_id, proposed_change, final_decision)
      VALUES (?, ?, ?)
    `);

    const result = sessionQuery.run(
      roundId,
      session.proposed_change,
      session.final_decision
    );

    const sessionId = result.lastInsertRowid;

    const expertQuery = this.db.prepare(`
      INSERT INTO expert_opinions (session_id, expert_role, vote, rationale, incapacity_flag)
      VALUES (?, ?, ?, ?, ?)
    `);

    for (const opinion of session.experts) {
      expertQuery.run(
        sessionId,
        opinion.expert_role,
        opinion.vote,
        opinion.rationale,
        opinion.incapacity_flag ? 1 : 0
      );
    }
  }

  async getFrictionIndex() {
    // 1. Rework Churn Rate: Percentage of rounds with consecutive failures > 0 in the last 20 rounds
    const reworkChurn = this.db.query(`
      SELECT 
        CAST(SUM(CASE WHEN consecutive_evaluator_failures > 0 THEN 1 ELSE 0 END) AS FLOAT) / COUNT(*) as rate
      FROM (SELECT consecutive_evaluator_failures FROM rounds ORDER BY round_id DESC LIMIT 20)
    `).get() as any;

    // 2. Action Bloat: Average actions per round in the last 10 rounds vs previous 10 rounds
    const actionBloat = this.db.query(`
      SELECT 
        AVG(actions_used) as avg_actions
      FROM (SELECT actions_used FROM rounds ORDER BY round_id DESC LIMIT 10)
    `).get() as any;

    // 3. Leader Interventions: Count of leader strategies in the last 20 rounds
    const leaderInterventions = this.db.query(`
      SELECT COUNT(*) as count 
      FROM leader_strategies 
      WHERE round_id > (SELECT MAX(round_id) - 20 FROM rounds)
    `).get() as any;

    // 4. Over-engineering triggers: Count of evaluations with root_cause = 'over_engineering'
    const overEngineeringCount = this.db.query(`
      SELECT COUNT(*) as count 
      FROM evaluations 
      WHERE root_cause = 'over_engineering'
    `).get() as any;

    return {
      reworkChurnRate: reworkChurn?.rate || 0,
      averageActions: actionBloat?.avg_actions || 0,
      leaderInterventionCount: leaderInterventions?.count || 0,
      overEngineeringCount: overEngineeringCount?.count || 0,
      healthStatus: (reworkChurn?.rate > 0.4 || actionBloat?.avg_actions > 50) ? 'at_risk' : 'healthy'
    };
  }

  async getLatestRounds(limit: number = 20) {
    return this.db.query(`
      SELECT r.*, e.decision, e.justification, e.root_cause
      FROM rounds r
      LEFT JOIN (
        -- Get the latest evaluation per round
        SELECT * FROM evaluations WHERE id IN (SELECT MAX(id) FROM evaluations GROUP BY round_id)
      ) e ON r.round_id = e.round_id
      ORDER BY r.round_id DESC
      LIMIT ?
    `).all(limit);
  }

  async getGovernanceDetails(roundId: number) {
    const leaderStrategy = this.db.query(`
      SELECT * FROM leader_strategies WHERE round_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(roundId) as any;

    const ccbSession = this.db.query(`
      SELECT * FROM ccb_sessions WHERE round_id = ? ORDER BY created_at DESC LIMIT 1
    `).get(roundId) as any;

    let experts = [];
    if (ccbSession) {
      experts = this.db.query(`
        SELECT * FROM expert_opinions WHERE session_id = ?
      `).all(ccbSession.id) as any[];
    }

    return {
      leader: leaderStrategy ? {
        rationale: leaderStrategy.rationale,
        action: leaderStrategy.action,
        diagnosis_type: leaderStrategy.diagnosis_type,
        instructions: leaderStrategy.instructions_json ? JSON.parse(leaderStrategy.instructions_json) : []
      } : null,
      ccb: ccbSession ? {
        proposed_change: ccbSession.proposed_change,
        final_decision: ccbSession.final_decision,
        experts: experts.map(e => ({
          expert_role: e.expert_role,
          vote: e.vote,
          rationale: e.rationale,
          incapacity_flag: Boolean(e.incapacity_flag)
        }))
      } : null
    };
  }

  close() {
    this.db.close();
  }
}
