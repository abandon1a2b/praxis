import { z } from "zod";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Conflict } from "./store.js";

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const inspectionSchema = z
  .object({
    id: identifier,
    name: z.string().trim().min(1).max(120),
    scope: identifier,
    kind: z.enum(["http", "git"]),
    target: z
      .string()
      .min(1)
      .max(2000)
      .describe(
        "HTTP 检查为 http(s) URL，不含用户名密码；Git 检查为本机仓库绝对路径。",
      ),
    expectedStatus: z.number().int().min(100).max(599).default(200),
    enabled: z.boolean().default(false),
    intervalSeconds: z.number().int().min(60).max(2147483).default(3600),
    timeoutSeconds: z.number().int().min(1).max(60).default(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === "git" && !path.isAbsolute(value.target))
      ctx.addIssue({
        code: "custom",
        path: ["target"],
        message: "Git target must be an absolute repository path",
      });
    if (value.kind === "http") {
      try {
        const url = new URL(value.target);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        )
          throw Error();
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["target"],
          message:
            "HTTP target must be an http(s) URL without embedded credentials",
        });
      }
    }
  })
  .describe(
    "只读巡检：HTTP GET 状态是否符合 expectedStatus，或 Git 工作区是否干净；不执行任意命令或自动修复。",
  );

