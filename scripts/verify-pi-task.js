import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { nativeHarness } from "../src/harness/native.js";

const root = await mkdtemp(path.join(os.tmpdir(), "praxis-full-pi-"));
const cwd = path.join(root, "project");
await mkdir(path.join(cwd, ".pi/skills/fixture"), { recursive: true });
await mkdir(path.join(cwd, ".pi/extensions"), { recursive: true });
await writeFile(
  path.join(cwd, "AGENTS.md"),
  "When finishing a coding task, include the phrase PROJECT-INSTRUCTIONS-LOADED in your final reply. Run node --test math.test.js after changes.\n",
);
await writeFile(
  path.join(cwd, ".pi/skills/fixture/SKILL.md"),
  "---\nname: fixture\ndescription: Fixture verification skill; use when asked to verify the integration fixture.\n---\nWhen verifying this fixture, read marker.txt and include its value in your final reply.\n",
);
await writeFile(path.join(cwd, "marker.txt"), "SKILL-MARKER-716\n");
await writeFile(
  path.join(cwd, ".pi/extensions/fixture.js"),
  'export default function(pi) { pi.registerTool({ name:"fixture_ping", label:"Fixture ping", description:"Return the integration marker", parameters:{type:"object",properties:{},additionalProperties:false}, async execute(){return {content:[{type:"text",text:"EXTENSION-MARKER-913"}],details:{}};} }); }\n',
);
await writeFile(
  path.join(cwd, "math.js"),
  "export function add(a,b){return a-b;}\n",
);
await writeFile(
  path.join(cwd, "math.test.js"),
  'import test from "node:test";import assert from "node:assert/strict";import {add} from "./math.js";test("addition",()=>assert.equal(add(2,3),5));\n',
);
const config = {
  model: { provider: "local-gpt", id: "gpt-6.1-sol", thinking: "low" },
  timeoutSeconds: 180,
};
const mcpServer = path.join(root, "fixture-mcp.mjs");
await writeFile(
  mcpServer,
  `import {McpServer} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};import {StdioServerTransport} from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};const server=new McpServer({name:'fixture',version:'1.0.0'});server.registerTool('ping',{description:'Return MCP integration marker',inputSchema:{}},async()=>({content:[{type:'text',text:'MCP-MARKER-442'}]}));await server.connect(new StdioServerTransport());`,
);
await writeFile(
  path.join(cwd, ".pi/mcp.json"),
  JSON.stringify({
    mcpServers: {
      fixture: {
        command: process.execPath,
        args: [mcpServer],
        exposure: "direct",
      },
    },
  }),
);
const events = [];
const execute = nativeHarness(new AbortController().signal);
let sent = false,
  steering;
const result = await execute(
  {
    workspace: cwd,
    sessionDir: path.join(root, "session"),
    config,
    mode: "development",
    resources: true,
    prompt:
      "Fix add so the test passes, run node --test math.test.js, use the fixture skill, call fixture_ping and the fixture MCP ping tool. Report actual results.",
  },
  (event) => {
    events.push(event);
    if (event.type === "tool_execution_start" && !sent) {
      sent = true;
      steering = execute.message(
        "steer",
        "Also include STEERING-MARKER-551 in the final reply.",
      );
      steering.catch(() => {});
    }
  },
);
await steering;
const invoked = events
  .filter((event) => event.type === "tool_execution_start")
  .map((event) => event.toolName);
if (
  ["edit", "bash", "fixture_ping", "mcp__fixture__ping"].some(
    (name) => !invoked.includes(name),
  )
)
  throw Error("Required native/extension/MCP tools not actually invoked");
const ready = events.find((e) => e.type === "session_ready");
if (
  !ready?.activeTools.includes("edit") ||
  !ready.activeTools.includes("bash") ||
  !ready.activeTools.includes("fixture_ping")
)
  throw Error("Native tools/extension not loaded");
if (
  ["grep", "find", "ls", "codemode", "tool_search"].some(
    (name) => !ready.activeTools.includes(name),
  )
)
  throw Error("Native optional tools not enabled");
if (!ready.resources.skills.includes("fixture"))
  throw Error("Skill not discovered");
await promisify(execFile)(process.execPath, ["--test", "math.test.js"], {
  cwd,
});
if (
  !result.text.includes("PROJECT-INSTRUCTIONS-LOADED") ||
  !result.text.includes("SKILL-MARKER-716") ||
  !result.text.includes("EXTENSION-MARKER-913") ||
  !result.text.includes("MCP-MARKER-442") ||
  !result.text.includes("STEERING-MARKER-551")
)
  throw Error("Project resources/MCP/steering not exercised");
const continued = await nativeHarness(new AbortController().signal)(
  {
    workspace: cwd,
    sessionDir: path.join(root, "session"),
    sessionFile: result.sessionFile,
    config,
    mode: "development",
    resources: true,
    prompt:
      "Without changing files, recall the skill marker and extension marker used in the previous task. Return both.",
  },
  (event) => {},
);
if (
  !continued.text.includes("SKILL-MARKER-716") ||
  !continued.text.includes("EXTENSION-MARKER-913")
)
  throw Error("Session continuity failed");
await writeFile(
  path.join(root, "result.json"),
  JSON.stringify({ ready, result, continued, events }, null, 2),
);
console.log(
  JSON.stringify({
    root,
    passed: true,
    tools: ready.activeTools,
    resources: ready.resources,
    sessionFile: result.sessionFile,
    continuedSession: continued.sessionFile,
    source: await readFile(path.join(cwd, "math.js"), "utf8"),
  }),
);
