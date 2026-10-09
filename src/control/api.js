import { z } from "zod";
import packageInfo from "../../package.json" with { type: "json" };
import { businessSchema } from "./config.js";
import { taskSchema } from "./tasks.js";

export class NotFound extends Error {}

// Routing and documentation use the same definitions and request validators.
export function createApi({ store, controller, listModels, tasks }) {
  const save = z
    .object({
      config: businessSchema,
      expectedVersion: z
        .number()
        .int()
        .min(0)
        .describe(
          "创建时为 0；更新时使用 GET /api/businesses 返回的当前 version。",
        ),
    })
    .strict();
  const empty = z.object({}).strict();
  const businessId = z.string().regex(/^[a-zA-Z0-9_-]+$/);
  const runId = z.string().regex(/^[a-f0-9-]+$/);
  const business = (id) => {
    if (!store.getBusiness(id)) throw new NotFound("Business not found");
  };
  const run = (id) => {
    const value = store.getRun(id);
    if (!value) throw new NotFound("Run not found");
    return value;
  };
  const task = (id) => {
    const value = store.getTask(id);
    if (!value) throw new NotFound("Task not found");
    return value;
  };
  const routes = [
    {
      method: "GET",
      path: "/api/tasks",
      summary: "查询通用 Pi 任务。",
      response: "最近 100 个任务，含输入、状态、结果、sessionFile。",
      handle: () => store.listTasks(),
    },
    {
      method: "POST",
      path: "/api/tasks",
      summary: "启动原生开发任务（可编辑文件、执行命令，无 OS 沙箱）。",
      input: taskSchema,
      status: 202,
      response: "任务对象，记录 id 后查询状态及事件。",
      handle: (_p, value) => tasks.start(value),
    },
    {
      method: "GET",
      path: "/api/tasks/{runId}",
      params: { runId },
      summary: "查询通用任务状态和原生会话结果。",
      response:
        "任务对象；result.text 为最后回复，result.sessionFile 为服务内部续接引用。",
      handle: (p) => task(p.runId),
    },
    {
      method: "GET",
      path: "/api/tasks/{runId}/events",
      params: { runId },
      summary: "查询最近 200 条任务事件。",
      response:
        "按 seq 排列的事件，包含 session_ready 的工具/资源清单及工具运行事件。",
      handle: (p) => {
        task(p.runId);
        return store.taskEvents(p.runId);
      },
    },
    {
      method: "POST",
      path: "/api/tasks/{runId}/cancel",
      params: { runId },
      summary: "取消通用任务。",
      input: empty,
      status: 202,
      response: "{ok:true}，查询任务至终态。",
      handle: (p) => {
        task(p.runId);
        tasks.cancel(p.runId);
        return { ok: true };
      },
    },
    {
      method: "POST",
      path: "/api/tasks/{runId}/messages",
      params: { runId },
      summary: "通过 Pi steer/followUp 向活跃任务追加指令。",
      input: z
        .object({
          text: z.string().trim().min(1).max(50000),
          mode: z.enum(["steer", "followUp"]).default("steer"),
        })
        .strict(),
      status: 202,
      response: "{ok:true} 表示 Pi 已接受追加指令；不修改原始输入目标。",
      handle: async (p, value) => {
        task(p.runId);
        await tasks.message(p.runId, value);
        return { ok: true };
      },
    },
    {
      method: "POST",
      path: "/api/tasks/{runId}/resume",
      params: { runId },
      summary: "继续已结束或中断的任务会话，创建新的任务记录。",
      input: z.object({ prompt: z.string().trim().min(1).max(50000) }).strict(),
      status: 202,
      response:
        "新任务对象，parentId 指向原任务；原会话通过 Pi SessionManager.open 续接。",
      handle: (p, value) => {
        const previous = task(p.runId);
        if (previous.status === "running")
          throw new Error("Task is still active");
        return tasks.start(
          { ...previous.input, prompt: value.prompt },
          previous,
        );
      },
    },
    {
      method: "GET",
      path: "/api/docs",
      summary: "获取与运行路由及请求校验同步的 OpenAPI 文档。",
      response: "OpenAPI 3.1 JSON 文档。",
      handle: () => document,
    },
    {
      method: "GET",
      path: "/api/models",
      summary: "查询本机已配置且可用的模型。",
      response:
        "数组，元素包含 provider、id 和 name；使用返回的 provider/id 配置业务，不返回凭据。",
      handle: () => listModels(),
    },
    {
      method: "GET",
      path: "/api/businesses",
      summary: "查询业务配置及当前版本。",
      response: "业务数组；每项包含配置字段及只读 version、nextAt。",
      handle: () => store.listBusinesses(),
    },
    {
      method: "POST",
      path: "/api/businesses",
      summary: "创建或更新业务配置。",
      input: save,
      response: "保存后的业务配置及新的 version、nextAt。",
      handle: (_params, value) =>
        store.saveBusiness(value.config, value.expectedVersion),
    },
    {
      method: "GET",
      path: "/api/businesses/{businessId}/runs",
      params: { businessId },
      summary: "查询业务最近 100 次运行。",
      response:
        "按时间倒序的运行摘要数组；report 包含 completedBatches、totalBatches、findingCount，不含完整配置或报告。",
      handle: (p) => {
        business(p.businessId);
        return store.listRuns(p.businessId);
      },
    },
    {
      method: "POST",
      path: "/api/businesses/{businessId}/runs",
      params: { businessId },
      summary: "手动触发一次代码检查。",
      input: empty,
      status: 202,
      response:
        "新建运行，包含 id、businessId、version、trigger、status、createdAt、finishedAt、config、report、error。使用 id 查询进度。",
      handle: (p) => {
        business(p.businessId);
        return controller.start(p.businessId);
      },
    },
    {
      method: "GET",
      path: "/api/runs/{runId}",
      params: { runId },
      summary: "读取运行状态、配置快照与完整报告。",
      response:
        "运行对象；config 是本次运行的固定配置，report 初始可为 null，之后包含 completed、totalBatches、findings、skipped、revisions。原生模式还有 engine=pi-native、toolCalls、coverage（totalFiles、reads、fullyVerified=false）、sessionDir 与 usage。completed/totalBatches 在原生模式代表会话阶段而非文件覆盖。findings 包含 file、line、severity、title、trigger、explanation、evidence。",
      handle: (p) => run(p.runId),
    },
    {
      method: "POST",
      path: "/api/runs/{runId}/cancel",
      params: { runId },
      summary: "请求取消活跃运行。",
      input: empty,
      status: 202,
      response: '{"ok":true} 表示取消请求已接受；继续读取运行直到终态。',
      handle: (p) => {
        run(p.runId);
        controller.cancel(p.runId);
        return { ok: true };
      },
    },
  ];
  const paths = {};
  for (const route of routes) {
    const success = route.status ?? 200;
    const operation = {
      summary: route.summary,
      responses: {
        [success]: { description: route.response },
        400: { description: "请求无效，JSON {error: string}。" },
        403: { description: "Host 或 Origin 不被允许。" },
        404: { description: "接口或资源不存在。" },
        409: {
          description:
            "配置版本冲突、已有运行占用并发或运行不再活跃。不要盲目重复写入；重新读取当前状态。",
        },
      },
    };
    if (route.input)
      operation.requestBody = {
        required: true,
        content: {
          "application/json": {
            schema: z.toJSONSchema(route.input, { io: "input" }),
          },
        },
      };
    if (route.params)
      operation.parameters = Object.entries(route.params).map(
        ([name, schema]) => ({
          name,
          in: "path",
          required: true,
          schema: z.toJSONSchema(schema, { io: "input" }),
        }),
      );
    (paths[route.path] ??= {})[route.method.toLowerCase()] = operation;
  }
  const document = {
    openapi: "3.1.0",
    info: {
      title: "Praxis Control API",
      version: packageInfo.version,
      description:
        "本地单用户控制接口。业务仓库由用户配置，不绑定特定公司或项目。所有写请求使用 application/json；请求体上限 1 MiB。",
    },
    servers: [{ url: "/" }],
    paths,
    "x-agent-guide": {
      workflow: [
        "通用任务使用 POST /api/tasks：提交 cwd、prompt、model、timeoutSeconds 和 resources。开发工具可修改代码并执行命令，无 OS 沙箱；resources=true 信任并加载工作目录及 Pi 本机资源。仅在用户授权范围内使用。",
        "活跃任务可向 /api/tasks/{id}/messages 提交 text 与 mode=steer 或 followUp；已结束或中断任务用 /resume 提交 prompt，创建关联的新记录并续接 Pi 会话。任务结果是原生文本，不要求代码检查 JSON。",
        "读取 models 和 businesses。",
        "创建配置 expectedVersion=0；更新时提交完整 config，expectedVersion 使用当前 version。不要把只读 version、nextAt 放入 config。",
        "配置 enabled=true 后首个定时运行在一个间隔之后；不希望定时运行则保持 false。",
        "手动触发发送 {}，记录返回的 run id。每 2–5 秒查询该运行，遇到终态停止轮询。",
      ],
      terminalStatuses: ["completed", "failed", "cancelled", "interrupted"],
      semantics: [
        "同一时刻全局最多一个检查；默认原生路径每次触发创建独立会话与运行记录，不自动复用旧分批缓存。",
        "默认使用 Pi 原生 Agent 会话与 read/grep/find/ls 工具，按需探索固定代码快照，不再强制字符分批。completed 只表示本次会话结束；coverage.reads 是读取记录，不代表全量语义覆盖。报告问题仍待复核，当前不执行测试或修复代码。",
        "仓库路径必须是服务所在机器的绝对路径，仓库名称必须唯一；include 为空扫描全部 Git 跟踪文件，未跟踪文件不检查。",
        "更新配置只影响未来运行。取消当前运行须单独调用 cancel；关闭 enabled 不取消活跃运行。",
        "断线后先查询运行列表确认是否已创建，避免直接重复触发。不要直接修改 SQLite、缓存、Pi 凭据或源代码来配置业务。",
      ],
    },
  };
  return {
    document,
    match(method, pathname) {
      const segments = pathname.split("/");
      for (const route of routes) {
        if (method !== route.method) continue;
        const expected = route.path.split("/");
        if (expected.length !== segments.length) continue;
        const params = {};
        let matched = true;
        for (let i = 0; i < expected.length; i++) {
          const token = expected[i].match(/^\{(\w+)\}$/);
          if (token) params[token[1]] = segments[i];
          else if (expected[i] !== segments[i]) {
            matched = false;
            break;
          }
        }
        if (!matched) continue;
        if (route.params) {
          const parsed = z.object(route.params).safeParse(params);
          if (!parsed.success) continue;
        }
        return {
          status: route.status ?? 200,
          input: route.input,
          execute: (value) =>
            route.handle(
              params,
              route.input ? route.input.parse(value) : undefined,
            ),
        };
      }
    },
  };
}
