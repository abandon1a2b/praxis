import test from "node:test";
import assert from "node:assert/strict";
import { createApi, NotFound } from "../src/control/api.js";

test("live docs use the same schemas and endpoints as runtime dispatch", async () => {
  let saved;
  const api = createApi({
    store: {
      listBusinesses: () => [],
      saveBusiness: (config, version) => {
        saved = { config, version };
        return { ...config, version: version + 1 };
      },
      getBusiness: () => undefined,
    },
    controller: {},
    listModels: async () => [{ provider: "test", id: "model", name: "Model" }],
  });
  assert.equal(await api.match("GET", "/api/docs").execute(), api.document);
  assert.equal(api.document.openapi, "3.1.0");
  const input =
    api.document.paths["/api/businesses"].post.requestBody.content[
      "application/json"
    ].schema;
  assert.equal(input.properties.expectedVersion.minimum, 0);
  assert.equal(input.properties.config.properties.intervalSeconds.minimum, 60);
  assert.equal(input.properties.config.additionalProperties, false);
  assert.equal(
    input.properties.config.properties.model.properties.thinking.default,
    "low",
  );
  assert.throws(() =>
    api
      .match("POST", "/api/businesses")
      .execute({ config: {}, expectedVersion: -1 }),
  );
  assert.equal(saved, undefined);
  const config = {
    id: "test",
    name: "Test",
    repositories: [{ name: "repo", path: "/tmp/repo" }],
    model: { provider: "test", id: "model" },
    focus: "Find defects",
  };
  const result = await api
    .match("POST", "/api/businesses")
    .execute({ config, expectedVersion: 0 });
  assert.equal(result.version, 1);
  assert.equal(saved.config.enabled, false);
  assert.equal(saved.config.model.thinking, "low");
  assert.deepEqual(await api.match("GET", "/api/models").execute(), [
    { provider: "test", id: "model", name: "Model" },
  ]);
  assert.throws(
    () => api.match("GET", "/api/businesses/missing/runs").execute(),
    NotFound,
  );
  assert.equal(api.match("GET", "/api/businesses/a.b/runs"), undefined);
});

test("documented POST endpoints validate empty bodies before triggering execution", async () => {
  let triggered = 0;
  const api = createApi({
    store: { getBusiness: () => ({ id: "b" }), getRun: () => ({ id: "a-b" }) },
    controller: {
      start: (id) => {
        triggered++;
        return { id };
      },
      cancel: () => {},
    },
    listModels: async () => [],
  });
  const endpoint = api.match("POST", "/api/businesses/b/runs");
  assert.equal(endpoint.status, 202);
  assert.throws(() => endpoint.execute({ unexpected: true }));
  assert.equal(triggered, 0);
  assert.deepEqual(await endpoint.execute({}), { id: "b" });
  assert.equal(triggered, 1);
  for (const [path, operations] of Object.entries(api.document.paths)) {
    const concrete = path
      .replace("{businessId}", "b")
      .replace("{runId}", "a-b");
    for (const method of Object.keys(operations))
      assert.ok(api.match(method.toUpperCase(), concrete), `${method} ${path}`);
  }
});
