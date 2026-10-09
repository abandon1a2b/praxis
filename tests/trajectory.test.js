import test from "node:test";
import assert from "node:assert/strict";
import {
  traceEvent,
  readTrajectory,
  pairEvents,
  trajectoryPage,
  sessionTrajectory,
} from "../src/control/trajectory.js";
import { Store } from "../src/control/store.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

test("legacy task database migrates resumed chains to stable sessions without losing rows", async () => {
  const root = await mkdtemp(
      path.join(os.tmpdir(), "praxis-session-migration-"),
    ),
    file = path.join(root, "state.sqlite");
  const old = new Database(file);
  old.exec(
    "CREATE TABLE tasks (id TEXT PRIMARY KEY,input TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,finished_at TEXT,result TEXT,error TEXT,parent_id TEXT)",
  );
  const insert = old.prepare(
    "INSERT INTO tasks (id,input,status,created_at,parent_id) VALUES (?,?,?,?,?)",
  );
  insert.run(
    "first",
    '{"prompt":"original","cwd":"/tmp"}',
    "completed",
    "2026-10-09T00:00:00Z",
    null,
  );
  insert.run(
    "second",
    '{"prompt":"continue","cwd":"/tmp"}',
    "interrupted",
    "2026-10-09T00:01:00Z",
    "first",
  );
  old.close();
  let store;
  try {
    store = new Store(file);
    assert.equal(store.getTask("second").sessionId, "first");
    assert.equal(store.listSessions().length, 1);
    assert.equal(store.getTask("first").input.prompt, "original");
    store.close();
    store = new Store(file);
    assert.equal(store.sessionTasks("first").length, 2);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("tool pairing preserves identity, timing and interrupted calls", () => {
  const events = [
    traceEvent(
      {
        type: "tool_execution_start",
        toolName: "read",
        toolCallId: "x",
        time: "2026-10-09T00:00:00Z",
        args: { path: "a.js" },
      },
      0,
    ),
    traceEvent(
      {
        type: "tool_execution_end",
        toolName: "read",
        toolCallId: "x",
        time: "2026-10-09T00:00:02Z",
        result: { content: [{ type: "text", text: "source" }] },
      },
      1,
    ),
    traceEvent(
      {
        type: "tool_execution_start",
        toolName: "grep",
        toolCallId: "y",
        args: {},
      },
      2,
    ),
  ];
  const paired = pairEvents(events, "cancelled");
  assert.equal(paired.length, 2);
  assert.equal(paired[0].id, "0");
  assert.equal(paired[0].durationMs, 2000);
  assert.equal(paired[0].output, "source");
  assert.equal(paired[1].state, "interrupted");
  assert.equal(paired[1].durationMs, undefined);
});

test("resumed tasks share session and all history remains paginatable across user turns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "praxis-session-trace-")),
    store = new Store(":memory:");
  try {
    const input = {
      cwd: root,
      prompt: "inspect",
      model: { provider: "test", id: "model" },
    };
    const first = store.createTask(input),
      second = store.createTask({ ...input, prompt: "continue" }, first.id);
    assert.equal(second.sessionId, first.sessionId);
    assert.equal(store.listSessions().length, 1);
    assert.equal(store.sessionTasks(first.sessionId).length, 2);
    for (const [index, task] of [first, second].entries()) {
      const dir = path.join(root, task.id);
      await mkdir(dir);
      const events = [
        {
          type: "message_end",
          message: {
            role: "user",
            content: [{ type: "text", text: task.input.prompt }],
          },
        },
        ...Array.from({ length: 120 }, (_, i) => ({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `reply-${index}-${i}` }],
          },
        })),
      ];
      if (index === 1)
        events.push(
          {
            type: "message_end",
            message: {
              role: "user",
              content: [{ type: "text", text: "follow-up" }],
            },
          },
          { type: "turn_start" },
          {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "last reply" }],
            },
          },
        );
      await writeFile(
        path.join(dir, "events.jsonl"),
        events.map((e) => JSON.stringify(e)).join("\n"),
      );
      store.finishTask(task.id, "completed", { sessionDir: dir });
    }
    const seen = [],
      ids = new Set();
    let before;
    do {
      const page = await sessionTrajectory(store, first.sessionId, {
        before,
        limit: 50,
      });
      assert.equal(page.turnCount, 3);
      for (const event of page.events) {
        assert.ok(!ids.has(event.id));
        ids.add(event.id);
        seen.push(event);
      }
      before = page.nextBefore;
    } while (before !== null);
    assert.equal(seen.length, 244);
    assert.ok(seen.some((e) => e.turn === 1));
    assert.ok(seen.some((e) => e.turn === 2));
    assert.ok(seen.some((e) => e.turn === 3 && e.output === "last reply"));
    assert.throws(() => trajectoryPage([], { limit: 201 }));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("trajectory exposes text and tool evidence without internal thinking", async () => {
  const event = traceEvent(
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "Visible reply" },
        ],
      },
    },
    1,
  );
  assert.equal(event.output, "Visible reply");
  assert.ok(!JSON.stringify(event).includes("private reasoning"));
  assert.equal(
    traceEvent(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "hidden" }],
        },
      },
      2,
    ),
    null,
  );
  const tool = traceEvent(
    {
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "x",
      isError: true,
      result: { content: [{ type: "text", text: "missing file" }] },
    },
    3,
  );
  assert.equal(tool.state, "error");
  assert.equal(tool.output, "missing file");
  assert.deepEqual(
    await readTrajectory("/tmp/praxis-does-not-exist/events.jsonl"),
    { events: [], limited: false },
  );
});
