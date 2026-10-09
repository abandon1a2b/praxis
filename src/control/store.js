import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { businessSchema } from "./config.js";
import { TrajectoryIndex } from "./trajectory-index.js";
import { InspectionStore } from "./inspections.js";

export class Conflict extends Error {}

export class Store {
  constructor(file) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS businesses (id TEXT PRIMARY KEY, version INTEGER NOT NULL, next_at TEXT);
      CREATE TABLE IF NOT EXISTS versions (business_id TEXT NOT NULL REFERENCES businesses(id), version INTEGER NOT NULL, config TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(business_id, version));
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, business_id TEXT NOT NULL REFERENCES businesses(id), version INTEGER NOT NULL, trigger TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT, config TEXT NOT NULL, report TEXT, error TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(business_id) WHERE status = 'running';
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, input TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, finished_at TEXT, result TEXT, error TEXT, parent_id TEXT);
      CREATE TABLE IF NOT EXISTS task_events (task_id TEXT NOT NULL REFERENCES tasks(id), seq INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT NOT NULL);
    `);
    if (
      !this.db
        .prepare("PRAGMA table_info(tasks)")
        .all()
        .some((column) => column.name === "session_id")
    )
      this.db.exec("ALTER TABLE tasks ADD COLUMN session_id TEXT");
    this.db.exec(
      `WITH RECURSIVE ancestry(id,session_id) AS (SELECT id,id FROM tasks WHERE parent_id IS NULL OR parent_id NOT IN (SELECT id FROM tasks) UNION ALL SELECT t.id,a.session_id FROM tasks t JOIN ancestry a ON t.parent_id=a.id) UPDATE tasks SET session_id=COALESCE((SELECT session_id FROM ancestry WHERE ancestry.id=tasks.id),id) WHERE session_id IS NULL`,
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS tasks_by_session ON tasks(session_id,created_at)",
    );
    this.trajectoryIndex = new TrajectoryIndex(this.db);
    this.inspections = new InspectionStore(this.db);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS task_events_by_task ON task_events(task_id,seq)",
    );
  }
  listBusinesses() {
    return this.db
      .prepare(
        "SELECT b.*, v.config FROM businesses b JOIN versions v ON v.business_id=b.id AND v.version=b.version ORDER BY b.id",
      )
      .all()
      .map((row) => ({
        ...JSON.parse(row.config),
        version: row.version,
        nextAt: row.next_at,
      }));
  }
  getBusiness(id) {
    return this.listBusinesses().find((b) => b.id === id);
  }
  saveBusiness(value, expectedVersion) {
    const config = businessSchema.parse(value);
    return this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM businesses WHERE id=?")
        .get(config.id);
      if ((existing?.version ?? 0) !== expectedVersion)
        throw new Conflict("Configuration changed; reload before saving");
      const version = expectedVersion + 1;
      const now = new Date().toISOString();
      const next = config.enabled
        ? new Date(Date.now() + config.intervalSeconds * 1000).toISOString()
        : null;
      if (!existing)
        this.db
          .prepare("INSERT INTO businesses VALUES (?, ?, ?)")
          .run(config.id, version, next);
      else
        this.db
          .prepare("UPDATE businesses SET version=?, next_at=? WHERE id=?")
          .run(version, next, config.id);
      this.db
        .prepare("INSERT INTO versions VALUES (?, ?, ?, ?)")
        .run(config.id, version, JSON.stringify(config), now);
      return this.getBusiness(config.id);
    })();
  }
  createRun(id, trigger) {
    return this.db.transaction(() => {
      const business = this.getBusiness(id);
      if (!business) throw new Error("Business not found");
      if (
        this.db
          .prepare(
            "SELECT id FROM runs WHERE business_id=? AND status='running'",
          )
          .get(id)
      )
        throw new Conflict("This business already has an active run");
      const { version, nextAt, ...config } = business;
      const runId = randomUUID(),
        now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO runs (id,business_id,version,trigger,status,created_at,config) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          runId,
          id,
          version,
          trigger,
          "running",
          now,
          JSON.stringify(config),
        );
      this.db
        .prepare("UPDATE businesses SET next_at=? WHERE id=?")
        .run(
          config.enabled
            ? new Date(Date.now() + config.intervalSeconds * 1000).toISOString()
            : null,
          id,
        );
      return this.getRun(runId);
    })();
  }
  getRun(id) {
    const row = this.db.prepare("SELECT * FROM runs WHERE id=?").get(id);
    return row ? this.decodeRun(row) : undefined;
  }
  decodeRun(row) {
    return {
      id: row.id,
      businessId: row.business_id,
      version: row.version,
      trigger: row.trigger,
      status: row.status,
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      config: JSON.parse(row.config),
      report: row.report ? JSON.parse(row.report) : null,
      error: row.error,
    };
  }
  listRuns(businessId) {
    return this.db
      .prepare(
        "SELECT * FROM runs WHERE business_id=? ORDER BY created_at DESC LIMIT 100",
      )
      .all(businessId)
      .map((row) => {
        const run = this.decodeRun(row);
        return {
          ...run,
          config: undefined,
          report: run.report
            ? {
                completedBatches: run.report.completed.length,
                totalBatches: run.report.totalBatches,
                findingCount: run.report.findings.length,
              }
            : null,
        };
      });
  }
  progress(id, report) {
    this.db
      .prepare("UPDATE runs SET report=? WHERE id=? AND status='running'")
      .run(JSON.stringify(report), id);
  }
  finish(id, status, report, error = null) {
    this.db
      .prepare(
        "UPDATE runs SET status=?,report=COALESCE(?,report),error=?,finished_at=? WHERE id=? AND status='running'",
      )
      .run(
        status,
        report ? JSON.stringify(report) : null,
        error,
        new Date().toISOString(),
        id,
      );
  }
  recover() {
    this.db
      .prepare(
        "UPDATE tasks SET status='interrupted',error='Control service restarted',finished_at=? WHERE status='running'",
      )
      .run(new Date().toISOString());
    this.db
      .prepare(
        "UPDATE runs SET status='interrupted',error='Control service restarted during execution',finished_at=? WHERE status='running'",
      )
      .run(new Date().toISOString());
  }
  close() {
    this.db.close();
  }
  createTask(input, parentId) {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO tasks (id,input,status,created_at,parent_id,session_id) VALUES (?,?,?,?,?,?)",
      )
      .run(
        id,
        JSON.stringify(input),
        "running",
        new Date().toISOString(),
        parentId ?? null,
        parentId ? (this.getTask(parentId)?.sessionId ?? id) : id,
      );
    return this.getTask(id);
  }
  getTask(id) {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    if (!r) return;
    return {
      id: r.id,
      input: JSON.parse(r.input),
      status: r.status,
      createdAt: r.created_at,
      finishedAt: r.finished_at,
      result: r.result ? JSON.parse(r.result) : null,
      error: r.error,
      parentId: r.parent_id,
      sessionId: r.session_id,
    };
  }
  listTasks() {
    return this.db
      .prepare("SELECT id FROM tasks ORDER BY created_at DESC LIMIT 100")
      .all()
      .map((r) => this.getTask(r.id));
  }
  sessionTasks(id) {
    return this.db
      .prepare(
        "SELECT id FROM tasks WHERE session_id=? ORDER BY created_at,rowid",
      )
      .all(id)
      .map((row) => this.getTask(row.id));
  }
  listSessions() {
    return this.db
      .prepare(
        "SELECT session_id FROM tasks GROUP BY session_id ORDER BY MAX(created_at) DESC LIMIT 100",
      )
      .all()
      .map((row) => {
        const turns = this.sessionTasks(row.session_id),
          first = turns[0],
          last = turns.at(-1);
        return {
          id: row.session_id,
          title: first.input.prompt,
          cwd: first.input.cwd,
          createdAt: first.createdAt,
          updatedAt: last.createdAt,
          status: last.status,
          turnCount: turns.length,
          latestTaskId: last.id,
        };
      });
  }
  userTaskEvents(id) {
    return this.db
      .prepare(
        "SELECT seq,event FROM task_events WHERE task_id=? AND json_extract(event,'$.type')='user_message' ORDER BY seq",
      )
      .all(id)
      .map((r) => ({ seq: r.seq, ...JSON.parse(r.event) }));
  }
  taskEvent(id, event) {
    event = { ...event, time: event.time ?? new Date().toISOString() };
    this.db
      .prepare("INSERT INTO task_events (task_id,event) VALUES (?,?)")
      .run(id, JSON.stringify(event));
    if (event.type === "session_ready")
      this.db
        .prepare("UPDATE tasks SET result=? WHERE id=?")
        .run(JSON.stringify(event), id);
  }
  taskEvents(id) {
    return this.db
      .prepare(
        "SELECT seq,event FROM task_events WHERE task_id=? ORDER BY seq DESC LIMIT 200",
      )
      .all(id)
      .reverse()
      .map((r) => ({ seq: r.seq, ...JSON.parse(r.event) }));
  }
  taskContextEvents(id) {
    return this.db
      .prepare(
        "SELECT seq,event FROM task_events WHERE task_id=? AND json_extract(event,'$.type') IN ('user_message','memory_context') ORDER BY seq",
      )
      .all(id)
      .map((row) => ({ seq: row.seq, ...JSON.parse(row.event) }));
  }
  finishTask(id, status, result, error = null) {
    this.db
      .prepare(
        "UPDATE tasks SET status=?,result=COALESCE(?,result),error=?,finished_at=? WHERE id=?",
      )
      .run(
        status,
        result ? JSON.stringify(result) : null,
        error,
        new Date().toISOString(),
        id,
      );
  }
}
