import path from "node:path";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { snapshot, validateFindings } from "./review.js";

export function reviewPrompt(config, files = []) {
  return `${config.focus}\nExplore the repositories under the current directory with tools; track cross-file contracts. File identifiers are relative to the current workspace, never prefix its directory name. ${files.length ? `There are ${files.length} authorized files. Sample identifiers: ${JSON.stringify(files.slice(0, 50))}. Discover the remaining files with find/ls.` : ""} Return only JSON {"findings":[{"file":"repository-name/relative/path","line":1,"severity":"high|medium|low","title":"...","trigger":"concrete conditions","explanation":"impact and reasoning","evidence":"exact nonempty substring of the cited original line"}]}. Empty findings is valid. Review code, not style. Explicitly inspect relevant files before reporting. Do not modify files.`;
}

export async function runAgentReview(
  config,
  runDir,
  execute,
  onProgress = async () => {},
  signal,
) {
  const input = await snapshot(config, signal);
  signal?.throwIfAborted();
  if (!input.files.length)
    throw new Error("No reviewable tracked files in configured scope");
  const workspace = path.join(runDir, "workspace");
  const sessionDir = path.join(runDir, "session");
  await mkdir(workspace, { recursive: true });
  const report = {
    engine: "pi-native",
    status: "running",
    snapshotId: createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex"),
    revisions: input.revisions,
    skipped: input.skipped,
    totalBatches: 1,
    completed: [],
    findings: [],
    coverage: {
      totalFiles: input.files.length,
      reads: [],
      fullyVerified: false,
    },
    toolCalls: 0,
    sessionDir,
  };
  await onProgress(structuredClone(report));
  try {
    for (const file of input.files) {
      signal?.throwIfAborted();
      const target = path.join(workspace, file.id);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.text, { flag: "wx", mode: 0o400 });
    }
    const result = await execute(
      {
        workspace,
        sessionDir,
        config,
        prompt: reviewPrompt(
          config,
          input.files.map((f) => f.id),
        ),
      },
      async (event) => {
        if (event.type === "tool_execution_start") report.toolCalls++;
        if (event.type === "read") report.coverage.reads.push(event);
        await onProgress(structuredClone(report));
      },
    );
    signal?.throwIfAborted();
    report.findings = validateFindings(
      result.text,
      input.files.map((file) => ({
        file: file.id,
        start: 1,
        end: file.text.split("\n").length,
        content: file.text,
      })),
    );
    report.usage = result.usage;
    report.status = "completed";
    // Read observations are evidence of access, never an assertion of semantic review coverage.
    report.completed = [
      { index: 0, ranges: [], finishedAt: new Date().toISOString() },
    ];
    await onProgress(structuredClone(report));
    return report;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
