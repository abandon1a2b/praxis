import { fork } from "node:child_process";

export function nativeHarness(signal) {
  return (input, onEvent) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Run cancelled"));
      const child = fork(new URL("./native-worker.js", import.meta.url), [], {
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      let settled = false,
        events = Promise.resolve();
      const timer = setTimeout(
        () => finish(new Error("Native task exceeded total timeout")),
        (input.config.timeoutSeconds + 10) * 1000,
      );
      function finish(error, value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        child.kill();
        events.then(() => (error ? reject(error) : resolve(value)), reject);
      }
      const cancel = () => finish(new Error("Run cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
      child.once("error", (error) => finish(error));
      child.once("exit", (code) =>
        finish(new Error(`Native agent exited without result (${code})`)),
      );
      child.on("message", (message) => {
        if (message.event) {
          events = events.then(() => onEvent(message.event));
          events.catch(() => {});
        } else
          finish(
            message.error ? new Error(message.error) : null,
            message.result,
          );
      });
      child.send(input);
    });
}
