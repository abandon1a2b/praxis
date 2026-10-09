import test from "node:test";
import assert from "node:assert/strict";
import { Store, Conflict } from "../src/control/store.js";
import { TaskRunner, taskSchema } from "../src/control/tasks.js";

const input = {
  cwd: "/tmp/authorized-task",
  prompt: "Fix test",
  model: { provider: "test", id: "model" },
  timeoutSeconds: 10,
};

test("task timeout aborts the native runner and restart keeps session references", async () => {
  const store = new Store(":memory:");
  const runner = new TaskRunner(
    store,
    { active: new Map() },
    "/tmp/sessions",
    (signal) => async (_request, event) => {
      event({
        type: "session_ready",
        sessionFile: "/tmp/timeout-session.jsonl",
      });
      await new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        }),
      );
    },
  );
  try {
    const task = runner.start({ ...input, timeoutSeconds: 1 });
    const work = runner.active.get(task.id).work;
    await work;
    assert.equal(store.getTask(task.id).status, "failed");
    assert.equal(store.getTask(task.id).error, "Task exceeded total timeout");
    assert.equal(
      store.getTask(task.id).result.sessionFile,
      "/tmp/timeout-session.jsonl",
    );
    const pending = store.createTask(input);
    store.taskEvent(pending.id, {
      type: "session_ready",
      sessionFile: "/tmp/interrupted-session.jsonl",
    });
    store.recover();
    assert.equal(store.getTask(pending.id).status, "interrupted");
    assert.equal(
      store.getTask(pending.id).result.sessionFile,
      "/tmp/interrupted-session.jsonl",
    );
  } finally {
    store.close();
  }
});
test("task records retain original input; native messages and resume use persisted session", async () => {
  const store = new Store(":memory:");
  let incoming = [],
    received = [];
  const runner = new TaskRunner(
    store,
    { active: new Map() },
    "/tmp/sessions",
    () => {
      let resolve;
      const execute = async (request, event) => {
        incoming.push(request);
        event({ type: "session_ready", sessionFile: "/tmp/session.jsonl" });
        return await new Promise((r) => (resolve = r));
      };
      execute.message = async (mode, text) => {
        received.push({ mode, text });
        resolve({ text: "done", sessionFile: "/tmp/session.jsonl" });
      };
      return execute;
    },
  );
  try {
    const task = runner.start(input);
    await new Promise((r) => setImmediate(r));
    assert.throws(() => runner.start(input), Conflict);
    const firstWork = runner.active.get(task.id).work;
    await runner.message(task.id, { mode: "steer", text: "Also run tests" });
    await firstWork;
    assert.equal(store.getTask(task.id).input.prompt, "Fix test");
    assert.equal(received[0].mode, "steer");
    const next = runner.start(
      { ...input, prompt: "Continue" },
      store.getTask(task.id),
    );
    await new Promise((r) => setImmediate(r));
    assert.equal(incoming[1].sessionFile, "/tmp/session.jsonl");
    assert.equal(next.parentId, task.id);
    assert.equal(next.sessionId, task.sessionId);
    const nextWork = runner.active.get(next.id).work;
    await runner.message(next.id, { mode: "followUp", text: "Finish" });
    await nextWork;
    assert.equal(store.getTask(next.id).status, "completed");
    assert.throws(() => taskSchema.parse({ ...input, cwd: "relative" }));
  } finally {
    store.close();
  }
});
