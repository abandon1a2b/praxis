import path from "node:path";
import { mkdir, writeFile, rm, readFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { snapshot, validateFindings } from "./review.js";
import {
  createPlan,
  PLAN_VERSION,
  parseObject,
  phasePrompt,
  verificationPrompt,
  structureSummary,
} from "./review-plan.js";

export function reviewPrompt(config, files = []) {
  return `${config.focus}\nExplore the repositories under the current directory with tools; track cross-file contracts. File identifiers are relative to the current workspace, never prefix its directory name. ${files.length ? `There are ${files.length} authorized files. Sample identifiers: ${JSON.stringify(files.slice(0, 50))}. Discover the remaining files with find/ls.` : ""} Return only JSON {"findings":[{"file":"repository-name/relative/path","line":1,"severity":"high|medium|low","title":"...","trigger":"concrete conditions","explanation":"impact and reasoning","evidence":"exact nonempty substring of the cited original line"}]}. Empty findings is valid. Review code, not style. Explicitly inspect relevant files before reporting. Do not modify files.`;
}

export async function runAgentReview(
  config,
  runDir,
  execute,
  onProgress = async () => {},
  signal,
  checkpointRoot = path.join(runDir, "checkpoints"),
) {
  const input = await snapshot(config, signal);
  signal?.throwIfAborted();
  if (!input.files.length)
    throw new Error("No reviewable tracked files in configured scope");
  const workspace = path.join(runDir, "workspace");
  const sessionDir = path.join(runDir, "session");
  await mkdir(workspace, { recursive: true });
  const snapshotId = createHash("sha256")
    .update(
      JSON.stringify({ version: PLAN_VERSION, config, files: input.files }),
    )
    .digest("hex");
  await mkdir(checkpointRoot, { recursive: true });
  const checkpointFile = path.join(checkpointRoot, `${snapshotId}.json`);
  let saved;
  try {
    saved = JSON.parse(await readFile(checkpointFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const report = saved ?? {
    engine: "pi-native",
    status: "running",
    snapshotId,
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
    plan: createPlan(input.files, config.batchCharacters, config.topics),
    phase: "structure",
    structure: null,
    crossModuleComplete: false,
  };
  report.status = "running";
  report.sessionDir = sessionDir;
  report.revisions = input.revisions;
  report.skipped = input.skipped;
  report.resumed = Boolean(saved);
  delete report.error;
  report.totalBatches = report.plan.length;
  const publish = async () => {
    await writeFile(`${checkpointFile}.tmp`, JSON.stringify(report));
    await rename(`${checkpointFile}.tmp`, checkpointFile);
    await onProgress(structuredClone(report));
  };
  await publish();
  try {
    for (const file of input.files) {
      signal?.throwIfAborted();
      const target = path.join(workspace, file.id);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.text, { flag: "wx", mode: 0o400 });
    }
    const call = async (prompt) => {
      signal?.throwIfAborted();
      const result = await execute(
        {
          workspace,
          sessionDir,
          config: {
            ...config,
            timeoutSeconds: Math.min(
              config.timeoutSeconds ?? 180,
              config.phaseTimeoutSeconds ?? 60,
            ),
          },
          prompt,
          maxToolCalls: 8,
        },
        async (event) => {
          if (event.type === "tool_execution_start") report.toolCalls++;
          if (event.type === "read") report.coverage.reads.push(event);
          await onProgress(structuredClone(report));
        },
      );
      signal?.throwIfAborted();
      report.usage = [...(report.usage ?? []), ...(result.usage ?? [])];
      return result.text;
    };
    const sourceRanges = input.files.map((file) => ({
      file: file.id,
      start: 1,
      end: file.text.split("\n").length,
      content: file.text,
    }));
    const sourceById = new Map(
      input.files.map((f) => [f.id, f.text.split("\n")]),
    );
    const addFindings = (text) => {
      for (const finding of validateFindings(text, sourceRanges)) {
        const id = createHash("sha256")
          .update(JSON.stringify([finding.file, finding.line, finding.title]))
          .digest("hex");
        if (!report.findings.some((f) => f.id === id))
          report.findings.push({
            ...finding,
            id,
            verification: { status: "pending" },
          });
      }
    };
    if (!report.structure) {
      report.phase = "structure";
      await publish();
      report.structure = structureSummary(report.plan);
      await publish();
    }
    const work = report.plan
      .filter((unit) => unit.status !== "completed")
      .sort(
        (a, b) =>
          Number(a.status !== "pending") - Number(b.status !== "pending"),
      );
    for (const unit of work) {
      if (unit.status === "completed") continue;
      report.phase = "module";
      unit.status = "running";
      await publish();
      try {
        const excerpts = unit.ranges.map((range) => {
          const lines = sourceById
            .get(range.file)
            .slice(range.start - 1, range.end);
          if (range.startColumn !== undefined)
            lines[0] = lines[0].slice(range.startColumn - 1, range.endColumn);
          return {
            ...range,
            code: lines
              .map((line, i) => `${range.start + i}: ${line}`)
              .join("\n"),
          };
        });
        const output = await call(
          phasePrompt(config, "module", {
            structure: report.structure,
            unit,
            excerpts,
          }),
        );
        unit.inputEvidence = "numbered-source-excerpts";
        addFindings(output);
        unit.status = "completed";
        delete unit.error;
        report.completed.push({
          index: report.plan.indexOf(unit),
          ranges: unit.ranges,
          finishedAt: new Date().toISOString(),
        });
        await publish();
      } catch (error) {
        unit.status = "failed";
        unit.error = error.message;
        await publish();
        if (signal?.aborted) throw error;
      }
    }
    if (report.plan.some((unit) => unit.status !== "completed"))
      throw new Error(
        "Review has incomplete scopes; failed units are retained for a later run",
      );
    if (!report.crossModuleComplete) {
      report.phase = "cross-module";
      await publish();
      report.contractChecks ??= [];
      for (const module of [...new Set(report.plan.map((u) => u.module))]) {
        if (report.contractChecks.includes(module)) continue;
        const units = report.plan.filter((u) => u.module === module);
        addFindings(
          await call(
            phasePrompt(config, "cross-module", {
              topic: module,
              objective: units[0].objective,
              files: [
                ...new Set(units.flatMap((u) => u.ranges.map((r) => r.file))),
              ],
              findings: report.findings.filter((f) =>
                units.some((u) => u.ranges.some((r) => r.file === f.file)),
              ),
            }),
          ),
        );
        report.contractChecks.push(module);
        await publish();
      }
      report.crossModuleComplete = true;
      await publish();
    }
    report.phase = "verification";
    await publish();
    for (const finding of report.findings) {
      if (finding.verification.status !== "pending") continue;
      const verdict = parseObject(await call(verificationPrompt(finding)));
      if (
        !["confirmed", "rejected", "needs-context"].includes(verdict.verdict) ||
        typeof verdict.reason !== "string" ||
        !verdict.reason.trim()
      )
        throw new Error("Invalid verification result");
      finding.verification = {
        status: verdict.verdict,
        reason: verdict.reason,
        method: "model-static-review",
      };
      await publish();
    }
    report.status = "completed";
    report.phase = "completed";
    // Read observations are evidence of access, never an assertion of semantic review coverage.
    await publish();
    return report;
  } catch (error) {
    report.status = signal?.aborted ? "interrupted" : "failed";
    report.error = error.message;
    await publish();
    throw error;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
