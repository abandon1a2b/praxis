import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, appendFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/control/store.js";
import { indexedTrajectory } from "../src/control/trajectory.js";

test("index resumes byte cursor across restart, pairs appended results and ignores incomplete lines", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "praxis-trace-index-")),
    file = path.join(root, "events.jsonl"),
    db = path.join(root, "state.sqlite");
  let store = new Store(db);
  try {
    const start = {
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "x",
      args: { path: "中文.js" },
      time: "2026-10-09T00:00:00Z",
    };
    await writeFile(file, JSON.stringify(start) + "\n");
    assert.ok((await store.trajectoryIndex.update(file)).readBytes > 0);
    assert.equal((await store.trajectoryIndex.update(file)).readBytes, 0);
    const id = store.trajectoryIndex.page(file, 0, 1, "running")[0].id;
    await appendFile(file, '{"type":"tool_execution_end"');
    await store.trajectoryIndex.update(file);
    assert.equal(store.trajectoryIndex.info(file).count, 1);
    store.close();
    store = new Store(db);
    await appendFile(
      file,
      ',"toolName":"read","toolCallId":"x","result":{"content":[{"type":"text","text":"中文结果"}]},"time":"2026-10-09T00:00:01Z"}\n',
    );
    const update = await store.trajectoryIndex.update(file);
    assert.equal(update.count, 1);
    const paired = store.trajectoryIndex.page(file, 0, 1, "completed")[0];
    assert.equal(paired.id, id);
    assert.equal(paired.output, "中文结果");
    assert.equal(paired.durationMs, 1000);
    assert.equal((await store.trajectoryIndex.update(file)).readBytes, 0);
    await writeFile(
      file,
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "replacement" }],
        },
      }) + "\n",
    );
    await store.trajectoryIndex.update(file, "completed");
    assert.equal(
      store.trajectoryIndex.page(file, 0, 1, "completed")[0].output,
      "replacement",
    );
    assert.notEqual(
      store.trajectoryIndex.page(file, 0, 1, "completed")[0].id,
      id,
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("large history pages query the indexed projection without rescanning logs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "praxis-trace-large-")),
    file = path.join(root, "events.jsonl"),
    store = new Store(":memory:");
  try {
    await writeFile(
      file,
      Array.from({ length: 10000 }, (_, i) =>
        JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `event-${i}` }],
          },
        }),
      ).join("\n") + "\n",
    );
    const page = await indexedTrajectory(store, file, "completed", [], {
      limit: 50,
    });
    assert.equal(page.total, 10000);
    assert.equal(page.events.length, 50);
    assert.equal(page.events[0].output, "event-9950");
    assert.equal(
      (await store.trajectoryIndex.update(file, "completed")).readBytes,
      0,
    );
    const earlier = await indexedTrajectory(store, file, "completed", [], {
      limit: 50,
      before: page.nextBefore,
    });
    assert.equal(earlier.events.at(-1).output, "event-9949");
    await rm(file);
    const retained = await indexedTrajectory(store, file, "completed", [], {
      limit: 1,
    });
    assert.equal(retained.total, 10000);
    assert.equal(retained.events[0].output, "event-9999");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
