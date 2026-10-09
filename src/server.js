import http from "node:http";
import { mkdir, readFile, unlink, readdir } from "node:fs/promises";
import lockfile from "proper-lockfile";
import path from "node:path";
import { Store, Conflict } from "./control/store.js";
import { Controller } from "./control/controller.js";

const root = path.resolve(process.env.PRAXIS_DATA_DIR ?? ".praxis");
await mkdir(root, { recursive: true });
const release = await lockfile.lock(root, {
  lockfilePath: path.join(root, "control.lockdir"),
  stale: 30000,
  update: 5000,
  retries: { retries: 7, minTimeout: 5000, maxTimeout: 5000 },
});
const cacheRoot = path.join(root, "cache");
await mkdir(cacheRoot, { recursive: true });
// Only this control service uses this cache; its process lock permits interrupted-run recovery.
for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
  if (entry.isDirectory())
    await unlink(path.join(cacheRoot, entry.name, "run.lock")).catch(
      (error) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
}
const store = new Store(path.join(root, "control.sqlite"));
store.recover();
const controller = new Controller(store, cacheRoot);
const dev = process.argv.includes("--dev");
const port = Number(process.env.PRAXIS_PORT ?? 4310);
const vite = dev
  ? await (
      await import("vite")
    ).createServer({
      server: { middlewareMode: true, hmr: { port: port + 10000 } },
      appType: "spa",
    })
  : null;

async function body(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new Error("JSON content type required");
  let bytes = 0,
    parts = [];
  for await (const part of req) {
    bytes += part.length;
    if (bytes > 1024 * 1024) throw new Error("Request too large");
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString());
}
function json(res, status, value) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
const server = http.createServer(async (req, res) => {
  try {
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host))
      return json(res, 403, { error: "Invalid host" });
    const url = new URL(req.url, `http://${req.headers.host}`);
    const decodedPath = decodeURIComponent(url.pathname);
    if (
      /(^|\/)(\.praxis|\.pi|\.git)(\/|$)|(^|\/)(\.env[^/]*|auth\.json|praxis\.local\.json)$/.test(
        decodedPath,
      )
    )
      return json(res, 403, { error: "Private file" });
    if (url.pathname.startsWith("/api/")) {
      if (req.headers.origin && req.headers.origin !== url.origin)
        return json(res, 403, { error: "Invalid origin" });
      if (
        req.method !== "GET" &&
        req.headers["sec-fetch-site"] === "cross-site"
      )
        return json(res, 403, { error: "Cross-site request rejected" });
      if (req.method === "GET" && url.pathname === "/api/businesses")
        return json(res, 200, store.listBusinesses());
      if (req.method === "POST" && url.pathname === "/api/businesses") {
        const { config, expectedVersion } = await body(req);
        if (!Number.isInteger(expectedVersion) || expectedVersion < 0)
          throw new Error("Invalid expected version");
        return json(res, 200, store.saveBusiness(config, expectedVersion));
      }
      if (req.method === "GET" && url.pathname === "/api/models") {
        const { ModelRuntime } =
          await import("@earendil-works/pi-coding-agent");
        const runtime = await ModelRuntime.create();
        return json(
          res,
          200,
          (await runtime.getAvailable()).map((m) => ({
            provider: m.provider,
            id: m.id,
            name: m.name,
          })),
        );
      }
      const businessRuns = url.pathname.match(
        /^\/api\/businesses\/([a-zA-Z0-9_-]+)\/runs$/,
      );
      if (businessRuns) {
        if (!store.getBusiness(businessRuns[1]))
          return json(res, 404, { error: "Business not found" });
        if (req.method === "GET")
          return json(res, 200, store.listRuns(businessRuns[1]));
        if (req.method === "POST") {
          await body(req);
          return json(res, 202, controller.start(businessRuns[1]));
        }
      }
      const runPath = url.pathname.match(
        /^\/api\/runs\/([a-f0-9-]+)(\/cancel)?$/,
      );
      if (runPath) {
        const run = store.getRun(runPath[1]);
        if (!run) return json(res, 404, { error: "Run not found" });
        if (req.method === "GET" && !runPath[2]) return json(res, 200, run);
        if (req.method === "POST" && runPath[2]) {
          await body(req);
          controller.cancel(run.id);
          return json(res, 202, { ok: true });
        }
      }
      return json(res, 404, { error: "Endpoint not found" });
    }
    if (vite) return vite.middlewares(req, res);
    if (req.method !== "GET")
      return json(res, 405, { error: "Method not allowed" });
    const file = url.pathname.startsWith("/assets/")
      ? path.resolve("dist", `.${url.pathname}`)
      : path.resolve("dist/index.html");
    if (!file.startsWith(path.resolve("dist") + path.sep))
      return json(res, 403, { error: "Invalid path" });
    const data = await readFile(file);
    const type = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".css")
        ? "text/css"
        : "text/html";
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
    res.end(data);
  } catch (error) {
    json(res, error instanceof Conflict ? 409 : 400, { error: error.message });
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Praxis: http://127.0.0.1:${port}`),
);
const timer = setInterval(() => {
  try {
    controller.tick();
  } catch (error) {
    console.error(error.message);
  }
}, 1000);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  server.close();
  await controller.close();
  await vite?.close();
  store.close();
  await release();
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
