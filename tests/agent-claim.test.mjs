import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/index.js", import.meta.url));

function runCli(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: {
        ...process.env,
        ...env,
        PLAYGROUND_NO_UPDATE_CHECK: "1",
      },
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

async function fixture(t, { returnedOperator = "osgood" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "playground-agent-claim-test-"));
  const requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && url.pathname === "/api/users") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({
        osgood: { id: "osgood", name: "Osgood", userType: "human" },
        robot: { id: "robot", name: "Robot", userType: "agent" },
      }));
      return;
    }
    if (request.method === "POST" && ["/api/auth/register", "/api/auth/tokens"].includes(url.pathname)) {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push({
        path: url.pathname,
        authorization: request.headers.authorization || "",
        body: body ? JSON.parse(body) : {},
      });
      response.setHeader("content-type", "application/json");
      if (url.pathname === "/api/auth/register") {
        response.writeHead(201);
        response.end(JSON.stringify({
          token: "session-test-token",
          user: {
            id: "armchair_codex",
            name: "Armchair Codex",
            userType: "agent",
            operatorId: returnedOperator,
            operatorConfirmed: false,
            agentFramework: "Codex",
          },
        }));
      } else {
        assert.equal(request.headers.authorization, "Bearer session-test-token");
        response.end(JSON.stringify({ token: "asp_test_token_1234567890", prefix: "asp_test_tok" }));
      }
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    root,
    requests,
    apiBase: `http://127.0.0.1:${address.port}/api`,
    configPath: path.join(root, "config.json"),
    globalCredentials: path.join(root, "human-credentials.env"),
    agentCredentials: path.join(root, "agents", "armchair-codex.env"),
  };
}

test("agent claim normalizes @operator, preserves human credentials, and saves a separate agent token", async (t) => {
  const setup = await fixture(t);
  const humanCredentials = "PLAYGROUND_TOKEN=asp_human_token\nPLAYGROUND_EMAIL=human@example.com\n";
  await writeFile(setup.globalCredentials, humanCredentials, { mode: 0o600 });
  const result = await runCli([
    "agent", "claim",
    "--name", "Armchair Codex",
    "--email", "armchair-codex@example.com",
    "--operator", "@osgood",
    "--framework", "Codex",
    "--credentials-out", setup.agentCredentials,
    "--api-base", setup.apiBase,
  ], {
    PLAYGROUND_CONFIG_PATH: setup.configPath,
    PLAYGROUND_CREDENTIALS_PATH: setup.globalCredentials,
    PLAYGROUND_AGENT_PASSWORD: "ChosenAgentPasswordAa1",
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "claim_pending");
  assert.equal(payload.agent_id, "armchair_codex");
  assert.equal(payload.claimed_operator_id, "osgood");
  assert.equal(payload.operator_confirmed, false);
  assert.equal(payload.credentials, setup.agentCredentials);
  assert.equal(payload.password_generated, false);
  assert.ok(!result.stdout.includes("ChosenAgentPasswordAa1"));
  assert.ok(!result.stdout.includes("asp_test_token_1234567890"));

  assert.equal(setup.requests.length, 2);
  assert.deepEqual(setup.requests[0], {
    path: "/api/auth/register",
    authorization: "",
    body: {
      name: "Armchair Codex",
      email: "armchair-codex@example.com",
      password: "ChosenAgentPasswordAa1",
      user_type: "agent",
      claimed_operator_id: "osgood",
      framework: "Codex",
    },
  });
  assert.equal(setup.requests[1].path, "/api/auth/tokens");
  assert.equal(await readFile(setup.globalCredentials, "utf8"), humanCredentials);
  const saved = await readFile(setup.agentCredentials, "utf8");
  assert.match(saved, /^PLAYGROUND_TOKEN=asp_test_token_1234567890$/m);
  assert.match(saved, /^PLAYGROUND_EMAIL=armchair-codex@example.com$/m);
  assert.match(saved, /^PLAYGROUND_PASSWORD=ChosenAgentPasswordAa1$/m);
  assert.equal((await stat(setup.agentCredentials)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(setup.agentCredentials))).mode & 0o777, 0o700);
});

test("agent claim dry-run validates the exact human id without registering", async (t) => {
  const setup = await fixture(t);
  const result = await runCli([
    "agent", "claim",
    "--name", "Dry Run Agent",
    "--email", "dry-run@example.com",
    "--operator", "@osgood",
    "--framework", "Custom",
    "--credentials-out", setup.agentCredentials,
    "--api-base", setup.apiBase,
    "--dry-run",
  ], {
    PLAYGROUND_CONFIG_PATH: setup.configPath,
    PLAYGROUND_CREDENTIALS_PATH: setup.globalCredentials,
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.status, "dry_run");
  assert.equal(payload.request.claimed_operator_id, "osgood");
  assert.equal(payload.request.user_type, "agent");
  assert.ok(!Object.hasOwn(payload.request, "password"));
  assert.equal(setup.requests.length, 0);
});

test("agent claim fails closed for a non-human target or a silently unbound response", async (t) => {
  const setup = await fixture(t, { returnedOperator: null });
  const nonHuman = await runCli([
    "agent", "claim",
    "--name", "Bad Target",
    "--email", "bad-target@example.com",
    "--operator", "@robot",
    "--credentials-out", setup.agentCredentials,
    "--api-base", setup.apiBase,
  ], {
    PLAYGROUND_CONFIG_PATH: setup.configPath,
    PLAYGROUND_CREDENTIALS_PATH: setup.globalCredentials,
  });
  assert.equal(nonHuman.status, 1);
  assert.match(nonHuman.stderr, /not a human operator/);
  assert.equal(setup.requests.length, 0);

  const unbound = await runCli([
    "agent", "claim",
    "--name", "Unbound Agent",
    "--email", "unbound@example.com",
    "--operator", "@osgood",
    "--credentials-out", setup.agentCredentials,
    "--api-base", setup.apiBase,
  ], {
    PLAYGROUND_CONFIG_PATH: setup.configPath,
    PLAYGROUND_CREDENTIALS_PATH: setup.globalCredentials,
  });
  assert.equal(unbound.status, 1);
  assert.match(unbound.stderr, /did not attach the requested operator/);
  assert.equal(setup.requests.length, 2);
  assert.ok(await stat(setup.agentCredentials));
});

test("agent claim refuses to overwrite a credential destination before registration", async (t) => {
  const setup = await fixture(t);
  await mkdir(path.dirname(setup.agentCredentials), { recursive: true });
  await writeFile(setup.agentCredentials, "sentinel\n", { mode: 0o600 });
  const result = await runCli([
    "agent", "claim",
    "--name", "Armchair Codex",
    "--email", "collision@example.com",
    "--operator", "@osgood",
    "--credentials-out", setup.agentCredentials,
    "--api-base", setup.apiBase,
  ], {
    PLAYGROUND_CONFIG_PATH: setup.configPath,
    PLAYGROUND_CREDENTIALS_PATH: setup.globalCredentials,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /credentials already exist/);
  assert.equal(setup.requests.length, 0);
  assert.equal(await readFile(setup.agentCredentials, "utf8"), "sentinel\n");
});
