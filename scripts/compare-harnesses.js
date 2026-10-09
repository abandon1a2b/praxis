import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn, execFileSync } from "node:child_process";
import { nativeHarness } from "../src/harness/native.js";
import { reviewPrompt } from "../src/agent-review.js";
import { validateFindings } from "../src/review.js";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const root = await mkdtemp(path.join(os.tmpdir(), "praxis-comparison-"));
const config = {
  model: {
    provider: process.env.PRAXIS_COMPARE_PROVIDER ?? "local-gpt",
    id: process.env.PRAXIS_COMPARE_MODEL ?? "gpt-6.1-sol",
    thinking: "low",
  },
  timeoutSeconds: 180,
  focus:
    "Find concrete correctness defects in the supplied code. Read related files to establish the input/output contract. Do not report style issues. Do not modify code.",
};
const runtime = await ModelRuntime.create();
const model = runtime.getModel(config.model.provider, config.model.id);
if (!model || model.api !== "openai-responses")
  throw new Error(
    "Comparison requires a configured Responses model; Codex credentials must authorize the same service",
  );
const baseUrl = model.baseUrl;
const cases = [
  {
    name: "cross-file-contract",
    files: {
      "app/orders.js":
        'import { priceCents } from "./pricing.js";\nexport function invoice(items) {\n  return items.map(item => ({ totalCents: priceCents(item) * 100 }));\n}\n',
      "app/pricing.js":
        "// Returns the total in integer cents, including quantity.\nexport function priceCents(item) { return Math.round(item.unitPrice * 100) * item.quantity; }\n",
    },
    expected: { file: "app/orders.js", line: 3 },
  },
  {
    name: "long-line-recovery",
    files: {
      "app/vendor.js":
        '// generated lookup table\nexport const lookup = "' +
        "x".repeat(218825) +
        '";\n',
      "app/page.js":
        "export function pageCount(total, pageSize) {\n  // Count all pages, including a final partially filled page.\n  return Math.floor(total / pageSize);\n}\n",
    },
    expected: { file: "app/page.js", line: 3 },
  },
  {
    name: "clean-contract",
    files: {
      "app/orders.js":
        'import { priceCents } from "./pricing.js";\nexport function invoice(items) { return items.map(item => ({ totalCents: priceCents(item) })); }\n',
      "app/pricing.js":
        "// Inputs are validated by the caller: unitPrice is an integer dollar amount from 0 to 1000000, quantity is an integer from 1 to 1000. Output: integer cents.\nexport function priceCents(item) { return Math.round(item.unitPrice * 100) * item.quantity; }\n",
    },
    expected: null,
  },
];
const results = [];
for (const fixture of cases) {
  if (process.argv[2] && process.argv[2] !== fixture.name) continue;
  const workspace = path.join(root, fixture.name);
  await mkdir(workspace, { recursive: true });
  for (const [file, text] of Object.entries(fixture.files)) {
    await mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
    await writeFile(path.join(workspace, file), text);
  }
  execFileSync("git", ["init", "-q", workspace]);
  const prompt = reviewPrompt(config, Object.keys(fixture.files));
  for (const engine of ["praxis-pi-native", "codex"]) {
    const started = Date.now();
    let raw = "",
      toolCalls = 0,
      usage;
    try {
      if (engine === "praxis-pi-native") {
        const result = await nativeHarness(new AbortController().signal)(
          {
            workspace,
            sessionDir: path.join(root, `${fixture.name}-pi-session`),
            config,
            prompt,
          },
          (event) => {
            if (event.type === "tool_execution_start") toolCalls++;
          },
        );
        raw = result.text;
        usage = result.usage;
      } else {
        const output = path.join(root, `${fixture.name}-codex-final.txt`);
        const args = [
          "exec",
          "--ignore-user-config",
          "--ignore-rules",
          "--ephemeral",
          "--skip-git-repo-check",
          "--json",
          "-s",
          "read-only",
          "-C",
          workspace,
          "-m",
          config.model.id,
          "-c",
          'model_reasoning_effort="low"',
          "-c",
          'model_provider="comparison"',
          "-c",
          'model_providers.comparison.name="comparison"',
          "-c",
          `model_providers.comparison.base_url=${JSON.stringify(baseUrl)}`,
          "-c",
          'model_providers.comparison.wire_api="responses"',
          "-c",
          "model_providers.comparison.requires_openai_auth=true",
          "-o",
          output,
          prompt,
        ];
        const log = await new Promise((resolve, reject) => {
          const child = spawn("codex", args, {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let out = "",
            err = "";
          const timer = setTimeout(() => {
            child.kill();
            reject(Error("Codex comparison exceeded 180 seconds"));
          }, 180000);
          child.stdout.on("data", (d) => (out += d));
          child.stderr.on("data", (d) => (err += d));
          child.once("error", reject);
          child.once("exit", (code) => {
            clearTimeout(timer);
            code === 0
              ? resolve(out)
              : reject(Error(`Codex exit ${code}: ${err.slice(-1500)}`));
          });
        });
        await writeFile(
          path.join(root, `${fixture.name}-codex-events.jsonl`),
          log,
        );
        raw = await readFile(output, "utf8");
        const events = log
          .split("\n")
          .filter(Boolean)
          .map((l) => {
            try {
              return JSON.parse(l);
            } catch {
              return {};
            }
          });
        toolCalls = events.filter(
          (e) =>
            e.type === "item.completed" && e.item?.type === "command_execution",
        ).length;
        usage = events.findLast((e) => e.type === "turn.completed")?.usage;
      }
      await writeFile(
        path.join(root, `${fixture.name}-${engine}-response.txt`),
        raw,
      );
      const parts = Object.entries(fixture.files).map(([file, text]) => ({
        file,
        start: 1,
        end: text.split("\n").length,
        content: text,
      }));
      const findings = validateFindings(raw, parts);
      const passed = fixture.expected
        ? findings.some(
            (f) =>
              f.file === fixture.expected.file &&
              f.line === fixture.expected.line,
          )
        : findings.length === 0;
      results.push({
        case: fixture.name,
        engine,
        passed,
        seconds: (Date.now() - started) / 1000,
        toolCalls,
        findings,
        usage,
      });
    } catch (error) {
      results.push({
        case: fixture.name,
        engine,
        passed: false,
        seconds: (Date.now() - started) / 1000,
        error: error.message,
        raw,
      });
    }
    await writeFile(
      path.join(root, "results.json"),
      JSON.stringify({ root, config, results }, null, 2),
    );
    console.log(JSON.stringify(results.at(-1)));
  }
}
console.log(`Evidence: ${root}`);
