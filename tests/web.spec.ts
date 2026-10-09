import { test, expect } from "@playwright/test";

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
