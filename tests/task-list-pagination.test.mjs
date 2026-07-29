import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, ...env, PLAYGROUND_NO_UPDATE_CHECK: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "playground-task-list-test-"));
  const rows = Array.from({ length: 205 }, (_, index) => ({
    id: `task-${String(index + 1).padStart(3, "0")}`,
    title: `Task ${index + 1}`,
    tags: index >= 180 ? ["late"] : [],
  }));
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname !== "/api/challenges") {
      response.writeHead(404).end();
      return;
    }
    const page = Number(url.searchParams.get("page") || "1");
    const requested = Number(url.searchParams.get("per_page") || "60");
    const perPage = Math.min(60, requested);
    const start = (page - 1) * perPage;
    const items = rows.slice(start, start + perPage);
    requests.push({ page, requested, perPage });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({
      items,
      total: rows.length,
      page,
      pages: Math.ceil(rows.length / perPage),
      per_page: perPage,
      has_more: start + items.length < rows.length,
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { root, requests, apiBase: `http://127.0.0.1:${address.port}/api` };
}

test("task list follows pagination until --limit is satisfied", async (t) => {
  const setup = await fixture(t);
  const result = await runCli([
    "task", "list", "--limit", "125", "--json", "--api-base", setup.apiBase,
  ], { HOME: setup.root });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.total, 205);
  assert.equal(payload.total_unfiltered, 205);
  assert.equal(payload.tasks.length, 125);
  assert.equal(payload.tasks.at(-1).id, "task-125");
  assert.deepEqual(setup.requests.map(({ page }) => page), [1, 2, 3]);
});

test("task list scans every page before applying a tag filter", async (t) => {
  const setup = await fixture(t);
  const result = await runCli([
    "task", "list", "--tag", "late", "--limit", "5", "--json", "--api-base", setup.apiBase,
  ], { HOME: setup.root });
  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.total, 25);
  assert.equal(payload.total_unfiltered, 205);
  assert.equal(payload.tasks.length, 5);
  assert.equal(payload.tasks[0].id, "task-181");
  assert.ok(setup.requests.length > 3);
});
