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

test("topics join frontend and backend without dropping unassigned files", () => {
  const files = [
    "repo/app/auth.go",
    "repo/web/login.ts",
    "repo/app/post.go",
  ].map((id) => ({ id, text: "code" }));
  const plan = createPlan(files, 1000, [
    {
      id: "login",
      include: ["**/auth.go", "**/login.ts"],
      objective: "Check session identity contracts",
    },
  ]);
  assert.equal(plan[0].module, "login");
  assert.equal(plan[0].objective, "Check session identity contracts");
  assert.equal(plan[0].ranges.length, 2);
  assert.equal(plan.flatMap((u) => u.ranges).length, 3);
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
    const execute = async (
      { prompt, config: phaseConfig, maxToolCalls },
      emit,
    ) => {
      assert.ok(phaseConfig.timeoutSeconds <= 60);
      assert.equal(maxToolCalls, 8);
      if (prompt.includes("Map business")) {
        stages.push("structure");
        return { text: '{"summary":"one module"}' };
      }
      if (prompt.includes("Independently")) {
        stages.push("verification");
        return { text: '{"verdict":"rejected","reason":"not a defect"}' };
      }
      // Supplied excerpts count as input evidence; duplicated tool reads are unnecessary.
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
    await mkdir(path.join(repo, "extra"));
    await writeFile(path.join(repo, "extra/b.js"), "export const b = 1;");
    execFileSync("git", ["-C", repo, "add", "extra/b.js"]);
    let attempts = 0;
    await assert.rejects(
      runAgentReview(
        config,
        path.join(root, "run3"),
        async () => {
          if (++attempts === 1) throw new Error("failed unit");
          return { text: '{"findings":[]}' };
        },
        (r) => {
          latest = r;
        },
        undefined,
        checkpoints,
      ),
      /incomplete scopes/,
    );
    assert.notEqual(latest.snapshotId, resumed.snapshotId);
    assert.equal(latest.resumed, false);
    assert.equal(latest.plan[0].error, "failed unit");
    assert.equal(latest.completed.length, 1);
    assert.equal(attempts, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
