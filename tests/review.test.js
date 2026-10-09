import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rm,
  mkdir,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  batches,
  validateFindings,
  runReview,
  snapshot,
} from "../src/review.js";

test("exact-limit lines remain within batch character limits", () => {
  const result = batches(
    [{ id: "r/a.js", text: "a".repeat(1000) + "\nb" }],
    1000,
  );
  assert.equal(result.length, 2);
  for (const batch of result)
    assert.ok(
      batch.reduce((sum, part) => sum + part.content.length, 0) <= 1000,
    );
  assert.deepEqual(
    result.flat().map((p) => [p.start, p.end]),
    [
      [1, 1],
      [2, 2],
    ],
  );
});

test("tracked paths through replaced parent directories cannot escape repository", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "praxis-symlink-"));
  const repo = path.join(root, "repo"),
    outside = path.join(root, "outside");
  try {
    await mkdir(path.join(repo, "dir"), { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(repo, "dir/a.js"), "safe");
    await writeFile(path.join(outside, "a.js"), "private");
    const git = (args) => execFileSync("git", ["-C", repo, ...args]);
    git(["init", "-q"]);
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
    await rm(path.join(repo, "dir"), { recursive: true });
    await symlink(outside, path.join(repo, "dir"));
    const input = await snapshot({ repositories: [{ name: "r", path: repo }] });
    assert.equal(input.files.length, 0);
    assert.ok(
      input.skipped.some(
        (s) => s.reason === "resolved path outside repository",
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chunks retain absolute line coverage and reject invented evidence", () => {
  const parts = batches(
    [{ id: "r/a.js", text: "aaaa\nbbbb\ncccc" }],
    10,
  ).flat();
  assert.deepEqual(
    parts.map((p) => [p.start, p.end]),
    [
      [1, 2],
      [3, 3],
    ],
  );
  assert.throws(() =>
    validateFindings(
      JSON.stringify({
        findings: [
          {
            file: "r/a.js",
            line: 3,
            severity: "high",
            title: "x",
            trigger: "x",
            explanation: "x",
            evidence: "invented",
          },
        ],
      }),
      parts,
    ),
  );
});

test("failed run resumes remaining batches and excludes credentials", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "praxis-test-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "praxis-runs-"));
  try {
    const git = (args) => execFileSync("git", ["-C", dir, ...args]);
    git(["init", "-q"]);
    await writeFile(path.join(dir, "a.js"), "a".repeat(600));
    await writeFile(path.join(dir, "b.js"), "b".repeat(600));
    await writeFile(path.join(dir, ".env"), "SECRET=hidden");
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
    const config = {
      id: "test",
      repositories: [{ name: "r", path: dir }],
      batchCharacters: 1000,
    };
    let calls = 0;
    await assert.rejects(
      runReview(config, root, async () => {
        if (++calls === 2) throw new Error("interrupted");
        return '{"findings":[]}';
      }),
    );
    const failed = JSON.parse(
      await readFile(path.join(root, "test/latest.json"), "utf8"),
    );
    assert.equal(failed.status, "failed");
    assert.equal(failed.completed.length, 1);
    let resumed = 0;
    const done = await runReview(config, root, async () => {
      resumed++;
      return '{"findings":[]}';
    });
    assert.equal(resumed, 1);
    assert.equal(done.status, "completed");
    assert.ok(done.skipped.some((s) => s.reason === "credential file"));
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
