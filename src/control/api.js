import { z } from "zod";
import packageInfo from "../../package.json" with { type: "json" };
import { businessSchema } from "./config.js";

export class NotFound extends Error {}

// Routing and documentation use the same definitions and request validators.
export function createApi({ store, controller, listModels }) {
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
  const routes = [
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
        "运行对象；config 是本次运行的固定配置，report 初始可为 null，之后包含 completed、totalBatches、findings、skipped、revisions。findings 包含 file、line、severity、title、trigger、explanation、evidence。",
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
        "读取 models 和 businesses。",
        "创建配置 expectedVersion=0；更新时提交完整 config，expectedVersion 使用当前 version。不要把只读 version、nextAt 放入 config。",
        "配置 enabled=true 后首个定时运行在一个间隔之后；不希望定时运行则保持 false。",
        "手动触发发送 {}，记录返回的 run id。每 2–5 秒查询该运行，遇到终态停止轮询。",
      ],
      terminalStatuses: ["completed", "failed", "cancelled", "interrupted"],
      semantics: [
        "同一时刻全局最多一个检查；相同代码和执行配置可能复用检查缓存，但每次触发有独立运行记录。",
        "检查 completed 只表示批次处理结束；报告问题仍待复核，当前不执行测试或修复代码。",
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
