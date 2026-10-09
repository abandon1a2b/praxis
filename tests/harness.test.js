import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("worker does not inherit entry-point-only Node flags from its parent", async () => {
  const harnessUrl = new URL("../src/harness/pi.js", import.meta.url).href;
  const script = `
    import { createPiHarness } from ${JSON.stringify(harnessUrl)};
    try {
      await createPiHarness(new AbortController().signal)([], {
        model: { provider: 'praxis-test-nonexistent', id: 'missing', thinking: 'low' },
        timeoutSeconds: 10, focus: 'test'
      }, {});
      process.exitCode = 1;
    } catch (error) {
      console.log(error.message);
      if (!error.message.startsWith('Configured model unavailable')) process.exitCode = 1;
    }
  `;
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    script,
  ]);
  assert.match(stdout, /Configured model unavailable/);
});
