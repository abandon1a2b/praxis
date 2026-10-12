# Control and Harness boundaries

Praxis remains a single project. The control service owns user intent and run lifecycle; the Harness owns model execution. The browser only calls the control API.

## Data ownership

- Business configurations are validated with Zod and saved as immutable versions in SQLite. Updates require the expected current version to prevent lost writes.
- Every manual or scheduled trigger creates a unique run bound to a configuration snapshot. Later edits apply to future runs.
- Run status, timestamps, progress and results belong to the control layer. Native session artifacts are separate from run history. Snapshot-based legacy review cache remains separate; only the legacy batch path may reuse completed batches.
- The controller creates one bounded Pi child process per review. It receives a fixed code snapshot path, model settings and the inspection objective. It uses Pi read/grep/find/ls tools within that snapshot and returns findings and access events. It does not receive a configuration store or write API.

The current Pi session has read-only native tools with canonical path validation, no shell, write tools, extensions, skills or repository instruction files. Snapshots contain only authorized tracked text files and are removed after execution; sessions and tool event journals persist. Model output cannot write configuration or source code. Child processes still run under the same OS account: this is an API and capability boundary, not an OS security sandbox. Before enabling arbitrary tools, add filesystem/process isolation; prompts alone cannot enforce ownership.

## Runtime semantics

Read-only inspections share the execution limit with reviews and development tasks. Their versioned configuration and immutable observations are stored in SQLite; HTTP status and Git worktree measurements form the first evidence-backed memory. Incident state tracks repeated abnormal observations and recovery, while failed checks never imply recovery. FTS5 supplies keyword search. Pi tasks opt into a named memoryScope and receive at most five bounded historical observations, with source ids and timestamps; the original goal stays unchanged. See [inspection memory](inspections-memory.md).

Trajectory queries use a persisted SQLite byte cursor and normalized records, parsing only new log suffixes after initial indexing. The UI uses TanStack Virtual for measured, viewport-only rows and retains reading anchors. The index is a UI projection, not the Pi model's session state; raw logs remain authoritative.

Generic development tasks use `/api/tasks` with an explicit working directory, prompt and model. They use Pi's native coding tools and default system prompt. `resources=true` grants project resource trust and enables the native resource loader, project context, skills, extensions, prompt templates, MCP, codemode and tool search. Resource discovery diagnostics are emitted as task events. The default is false. There is no OS sandbox in development mode: arbitrary commands and trusted extensions have the service account's access, including access outside cwd. The read-only snapshot restriction applies only to business review, not to development tasks.

Tasks are persisted separately from business configurations. Each resume creates a new task with parentId and the original immutable input plus a new prompt; Pi opens the previous session file. Active tasks accept steer/followUp via native Pi methods. Original input remains unchanged and accepted messages are recorded as events. Review and task execution share a global single-run limit. Task sessions and event journals remain available after service restart; interrupted tasks can be explicitly resumed. The console has not yet added a generic task UI; agents use the documented API.

One control service owns a local data directory, enforced with proper-lockfile's atomic directory lock and heartbeat. A crash lock expires after 30 seconds; startup retries for up to 35 seconds. SQLite uses WAL and transactional writes. Global review concurrency is one. Duplicate active runs are rejected.

Saving an enabled configuration schedules its first run one interval later. A run starts the next interval from its trigger time. If that interval elapses during execution, the next run waits for the active run to finish. After downtime, a due business runs once; missed intervals are not replayed. Disabling a schedule affects future triggers; cancellation is a separate operation for an active run.

On restart, unfinished run records become interrupted. Native reviews persist a versioned content-keyed plan under cache/plans. A new run with identical execution configuration and source contents resumes completed phases; changed inputs create a fresh plan. Each structure/module/cross-module/verification phase uses a fresh native session. This reuses completed work, not a live interrupted conversation. Every trigger still creates an independent run. Cancellation aborts a Harness child and is checked during scanning; total timeout bounds each run. Graceful shutdown cancels active runs before closing the database. A Harness child exits when its parent IPC connection closes.

Review scope inventory is generated by the controller without an exploratory model phase. Optional topics join cross-directory business files with explicit review objectives; first matching topic owns overlapping files and unassigned files remain in fallback scopes. Character budgets split assigned ranges; numbered excerpts avoid redundant reads. Each phase defaults to a 60-second timeout and permits eight exploratory tool executions. Cross-module checks checkpoint separately per topic. Reports retain pending/running/failed/completed units and pending/confirmed/rejected/needs-context findings. Confirmation is static model review, not runtime reproduction. Reading a file or completing every planned batch does not guarantee full semantic coverage. See engineering-notes/planned-review-and-recovery.md.

The local HTTP service binds to loopback, checks Host and Origin, accepts JSON writes only, and denies direct access to private data files. It is intended for one trusted local user. Remote hosting and multiple users require authentication and deployment-specific access controls.

## Technology choices

- Pi SDK remains the model execution engine.
- SQLite with better-sqlite3 supplies transactions and persistent local state without a separate database service. Its native dependency requires a compatible prebuilt binary or a local compiler toolchain.
- React + Vite powers a client-side operational console; there is no SSR requirement. Vite 7 is used as an established major rather than adopting a new major as part of the first console implementation.
- shadcn/ui components are checked into source; Radix provides accessible primitives and Tailwind supplies styling.
- SWR manages deduplicated requests, polling and revalidation. Configuration drafts remain local React state. TypeScript checks the UI contracts.

The console currently supports business creation/editing, multiple repository scopes, interval scheduling, manual triggers, cancellation, run history, report filters, coverage and JSON export. Calendar cron, external events, arbitrary execution tools and deep cross-module review remain future work.
