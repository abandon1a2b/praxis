import { test, expect } from "@playwright/test";

test("task trajectory expands tool parameters and outputs on desktop and mobile", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/api/**", (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === "/api/sessions")
      return route.fulfill({
        json: [
          {
            id: "a-b",
            latestTaskId: "c-d",
            title: "Inspect service health",
            cwd: "/tmp/service",
            turnCount: 2,
            status: "completed",
            createdAt: "2026-10-09T00:00:00Z",
            input: { prompt: "Inspect service health", cwd: "/tmp/service" },
            result: { text: "Service healthy" },
            error: null,
          },
        ],
      });
    if (p === "/api/tasks/c-d")
      return route.fulfill({
        json: {
          input: { prompt: "Inspect service health" },
          result: { text: "Service healthy" },
          error: null,
        },
      });
    if (
      p.endsWith("/trajectory") &&
      new URL(route.request().url()).searchParams.has("before")
    )
      return route.fulfill({
        json: {
          total: 3,
          nextBefore: null,
          limited: false,
          events: [
            {
              id: "old",
              turn: 1,
              type: "user_message",
              time: "2026-10-08T00:00:00Z",
              title: "用户消息",
              state: "user",
              input: "Earlier inspection",
            },
          ],
        },
      });
    if (p.endsWith("/trajectory"))
      return route.fulfill({
        json: {
          limited: true,
          total: 3,
          nextBefore: 1,
          events: [
            {
              id: "1",
              type: "tool_execution_start",
              time: "2026-10-09T00:00:00Z",
              title: "bash",
              input: '{"command":"check-health"}',
              state: "completed",
              output: "HTTP 200 healthy",
              turn: 2,
              step: 1,
              durationMs: 1000,
            },
            {
              id: "3",
              type: "message_end",
              time: "2026-10-09T00:00:02Z",
              title: "模型回复",
              state: "completed",
              output: "Service healthy",
              turn: 2,
              step: 2,
            },
          ],
        },
      });
    return route.fulfill({ json: [] });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "会话轨迹", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "会话轨迹", exact: true }),
  ).toBeVisible();
  const entries = page.locator(".trajectory details");
  await expect(entries).toHaveCount(2);
  await entries.nth(0).locator("summary").click();
  await expect(
    page.getByText('{"command":"check-health"}', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("HTTP 200 healthy", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "加载更早历史", exact: true }).click();
  await expect(entries).toHaveCount(3);
  await expect(
    page.getByRole("heading", { name: "轮次 1", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "轮次 2", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/praxis-trajectory-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "/tmp/praxis-trajectory-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("native coverage distinguishes file access from full semantic verification", async ({
  page,
}) => {
  const config = {
    id: "native",
    name: "Native review",
    enabled: false,
    repositories: [
      { name: "repo", path: "/tmp/repo", include: [], exclude: [] },
    ],
    model: { provider: "test", id: "model", thinking: "low" },
    intervalSeconds: 86400,
    batchCharacters: 40000,
    timeoutSeconds: 180,
    focus: "Find defects",
  };
  const run = {
    id: "c-d",
    businessId: "native",
    version: 1,
    trigger: "manual",
    status: "completed",
    createdAt: "2026-10-09T00:00:00Z",
    finishedAt: "2026-10-09T00:01:00Z",
    config,
    error: null,
    report: {
      engine: "pi-native",
      toolCalls: 4,
      totalBatches: 1,
      completed: [{ index: 0, ranges: [] }],
      findings: [],
      skipped: [],
      revisions: {},
      coverage: {
        totalFiles: 2,
        fullyVerified: false,
        reads: [{ file: "repo/a.js", offset: 1, limit: 10, truncated: false }],
      },
    },
  };
  await page.route("**/api/**", (route) => {
    const p = new URL(route.request().url()).pathname;
    return route.fulfill({
      json:
        p === "/api/businesses"
          ? [{ ...config, version: 1, nextAt: null }]
          : p === "/api/models"
            ? []
            : p.endsWith("/runs")
              ? [
                  {
                    ...run,
                    report: {
                      completedBatches: 1,
                      totalBatches: 1,
                      findingCount: 0,
                    },
                  },
                ]
              : run,
    });
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "覆盖范围", exact: true }).click();
  await expect(
    page.getByText("范围内 2 个文件 · 读取 1 个文件 · 全量覆盖未验证", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("工具调用 4", { exact: true })).toBeVisible();
  await page.screenshot({
    path: "/tmp/praxis-native-coverage.png",
    fullPage: true,
  });
});

test("coverage shows original columns for fragments of an oversized line", async ({
  page,
}) => {
  const config = {
    id: "fragment",
    name: "Fragment review",
    enabled: false,
    repositories: [
      { name: "repo", path: "/tmp/repo", include: [], exclude: [] },
    ],
    model: { provider: "test", id: "model", thinking: "low" },
    intervalSeconds: 86400,
    batchCharacters: 40000,
    timeoutSeconds: 180,
    focus: "Find defects",
  };
  const run = {
    id: "a-b",
    businessId: config.id,
    version: 1,
    trigger: "manual",
    status: "completed",
    createdAt: "2026-10-09T00:00:00Z",
    finishedAt: "2026-10-09T00:01:00Z",
    config,
    error: null,
    report: {
      totalBatches: 1,
      completed: [
        {
          index: 0,
          ranges: [
            {
              file: "repo/a.php",
              start: 68,
              end: 68,
              startColumn: 1,
              endColumn: 40000,
            },
          ],
        },
      ],
      findings: [],
      skipped: [],
      revisions: {},
    },
  };
  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const data =
      pathname === "/api/businesses"
        ? [{ ...config, version: 1, nextAt: null }]
        : pathname === "/api/models"
          ? []
          : pathname.endsWith("/runs")
            ? [
                {
                  ...run,
                  report: {
                    completedBatches: 1,
                    totalBatches: 1,
                    findingCount: 0,
                  },
                },
              ]
            : run;
    return route.fulfill({ json: data });
  });
  await page.goto("/");
  await page.getByRole("tab", { name: "覆盖范围", exact: true }).click();
  await expect(
    page.getByText("repo/a.php:68:1–40000 列", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/praxis-long-line-coverage.png",
    fullPage: true,
  });
});

test("live API documentation exposes runtime request schemas", async ({
  request,
}) => {
  const response = await request.get("/api/docs");
  expect(response.status()).toBe(200);
  const document = await response.json();
  expect(document.openapi).toBe("3.1.0");
  const schema =
    document.paths["/api/businesses"].post.requestBody.content[
      "application/json"
    ].schema;
  expect(schema.properties.config.properties.intervalSeconds.minimum).toBe(60);
  expect(document["x-agent-guide"].terminalStatuses).toContain("cancelled");
  expect(
    (
      await request.post("/api/businesses", {
        data: { config: {}, expectedVersion: -1 },
      })
    ).status(),
  ).toBe(400);
  expect((await request.get("/api/businesses/missing/runs")).status()).toBe(
    404,
  );
});

test("local API rejects cross-origin writes and private file requests", async ({
  request,
}) => {
  expect((await request.get("/.praxis/control.sqlite")).status()).toBe(403);
  expect(
    (await request.get(`/@fs${process.cwd()}/.praxis/control.sqlite`)).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/businesses", {
        headers: { Origin: "https://example.com" },
        data: {},
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.post("/api/businesses", {
        headers: { "Content-Type": "text/plain" },
        data: "{}",
      })
    ).status(),
  ).toBe(400);
});

test("creates and edits a business; raw pattern input survives comma typing", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let businesses: Record<string, unknown>[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      pathname = new URL(request.url()).pathname;
    if (pathname === "/api/models")
      return route.fulfill({
        json: [{ provider: "local-gpt", id: "gpt-6.1-sol", name: "Sol" }],
      });
    if (pathname === "/api/businesses" && request.method() === "POST") {
      const { config, expectedVersion } = request.postDataJSON();
      businesses = [{ ...config, version: expectedVersion + 1, nextAt: null }];
      return route.fulfill({ json: businesses[0] });
    }
    return route.fulfill({
      json: pathname === "/api/businesses" ? businesses : [],
    });
  });
  await page.goto("/");
  await page.getByLabel("业务名称", { exact: true }).fill("测试业务");
  await page.getByLabel("业务标识", { exact: true }).fill("test-business");
  await page
    .getByLabel("本地绝对路径", { exact: true })
    .fill("/tmp/repository");
  const include = page.getByLabel("包含规则", { exact: true });
  await include.pressSequentially("src/**, tests/**");
  await expect(include).toHaveValue("src/**, tests/**");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "测试业务", exact: true }),
  ).toBeVisible();
  expect(
    (businesses[0].repositories as { include: string[] }[])[0].include,
  ).toEqual(["src/**", "tests/**"]);
  await page.getByRole("tab", { name: "业务配置", exact: true }).click();
  await page.getByRole("button", { name: "添加仓库", exact: true }).click();
  await expect(page.getByLabel("本地绝对路径", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "移除仓库 2", exact: true }).click();
  await page.getByLabel("业务名称", { exact: true }).fill("已修改业务");
  await page.getByRole("button", { name: "保存配置", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "已修改业务", exact: true }),
  ).toBeVisible();
  expect(businesses[0].version).toBe(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("tab", { name: "业务配置", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
