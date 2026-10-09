import { fork } from "node:child_process";

// The execution process receives batch data and model parameters, never the store API.
export function createPiHarness(signal) {
  return (batch, config, context) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Run cancelled"));
      const child = fork(new URL("./worker.js", import.meta.url), [], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
        execArgv: [],
      });
      let diagnostic = "";
      child.stderr.on("data", (data) => {
        diagnostic = (diagnostic + data.toString()).slice(-2048);
      });
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        child.kill();
        if (error) reject(error);
        else resolve(result);
      };
      const cancel = () => finish(new Error("Run cancelled"));
      const timer = setTimeout(
        () => finish(new Error("Harness process timed out")),
        (config.timeoutSeconds + 10) * 1000,
      );
      signal.addEventListener("abort", cancel, { once: true });
      child.once("error", (error) => finish(error));
      child.once("exit", (code) =>
        finish(
          new Error(
            `Harness exited without a result (${code}): ${diagnostic.trim()}`,
          ),
        ),
      );
      child.once("message", (message) =>
        message.error
          ? finish(new Error(message.error))
          : finish(null, message.result),
      );
      child.send({
        batch,
        config: {
          model: config.model,
          focus: config.focus,
          timeoutSeconds: config.timeoutSeconds,
        },
        context,
      });
    });
}
