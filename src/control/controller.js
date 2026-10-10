import { runReview } from "../review.js";
import { executionConfig } from "./config.js";
import { Conflict } from "./store.js";
import { runAgentReview } from "../agent-review.js";
import { nativeHarness } from "../harness/native.js";
import path from "node:path";

function deepFreeze(value) {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export class Controller {
  constructor(store, cacheRoot, harnessFactory) {
    this.store = store;
    this.cacheRoot = cacheRoot;
    this.harnessFactory = harnessFactory;
    this.active = new Map();
  }
  start(id, trigger = "manual") {
    // Global concurrency is intentionally bounded to keep the first local runtime predictable.
    if (this.active.size >= 1 || this.externalBusy?.())
      throw new Conflict("Another review is active; wait for it to finish");
    const run = this.store.createRun(id, trigger);
    const abort = new AbortController();
    const config = deepFreeze(executionConfig(structuredClone(run.config)));
    let timedOut = false;
    const deadline = this.harnessFactory
      ? null
      : setTimeout(() => {
          timedOut = true;
          abort.abort(new Error("Review exceeded total timeout"));
        }, config.timeoutSeconds * 1000);
    const task = Promise.resolve().then(async () => {
      try {
        if (abort.signal.aborted) throw new Error("Run cancelled");
        const review = this.harnessFactory?.(abort.signal);
        const report = review
          ? await runReview(
              config,
              this.cacheRoot,
              (batch, input, context) =>
                review(
                  structuredClone(batch),
                  structuredClone(input),
                  structuredClone(context),
                ),
              (report) => this.store.progress(run.id, report),
            )
          : await runAgentReview(
              config,
              path.join(this.cacheRoot, "native", run.id),
              nativeHarness(abort.signal),
              (report) => this.store.progress(run.id, report),
              abort.signal,
              path.join(this.cacheRoot, "plans", config.id),
            );
        this.store.finish(
          run.id,
          abort.signal.aborted ? "cancelled" : "completed",
          report,
        );
      } catch (error) {
        this.store.finish(
          run.id,
          timedOut ? "failed" : abort.signal.aborted ? "cancelled" : "failed",
          null,
          timedOut ? "Review exceeded total timeout" : error.message,
        );
      } finally {
        clearTimeout(deadline);
        this.active.delete(run.id);
      }
    });
    this.active.set(run.id, { abort, task });
    return run;
  }
  cancel(id) {
    const active = this.active.get(id);
    if (!active) throw new Conflict("Run is no longer active");
    active.abort.abort();
  }
  tick() {
    if (this.active.size || this.externalBusy?.()) return;
    const due = this.store
      .listBusinesses()
      .filter(
        (b) => b.enabled && b.nextAt && Date.parse(b.nextAt) <= Date.now(),
      )
      .sort((a, b) => a.nextAt.localeCompare(b.nextAt));
    if (due[0]) this.start(due[0].id, "scheduled");
  }
  async close() {
    for (const { abort } of this.active.values()) abort.abort();
    await Promise.all([...this.active.values()].map(({ task }) => task));
  }
}
