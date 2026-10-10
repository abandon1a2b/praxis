import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createPlan } from "../src/review-plan.js";
import { runAgentReview } from "../src/agent-review.js";

test("plan assigns every range once and separates modules", () => {
  const plan = createPlan(
    [
      { id: "repo/api/a.js", text: "a\nb" },
      { id: "repo/ui/b.js", text: "c" },
    ],
    1000,
  );
  assert.deepEqual(
    plan.map((u) => u.module),
    ["repo/api", "repo/ui"],
  );
  assert.equal(plan.flatMap((u) => u.ranges).length, 2);
});

test("native checkpoints survive failure across distinct runs; changed code invalidates plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "praxis-plan-"));
  try {
    const repo = path.join(root, "repo");
    await mkdir(repo);
    await writeFile(path.join(repo, "a.js"), "export const a = 1;");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "add", "."]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-qm",
      "fixture",
    ]);
    const config = {
      repositories: [{ name: "repo", path: repo }],
      focus: "check",
      batchCharacters: 1000,
    };
    const checkpoints = path.join(root, "checkpoints");
    const candidate = {
      file: "repo/a.js",
      line: 1,
      severity: "low",
      title: "candidate",
      trigger: "condition",
      explanation: "impact",
      evidence: "a = 1",
    };
    const stages = [];
    const execute = async ({ prompt }, emit) => {
      if (prompt.includes("Map business")) {
        stages.push("structure");
        return { text: '{"summary":"one module"}' };
      }
      if (prompt.includes("Independently")) {
        stages.push("verification");
        return { text: '{"verdict":"rejected","reason":"not a defect"}' };
      }
      await emit({
        type: "read",
        file: "repo/a.js",
        offset: 1,
        truncated: false,
      });
      if (prompt.includes("EVERY assigned")) {
        stages.push("module");
        return { text: JSON.stringify({ findings: [candidate] }) };
      }
      stages.push("cross");
      throw new Error("interrupted");
    };
    let latest;
    await assert.rejects(
      runAgentReview(
        config,
        path.join(root, "run1"),
        execute,
        (r) => {
          latest = r;
        },
        undefined,
        checkpoints,
      ),
      /interrupted/,
    );
    assert.equal(latest.completed.length, 1);
    assert.equal(latest.findings[0].verification.status, "pending");
    const resumed = await runAgentReview(
      config,
      path.join(root, "run2"),
      async (input, emit) =>
        input.prompt.includes("cross-module contracts, business")
          ? { text: '{"findings":[]}' }
          : execute(input, emit),
      () => {},
      undefined,
      checkpoints,
    );
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.findings[0].verification.status, "rejected");
    assert.equal(stages.filter((s) => s === "module").length, 1);
    await writeFile(path.join(repo, "a.js"), "export const a = 2;");
    await assert.rejects(
      runAgentReview(
        config,
        path.join(root, "run3"),
        async () => {
          throw new Error("new structure");
        },
        (r) => {
          latest = r;
        },
        undefined,
        checkpoints,
      ),
      /new structure/,
    );
    assert.notEqual(latest.snapshotId, resumed.snapshotId);
    assert.equal(latest.resumed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
