import test from "node:test";
import assert from "node:assert/strict";
import { traceEvent, readTrajectory } from "../src/control/trajectory.js";
test("trajectory exposes text and tool evidence without internal thinking", async () => {
  const event = traceEvent(
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "Visible reply" },
        ],
      },
    },
    1,
  );
  assert.equal(event.output, "Visible reply");
  assert.ok(!JSON.stringify(event).includes("private reasoning"));
  assert.equal(
    traceEvent(
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "hidden" }],
        },
      },
      2,
    ),
    null,
  );
  const tool = traceEvent(
    {
      type: "tool_execution_end",
      toolName: "read",
      toolCallId: "x",
      isError: true,
      result: { content: [{ type: "text", text: "missing file" }] },
    },
    3,
  );
  assert.equal(tool.state, "error");
  assert.equal(tool.output, "missing file");
  assert.deepEqual(
    await readTrajectory("/tmp/praxis-does-not-exist/events.jsonl"),
    { events: [], limited: false },
  );
});
