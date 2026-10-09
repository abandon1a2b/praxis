import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";

export function nativeHarness(signal) {
  let activeChild;
  const pending = new Map();
  const execute = (input, onEvent) =>
    new Promise((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Run cancelled"));
      const child = fork(new URL("./native-worker.js", import.meta.url), [], {
        execArgv: [],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      activeChild = child;
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
        const killTimer = setTimeout(() => child.kill("SIGKILL"), 3000);
        killTimer.unref();
        child.once("exit", () => clearTimeout(killTimer));
        activeChild = undefined;
        for (const request of pending.values()) {
          clearTimeout(request.timer);
          request.reject(new Error("Session ended before accepting message"));
        }
        pending.clear();
        events.then(() => (error ? reject(error) : resolve(value)), reject);
      }
      const cancel = () => finish(new Error("Run cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
      child.once("error", (error) => finish(error));
      child.once("exit", (code) =>
        finish(new Error(`Native agent exited without result (${code})`)),
      );
      child.on("message", (message) => {
        if (message.ack) {
          const request = pending.get(message.ack);
          pending.delete(message.ack);
          if (request) {
            clearTimeout(request.timer);
            message.error
              ? request.reject(new Error(message.error))
              : request.resolve();
          }
        } else if (message.event) {
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
  execute.message = (command, text) =>
    new Promise((resolve, reject) => {
      if (!activeChild?.connected)
        return reject(new Error("Session is not active"));
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("Message acknowledgement timed out"));
      }, 10000);
      pending.set(requestId, { resolve, reject, timer });
      activeChild.send({ command, text, requestId });
    });
  return execute;
}
