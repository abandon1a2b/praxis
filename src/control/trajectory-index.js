import { open, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { traceEvent } from "./trajectory.js";

const FORMAT = 2;
export class TrajectoryIndex {
  constructor(db) {
    this.db = db;
    this.pending = new Map();
    db.exec(`CREATE TABLE IF NOT EXISTS trace_sources (file TEXT PRIMARY KEY,identity TEXT NOT NULL,offset INTEGER NOT NULL,mtime REAL NOT NULL,anchor TEXT NOT NULL,line INTEGER NOT NULL,turn INTEGER NOT NULL,step INTEGER NOT NULL,format INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS trace_records (file TEXT NOT NULL REFERENCES trace_sources(file) ON DELETE CASCADE,ordinal INTEGER NOT NULL,kind TEXT NOT NULL,call_id TEXT,payload TEXT NOT NULL,PRIMARY KEY(file,ordinal));
      CREATE INDEX IF NOT EXISTS trace_calls ON trace_records(file,call_id,kind);
    `);
  }
  async update(file, status = "running") {
    if (!file) return { count: 0, turns: 1, hasUser: false, readBytes: 0 };
    const prior = this.pending.get(file) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(() => this.ingest(file, status));
    this.pending.set(file, next);
    try {
      return await next;
    } finally {
      if (this.pending.get(file) === next) this.pending.delete(file);
    }
  }
  async anchor(file, offset) {
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(Math.min(64, offset));
      await handle.read(buffer, 0, buffer.length, offset - buffer.length);
      return createHash("sha256").update(buffer).digest("hex");
    } finally {
      await handle.close();
    }
  }
  info(file, readBytes = 0) {
    const source = this.db
      .prepare("SELECT turn FROM trace_sources WHERE file=?")
      .get(file);
    return {
      count: this.db
        .prepare("SELECT COUNT(*) AS count FROM trace_records WHERE file=?")
        .get(file).count,
      turns: Math.max(1, source?.turn ?? 0),
      hasUser: (source?.turn ?? 0) > 0,
      readBytes,
    };
  }
  async ingest(file, status) {
    let details;
    try {
      details = await stat(file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return this.info(file);
    }
    const identity = `${details.dev}:${details.ino}`;
    let source = this.db
      .prepare("SELECT * FROM trace_sources WHERE file=?")
      .get(file);
    if (
      source &&
      (source.identity.split("|")[0] !== identity ||
        source.format !== FORMAT ||
        source.offset > details.size ||
        (source.offset === details.size && source.mtime !== details.mtimeMs) ||
        source.anchor !== (await this.anchor(file, source.offset)))
    ) {
      this.db.prepare("DELETE FROM trace_sources WHERE file=?").run(file);
      source = null;
    }
    source ??= {
      offset: 0,
      line: 0,
      turn: 0,
      step: 0,
      identity: `${identity}|${randomUUID()}`,
      mtime: details.mtimeMs,
      anchor: await this.anchor(file, 0),
      format: FORMAT,
    };
    this.db
      .prepare("INSERT OR IGNORE INTO trace_sources VALUES (?,?,?,?,?,?,?,?,?)")
      .run(
        file,
        source.identity,
        source.offset,
        source.mtime,
        source.anchor,
        source.line,
        source.turn,
        source.step,
        FORMAT,
      );
    if (source.offset === details.size) return this.info(file);
    let buffer = Buffer.alloc(0),
      offset = source.offset,
      readBytes = 0;
    const handle = await open(file, "r");
    let tail = Buffer.alloc(Math.min(64, offset));
    try {
      await handle.read(tail, 0, tail.length, offset - tail.length);
    } finally {
      await handle.close();
    }
    const accept = (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        source.line++;
        return;
      }
      if (event.type === "message_end" && event.message?.role === "user") {
        source.turn++;
        source.step = 0;
      }
      if (event.type === "turn_start") source.step++;
      const record = traceEvent(
        event,
        `${source.identity.split("|")[1]}:${source.line++}`,
      );
      if (!record) return;
      record.localTurn = source.turn || 1;
      record.step = source.step || null;
      if (record.type === "tool_execution_end" && record.callId) {
        const start = this.db
          .prepare(
            "SELECT ordinal,payload FROM trace_records WHERE file=? AND call_id=? AND kind='tool_execution_start' ORDER BY ordinal DESC LIMIT 1",
          )
          .get(file, record.callId);
        if (start) {
          const paired = JSON.parse(start.payload);
          paired.output = record.output;
          paired.state = record.state;
          paired.endTime = record.time;
          if (paired.time && record.time) {
            const duration =
              Number(new Date(record.time)) - Number(new Date(paired.time));
            if (duration >= 0) paired.durationMs = duration;
          }
          this.db
            .prepare(
              "UPDATE trace_records SET payload=? WHERE file=? AND ordinal=?",
            )
            .run(JSON.stringify(paired), file, start.ordinal);
          return;
        }
      }
      this.db
        .prepare("INSERT INTO trace_records VALUES (?,?,?,?,?)")
        .run(
          file,
          source.line - 1,
          record.type,
          record.callId ?? null,
          JSON.stringify(record),
        );
    };
    const parse = this.db.transaction((chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let cursor = 0,
        index;
      while ((index = buffer.indexOf(10, cursor)) !== -1) {
        accept(buffer.subarray(cursor, index).toString("utf8"));
        offset += index - cursor + 1;
        cursor = index + 1;
      }
      tail = Buffer.concat([tail, buffer.subarray(0, cursor)]).subarray(-64);
      buffer = buffer.subarray(cursor);
      this.db
        .prepare(
          "UPDATE trace_sources SET offset=?,mtime=?,anchor=?,line=?,turn=?,step=? WHERE file=?",
        )
        .run(
          offset,
          details.mtimeMs,
          createHash("sha256").update(tail).digest("hex"),
          source.line,
          source.turn,
          source.step,
          file,
        );
    });
    // Persist the byte cursor and projections together; a crash replays only the uncommitted suffix.
    try {
      for await (const chunk of createReadStream(file, {
        start: source.offset,
        end: details.size - 1,
      })) {
        readBytes += chunk.length;
        parse(chunk);
      }
      if (status !== "running" && buffer.length) {
        this.db.transaction(() => {
          accept(buffer.toString("utf8"));
          offset += buffer.length;
          tail = Buffer.concat([tail, buffer]).subarray(-64);
          this.db
            .prepare(
              "UPDATE trace_sources SET offset=?,mtime=?,anchor=?,line=?,turn=?,step=? WHERE file=?",
            )
            .run(
              offset,
              details.mtimeMs,
              createHash("sha256").update(tail).digest("hex"),
              source.line,
              source.turn,
              source.step,
              file,
            );
        })();
      }
    } catch (error) {
      // Keep committed chunks; the failed transaction leaves its cursor unchanged.
      throw error;
    }
    return this.info(file, readBytes);
  }
  page(file, offset, count, status) {
    return this.db
      .prepare(
        "SELECT payload FROM trace_records WHERE file=? ORDER BY ordinal LIMIT ? OFFSET ?",
      )
      .all(file, count, offset)
      .map((row) => {
        const event = JSON.parse(row.payload);
        if (
          status !== "running" &&
          event.type === "tool_execution_start" &&
          event.state === "started"
        )
          event.state = "interrupted";
        return event;
      });
  }
}
