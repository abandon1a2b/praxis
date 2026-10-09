import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Store, Conflict } from "../src/control/store.js";
import { Controller } from "../src/control/controller.js";
import { businessSchema } from "../src/control/config.js";

const config = (repo) => ({
  id: "business",
  name: "Business",
  enabled: false,
  repositories: [{ name: "repo", path: repo, include: [], exclude: [] }],
  model: { provider: "local-gpt", id: "gpt-6.1-sol", thinking: "low" },
  intervalSeconds: 60,
  batchCharacters: 1000,
  timeoutSeconds: 30,
  focus: "Find defects",
});

test("configuration versions are immutable and conflict protected; restart preserves records", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "praxis-store-"));
  let store;
  try {
    store = new Store(path.join(dir, "db.sqlite"));
    const v1 = store.saveBusiness(config(dir), 0);
    assert.equal(v1.version, 1);
    assert.throws(() => store.saveBusiness(config(dir), 0), Conflict);
    const run = store.createRun("business", "manual");
    store.saveBusiness({ ...config(dir), focus: "New goal" }, 1);
    assert.equal(store.getRun(run.id).config.focus, "Find defects");
    assert.equal(store.getRun(run.id).version, 1);
    assert.throws(() => store.createRun("business", "manual"), Conflict);
    store.close();
    store = new Store(path.join(dir, "db.sqlite"));
    store.recover();
    assert.equal(store.getRun(run.id).status, "interrupted");
    assert.equal(store.getBusiness("business").version, 2);
    assert.throws(() =>
      businessSchema.parse({ ...config(dir), intervalSeconds: 2147484 }),
    );
    assert.throws(() =>
      businessSchema.parse({
        ...config(dir),
        repositories: [{ name: "x", path: "../relative" }],
      }),
    );
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("runs are distinct while cache is reused; harness cannot change stored goals", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "praxis-control-"));
  const repo = path.join(dir, "repo");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(repo);
  const git = (args) => execFileSync("git", ["-C", repo, ...args]);
  git(["init", "-q"]);
  await writeFile(path.join(repo, "a.js"), "const x = 1;");
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
  const store = new Store(path.join(dir, "db.sqlite"));
  let calls = 0;
  const controller = new Controller(
    store,
    path.join(dir, "cache"),
    () => async (_batch, received) => {
      calls++;
      received.focus = "tampered";
      return '{"findings":[]}';
    },
  );
  try {
    store.saveBusiness(config(repo), 0);
    const first = controller.start("business");
    await controller.active.get(first.id).task;
    const second = controller.start("business");
    await controller.active.get(second.id).task;
    assert.notEqual(first.id, second.id);
    assert.equal(calls, 1);
    assert.equal(store.listRuns("business").length, 2);
    assert.equal(store.getRun(first.id).config.focus, "Find defects");
    assert.equal(store.getRun(second.id).status, "completed");
    assert.equal(store.getBusiness("business").focus, "Find defects");
  } finally {
    await controller.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("cancellation persists terminal status; enabled due work is scheduled once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "praxis-cancel-"));
  const store = new Store(path.join(dir, "db.sqlite"));
  const controller = new Controller(
    store,
    path.join(dir, "cache"),
    () => async () => '{"findings":[]}',
  );
  try {
    store.saveBusiness({ ...config(dir), enabled: true }, 0);
    store.db
      .prepare("UPDATE businesses SET next_at=?")
      .run("2000-01-01T00:00:00Z");
    controller.tick();
    controller.tick();
    const [run] = store.listRuns("business");
    assert.equal(run.trigger, "scheduled");
    assert.equal(store.listRuns("business").length, 1);
    controller.cancel(run.id);
    await controller.active.get(run.id).task;
    assert.equal(store.getRun(run.id).status, "cancelled");
  } finally {
    await controller.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
