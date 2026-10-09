import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { batches, validateFindings, runReview } from "../src/review.js";

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
