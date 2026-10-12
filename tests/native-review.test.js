import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { scopedTools } from "../src/harness/native-session.js";
import { runAgentReview } from "../src/agent-review.js";

test("native read/search tools reject traversal and permit authorized reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "praxis-tools-"));
  try {
    await writeFile(path.join(root, "safe.js"), "const answer = 42;");
    const reads = [],
      tools = await scopedTools(root, (r) => reads.push(r));
    const read = tools.find((t) => t.name === "read");
    const result = await read.execute(
      "1",
      { path: "safe.js" },
      new AbortController().signal,
    );
    assert.match(result.content[0].text, /42/);
    assert.equal(reads[0].file, "safe.js");
    const bounded = (await scopedTools(root, () => {}, 1)).find(
      (t) => t.name === "read",
    );
    await bounded.execute(
      "bounded-1",
      { path: "safe.js" },
      new AbortController().signal,
    );
    await assert.rejects(
      bounded.execute(
        "bounded-2",
        { path: "safe.js" },
        new AbortController().signal,
      ),
      /budget exhausted/,
    );
    for (const tool of tools)
      await assert.rejects(
        tool.execute(
          "2",
          { path: "..", pattern: "*" },
          new AbortController().signal,
        ),
        /outside authorized/,
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native review uses intact source, verifies citations and keeps source unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "praxis-native-"));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  const git = (args) => promisify(execFile)("git", ["-C", repo, ...args]);
  const text = "export const bug = 1;\n" + "x".repeat(218825);
  try {
    await writeFile(path.join(repo, "a.js"), text);
    await git(["init", "-q"]);
    await git(["add", "."]);
    await git([
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
      repositories: [{ name: "repo", path: repo }],
      focus: "Find defects",
    };
    const report = await runAgentReview(
      config,
      path.join(root, "run"),
      async ({ workspace, prompt }, onEvent) => {
        assert.equal(
          await readFile(path.join(workspace, "repo/a.js"), "utf8"),
          text,
        );
        await onEvent({ type: "tool_execution_start", toolName: "read" });
        await onEvent({
          type: "read",
          file: "repo/a.js",
          offset: 1,
          limit: 1,
          truncated: false,
        });
        if (prompt.includes("Map business entry points"))
          return { text: '{"summary":"fixture module"}', usage: [] };
        if (prompt.includes("Independently challenge"))
          return {
            text: '{"verdict":"confirmed","reason":"fixture static evidence"}',
            usage: [],
          };
        return {
          text: JSON.stringify({
            findings: [
              {
                file: "repo/a.js",
                line: 1,
                severity: "low",
                title: "test",
                trigger: "test",
                explanation: "test",
                evidence: "bug = 1",
              },
            ],
          }),
          usage: [],
        };
      },
    );
    assert.equal(report.engine, "pi-native");
    assert.ok(report.toolCalls > 1);
    assert.ok(report.plan.every((unit) => unit.status === "completed"));
    assert.equal(report.findings[0].verification.status, "confirmed");
    assert.equal(report.coverage.fullyVerified, false);
    assert.equal(report.findings.length, 1);
    assert.equal(await readFile(path.join(repo, "a.js"), "utf8"), text);
    await assert.rejects(readFile(path.join(root, "run/workspace/repo/a.js")), {
      code: "ENOENT",
    });
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(
      runAgentReview(
        config,
        path.join(root, "stopped"),
        () => {},
        () => {},
        stop.signal,
      ),
      { name: "AbortError" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
