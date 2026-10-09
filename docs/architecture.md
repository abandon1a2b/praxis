# Control and Harness boundaries

Praxis remains a single project. The control service owns user intent and run lifecycle; the Harness owns model execution. The browser only calls the control API.

## Data ownership

- Business configurations are validated with Zod and saved as immutable versions in SQLite. Updates require the expected current version to prevent lost writes.
- Every manual or scheduled trigger creates a unique run bound to a configuration snapshot. Later edits apply to future runs.
- Run status, timestamps, progress and results belong to the control layer. Snapshot-based review cache is separate from run history; identical inputs may reuse completed batches.
- The controller creates bounded Pi child processes. They receive code batches, model settings and the inspection objective, and return findings. They do not receive a configuration store or write API.

The current Pi session has no tools, extensions, skills or repository instruction files. Thus model output cannot write configuration or source code. Child processes still run under the same OS account: this is an API and capability boundary, not an OS security sandbox. Before enabling arbitrary tools, add filesystem/process isolation; prompts alone cannot enforce ownership.

## Runtime semantics

One control service owns a local data directory, enforced with proper-lockfile's atomic directory lock and heartbeat. A crash lock expires after 30 seconds; startup retries for up to 35 seconds. SQLite uses WAL and transactional writes. Global review concurrency is one. Duplicate active runs are rejected.

Saving an enabled configuration schedules its first run one interval later. A run starts the next interval from its trigger time. If that interval elapses during execution, the next run waits for the active run to finish. After downtime, a due business runs once; missed intervals are not replayed. Disabling a schedule affects future triggers; cancellation is a separate operation for an active run.

On restart, unfinished run records become interrupted and owned cache locks are released. A new trigger creates a new run and may resume completed batches if the input snapshot is unchanged. Cancellation aborts a Harness child; graceful shutdown cancels active runs before closing the database. A Harness child exits when its parent IPC connection closes.

The local HTTP service binds to loopback, checks Host and Origin, accepts JSON writes only, and denies direct access to private data files. It is intended for one trusted local user. Remote hosting and multiple users require authentication and deployment-specific access controls.

## Technology choices

- Pi SDK remains the model execution engine.
- SQLite with better-sqlite3 supplies transactions and persistent local state without a separate database service. Its native dependency requires a compatible prebuilt binary or a local compiler toolchain.
- React + Vite powers a client-side operational console; there is no SSR requirement. Vite 7 is used as an established major rather than adopting a new major as part of the first console implementation.
- shadcn/ui components are checked into source; Radix provides accessible primitives and Tailwind supplies styling.
- SWR manages deduplicated requests, polling and revalidation. Configuration drafts remain local React state. TypeScript checks the UI contracts.

The console currently supports business creation/editing, multiple repository scopes, interval scheduling, manual triggers, cancellation, run history, report filters, coverage and JSON export. Calendar cron, external events, arbitrary execution tools and deep cross-module review remain future work.
