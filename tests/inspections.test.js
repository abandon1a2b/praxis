import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Store, Conflict } from "../src/control/store.js";
import {
  InspectionRunner,
  inspectionSchema,
  measure,
} from "../src/control/inspections.js";
import { TaskRunner } from "../src/control/tasks.js";

test("measured HTTP observations survive restart, incidents repeat and recover only on a normal measurement", async () => {
  let code = 503;
  let body = "health fixture";
  const server = http.createServer((_req, res) => {
    if (code === 302) res.setHeader("Location", "/redirect-target");
    res.writeHead(code);
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const root = await mkdtemp(path.join(os.tmpdir(), "praxis-memory-")),
    db = path.join(root, "state.sqlite");
  let store = new Store(db);
  const config = {
    id: "health",
    name: "本地接口",
    scope: "test",
    kind: "http",
    target: `http://127.0.0.1:${server.address().port}`,
    enabled: false,
  };
  try {
    const check = store.inspections.save(config, 0),
      runner = new InspectionRunner(store.inspections);
    const first = await runner.run(check.id);
    assert.equal(first.status, "abnormal");
    assert.equal(first.evidence.status, 503);
    await runner.run(check.id);
    assert.equal(store.inspections.incidents("test")[0].occurrences, 2);
    store.inspections.record(check, {
      status: "failed",
      summary: "failed measurement",
      evidence: { error: "network" },
    });
    assert.equal(store.inspections.incidents("test")[0].status, "active");
    code = 200;
    const recovered = await runner.run(check.id);
    assert.equal(recovered.change, "recovered");
    assert.equal(store.inspections.incidents("test")[0].status, "resolved");
    assert.equal(
      store.inspections.search({ scope: "test", q: "HTTP" }).length,
      3,
    );
    assert.equal(
      store.inspections.search({ scope: "test", q: "接口" }).length,
      3,
    );
    assert.equal(
      store.inspections.search({ scope: "other", q: "HTTP" }).length,
      0,
    );
    const latestId = recovered.id;
    store.close();
    store = new Store(db);
    assert.equal(store.inspections.observation(latestId).evidence.status, 200);
    assert.equal(store.inspections.search({ scope: "test" }).length, 4);
    code = 302;
    const redirected = await measure(
      { ...check, expectedStatus: 302 },
      new AbortController().signal,
    );
    assert.equal(redirected.status, "normal");
    assert.equal(redirected.evidence.status, 302);
    assert.throws(() => store.inspections.save(config, 0), Conflict);
    code = 503;
    store.inspections.record(
      check,
      await measure(check, new AbortController().signal),
    );
    const updated = store.inspections.save(config, 1);
    assert.equal(
      store.inspections.incidents("test").find((i) => i.status === "superseded")
        .resolved_at,
      null,
    );
    assert.equal(
      store.db
        .prepare(
          "SELECT COUNT(*) AS count FROM inspection_versions WHERE check_id=?",
        )
        .get("health").count,
      2,
    );
    code = 200;
    body = "x".repeat(5000) + " needle123 " + "y".repeat(4000);
    const large = store.inspections.record(
      updated,
      await measure(updated, new AbortController().signal),
    );
    const preview = store.inspections.search({
      scope: "test",
      q: "needle123",
    })[0];
    assert.equal(preview.id, large.id);
    assert.equal(preview.evidencePreviewTruncated, true);
    assert.ok(!preview.evidence.body.includes("needle123"));
    assert.ok(
      store.inspections
        .observation(large.id)
        .evidence.body.includes("needle123"),
    );
    assert.equal(
      store.inspections.search({ scope: "test", q: '""' }).length,
      0,
    );
    assert.throws(() =>
      inspectionSchema.parse({ ...config, target: "file:///etc/passwd" }),
    );
  } finally {
    store.close();
    await new Promise((r) => server.close(r));
    await rm(root, { recursive: true, force: true });
  }
});

test("Git inspection is read-only; timeout is a failed check and schedule does not overlap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "praxis-git-inspect-")),
    store = new Store(":memory:");
  try {
    const git = (args) => execFileSync("git", ["-C", root, ...args]);
    git(["init", "-q"]);
    await writeFile(path.join(root, "a.txt"), "original");
    git(["add", "."]);
    git([
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "fixture",
    ]);
    const check = store.inspections.save(
      {
        id: "git",
        name: "Repo",
        scope: "test",
        kind: "git",
        target: root,
        enabled: true,
        timeoutSeconds: 1,
      },
      0,
    );
    assert.equal(
      (await measure(check, new AbortController().signal)).status,
      "normal",
    );
    await writeFile(path.join(root, "a.txt"), "changed");
    assert.equal(
      (await measure(check, new AbortController().signal)).status,
      "abnormal",
    );
    assert.match(git(["diff"]).toString(), /changed/);
    let calls = 0;
    const runner = new InspectionRunner(
      store.inspections,
      () => false,
      async (_check, signal) => {
        calls++;
        await new Promise((r) =>
          signal.addEventListener("abort", r, { once: true }),
        );
        return {
          status: "failed",
          summary: "timed out",
          evidence: { error: "timeout" },
        };
      },
    );
    store.db
      .prepare("UPDATE inspection_checks SET next_at=?")
      .run("2000-01-01T00:00:00Z");
    runner.tick();
    runner.tick();
    assert.equal(runner.active.size, 1);
    await runner.active.get("git").work;
    assert.equal(calls, 1);
    assert.equal(
      store.inspections.search({ scope: "test" })[0].status,
      "failed",
    );
    assert.ok(Date.parse(store.inspections.get("git").nextAt) > Date.now());
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("task memory injection retains source ids and does not replace the original goal", async () => {
  const store = new Store(":memory:");
  let request;
  try {
    const check = store.inspections.save(
      {
        id: "health",
        name: "Health",
        scope: "test",
        kind: "http",
        target: "http://127.0.0.1:1",
      },
      0,
    );
    const observation = store.inspections.record(check, {
      status: "normal",
      summary: "HTTP measured healthy",
      evidence: { status: 200 },
    });
    const runner = new TaskRunner(
      store,
      { active: new Map() },
      "/tmp/task-memory",
      () => async (input) => {
        request = input;
        return { text: "done" };
      },
    );
    const task = runner.start({
      cwd: "/tmp",
      prompt: "Inspect current state",
      memoryScope: "test",
      model: { provider: "test", id: "model" },
    });
    await runner.active.get(task.id).work;
    assert.match(request.prompt, new RegExp(observation.id));
    assert.match(request.prompt, /current state may differ/);
    assert.equal(store.getTask(task.id).input.prompt, "Inspect current state");
  } finally {
    store.close();
  }
});