export class InspectionStore {
  constructor(db) {
    this.db = db;
    db.exec(`
    CREATE TABLE IF NOT EXISTS inspection_checks (id TEXT PRIMARY KEY,version INTEGER NOT NULL,config TEXT NOT NULL,next_at TEXT);
    CREATE TABLE IF NOT EXISTS inspection_versions (check_id TEXT NOT NULL REFERENCES inspection_checks(id),version INTEGER NOT NULL,config TEXT NOT NULL,recorded_at TEXT,PRIMARY KEY(check_id,version));
    CREATE TABLE IF NOT EXISTS observations (id TEXT PRIMARY KEY,check_id TEXT NOT NULL,check_version INTEGER NOT NULL,scope TEXT NOT NULL,observed_at TEXT NOT NULL,status TEXT NOT NULL,change TEXT NOT NULL,summary TEXT NOT NULL,evidence TEXT NOT NULL,config TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS observations_scope_time ON observations(scope,observed_at);
    CREATE INDEX IF NOT EXISTS observations_check_time ON observations(check_id,check_version,observed_at);
    CREATE TABLE IF NOT EXISTS inspection_incidents (id TEXT PRIMARY KEY,check_id TEXT NOT NULL,check_version INTEGER NOT NULL,scope TEXT NOT NULL,status TEXT NOT NULL,first_seen TEXT NOT NULL,last_seen TEXT NOT NULL,occurrences INTEGER NOT NULL,resolved_at TEXT,observation_id TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_incident ON inspection_incidents(check_id,check_version) WHERE status='active';
    CREATE VIRTUAL TABLE IF NOT EXISTS observation_search USING fts5(summary,evidence,content='observations',content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS observation_insert AFTER INSERT ON observations BEGIN INSERT INTO observation_search(rowid,summary,evidence) VALUES (new.rowid,new.summary,new.evidence); END;
  `);
    db.exec(
      "INSERT OR IGNORE INTO inspection_versions SELECT id,version,config,NULL FROM inspection_checks",
    );
  }
  list() {
    return this.db
      .prepare("SELECT * FROM inspection_checks ORDER BY id")
      .all()
      .map((r) => ({
        ...JSON.parse(r.config),
        version: r.version,
        nextAt: r.next_at,
      }));
  }
  get(id) {
    return this.list().find((c) => c.id === id);
  }
  save(value, expectedVersion) {
    const config = inspectionSchema.parse(value);
    return this.db.transaction(() => {
      const previous = this.get(config.id);
      if ((previous?.version ?? 0) !== expectedVersion)
        throw new Conflict(
          "Inspection configuration changed; reload before saving",
        );
      const version = expectedVersion + 1,
        next = config.enabled
          ? new Date(Date.now() + config.intervalSeconds * 1000).toISOString()
          : null;
      this.db
        .prepare(
          "INSERT INTO inspection_checks VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,config=excluded.config,next_at=excluded.next_at",
        )
        .run(config.id, version, JSON.stringify(config), next);
      this.db
        .prepare("INSERT INTO inspection_versions VALUES (?,?,?,?)")
        .run(
          config.id,
          version,
          JSON.stringify(config),
          new Date().toISOString(),
        );
      if (previous)
        this.db
          .prepare(
            "UPDATE inspection_incidents SET status='superseded' WHERE check_id=? AND status='active'",
          )
          .run(config.id);
      return this.get(config.id);
    })();
  }
  due() {
    return this.list()
      .filter(
        (c) => c.enabled && c.nextAt && Date.parse(c.nextAt) <= Date.now(),
      )
      .sort((a, b) => a.nextAt.localeCompare(b.nextAt));
  }
  schedule(check) {
    this.db
      .prepare(
        "UPDATE inspection_checks SET next_at=? WHERE id=? AND version=?",
      )
      .run(
        check.enabled
          ? new Date(Date.now() + check.intervalSeconds * 1000).toISOString()
          : null,
        check.id,
        check.version,
      );
  }
  record(check, result) {
    return this.db.transaction(() => {
      const id = randomUUID(),
        at = new Date().toISOString();
      const current = this.get(check.id);
      const incident = this.db
        .prepare(
          "SELECT * FROM inspection_incidents WHERE check_id=? AND check_version=? AND status='active'",
        )
        .get(check.id, check.version);
      const change =
        result.status === "failed"
          ? "check_failed"
          : result.status === "abnormal"
            ? incident
              ? "ongoing_anomaly"
              : "new_anomaly"
            : incident
              ? "recovered"
              : "unchanged";
      if (result.status === "abnormal") {
        if (incident)
          this.db
            .prepare(
              "UPDATE inspection_incidents SET last_seen=?,occurrences=occurrences+1,observation_id=? WHERE id=?",
            )
            .run(at, id, incident.id);
        else
          this.db
            .prepare(
              "INSERT INTO inspection_incidents VALUES (?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              randomUUID(),
              check.id,
              check.version,
              check.scope,
              current?.version === check.version ? "active" : "superseded",
              at,
              at,
              1,
              null,
              id,
            );
      } else if (result.status === "normal" && incident)
        this.db
          .prepare(
            "UPDATE inspection_incidents SET status='resolved',resolved_at=?,observation_id=? WHERE id=?",
          )
          .run(at, id, incident.id);
      const { version, nextAt, ...config } = check;
      this.db
        .prepare("INSERT INTO observations VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(
          id,
          check.id,
          check.version,
          check.scope,
          at,
          result.status,
          change,
          result.summary,
          JSON.stringify(result.evidence),
          JSON.stringify(config),
        );
      return this.observation(id);
    })();
  }
  decode(row) {
    return {
      ...row,
      checkId: row.check_id,
      checkVersion: row.check_version,
      observedAt: row.observed_at,
      evidence: JSON.parse(row.evidence),
      config: JSON.parse(row.config),
    };
  }
  observation(id) {
    const row = this.db
      .prepare("SELECT * FROM observations WHERE id=?")
      .get(id);
    return row ? this.decode(row) : undefined;
  }
  search({ scope, q = "", limit = 50 } = {}) {
    const clauses = [],
      params = [];
    if (scope) {
      clauses.push("o.scope=?");
      params.push(scope);
    }
    let join = "";
    if (q.trim()) {
      const words = q.match(/[\p{L}\p{N}_]+/gu) ?? [];
      if (!words.length) return [];
      if (words.some((word) => /\p{Script=Han}/u.test(word))) {
        for (const word of words) {
          clauses.push(
            "(o.summary LIKE ? ESCAPE '\\' OR o.evidence LIKE ? ESCAPE '\\')",
          );
          const pattern = `%${word.replace(/[\\%_]/g, "\\$&")}%`;
          params.push(pattern, pattern);
        }
      } else {
        join = " JOIN observation_search ON observation_search.rowid=o.rowid";
        clauses.push("observation_search MATCH ?");
        params.push(
          words.map((word) => `"${word.replaceAll('"', '""')}"`).join(" AND "),
        );
      }
    }
    return this.db
      .prepare(
        `SELECT o.* FROM observations o${join}${clauses.length ? " WHERE " + clauses.join(" AND ") : ""} ORDER BY o.observed_at DESC,o.rowid DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map((r) => {
        const observation = this.decode(r);
        let truncated = false;
        const evidence = Object.fromEntries(
          Object.entries(observation.evidence).map(([key, value]) => {
            if (typeof value === "string" && value.length > 4096) {
              truncated = true;
              return [key, value.slice(0, 4096) + "\n[证据预览已截断]"];
            }
            return [key, value];
          }),
        );
        return {
          ...observation,
          evidence,
          evidencePreviewTruncated: truncated,
        };
      });
  }
  incidents(scope) {
    return this.db
      .prepare(
        `SELECT * FROM inspection_incidents ${scope ? "WHERE scope=?" : ""} ORDER BY last_seen DESC LIMIT 100`,
      )
      .all(...(scope ? [scope] : []));
  }
}

export async function measure(check, signal) {
  const started = Date.now();
  try {
    if (check.kind === "http") {
      const response = await fetch(check.target, {
        method: "GET",
        signal,
        redirect: "manual",
      });
      let body = "",
        bytes = 0,
        truncated = false;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          const chunks = [];
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            const keep = part.value.subarray(0, Math.max(0, 8193 - bytes));
            chunks.push(keep);
            bytes += keep.length;
            if (bytes > 8192) {
              truncated = true;
              break;
            }
          }
          body = Buffer.concat(chunks).subarray(0, 8192).toString("utf8");
        } finally {
          await reader.cancel();
        }
      }
      const status =
        response.status === check.expectedStatus ? "normal" : "abnormal";
      return {
        status,
        summary: `HTTP ${status === "normal" ? "正常" : "异常"}: ${check.name} 返回 ${response.status}，期望 ${check.expectedStatus}`,
        evidence: {
          kind: "http",
          url: check.target,
          status: response.status,
          expectedStatus: check.expectedStatus,
          body,
          truncated,
          durationMs: Date.now() - started,
        },
      };
    }
    const execute = promisify(execFile),
      args = [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-C",
        check.target,
      ];
    const [head, state] = await Promise.all([
      execute("git", [...args, "rev-parse", "HEAD"], {
        signal,
        maxBuffer: 1024 * 1024,
      }),
      execute("git", [...args, "status", "--porcelain"], {
        signal,
        maxBuffer: 1024 * 1024,
      }),
    ]);
    const status = state.stdout.trim() ? "abnormal" : "normal";
    return {
      status,
      summary: `Git ${status === "normal" ? "正常" : "异常"}: ${check.name} 工作区${status === "normal" ? "干净" : "存在未提交改动"}`,
      evidence: {
        kind: "git",
        path: check.target,
        head: head.stdout.trim(),
        workingTree: state.stdout,
        durationMs: Date.now() - started,
      },
    };
  } catch (error) {
    return {
      status: "failed",
      summary: `巡检失败: ${check.name}`,
      evidence: {
        kind: check.kind,
        target: check.target,
        error: error.message,
        durationMs: Date.now() - started,
      },
    };
  }
}
export class InspectionRunner {
  constructor(store, busy = () => false, observe = measure) {
    this.store = store;
    this.busy = busy;
    this.observe = observe;
    this.active = new Map();
  }
  run(id) {
    if (this.active.size || this.busy())
      throw new Conflict("Another execution is active");
    const check = this.store.get(id);
    if (!check) throw new Error("Inspection not found");
    this.store.schedule(check);
    const abort = new AbortController(),
      timer = setTimeout(() => abort.abort(), check.timeoutSeconds * 1000);
    const work = Promise.resolve()
      .then(async () => {
        let result;
        try {
          result = await this.observe(check, abort.signal);
        } catch (error) {
          result = {
            status: "failed",
            summary: `巡检失败: ${check.name}`,
            evidence: { error: error.message, target: check.target },
          };
        }
        if (abort.signal.aborted)
          result = {
            status: "failed",
            summary: `巡检失败: ${check.name}`,
            evidence: {
              error: "Inspection timed out or was cancelled",
              target: check.target,
            },
          };
        return this.store.record(check, result);
      })
      .finally(() => {
        clearTimeout(timer);
        this.active.delete(id);
      });
    this.active.set(id, { abort, work });
    return work;
  }
  tick() {
    if (this.active.size || this.busy()) return;
    const due = this.store.due()[0];
    if (due) this.run(due.id).catch((error) => console.error(error.message));
  }
  async close() {
    for (const entry of this.active.values()) entry.abort.abort();
    await Promise.allSettled(
      [...this.active.values()].map((entry) => entry.work),
    );
  }
}
