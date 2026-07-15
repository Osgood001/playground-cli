#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type OptValue = string | boolean | string[];

const VERSION = "0.1.13";
const DEFAULT_PLAY_API = "http://vxzj1507371.bohrium.tech:50001/api";
const DEFAULT_WORKER_API = "http://47.92.88.121:443/api";
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".playground", "config.json");
const DEFAULT_TRISOL_INSTALLER = "https://trisol.dp.tech/install.sh";
const DEFAULT_TRISOL_TEAM = "2076600516862812160";
const DEFAULT_DATA_LIST_LIMIT = 20;
const BUILTIN_TASK_CONFIGS: Record<string, Record<string, Json>> = {
  "cluster-17187547-paper-811029921265614849": {
    id: "cluster-17187547-paper-811029921265614849",
    trisol: {
      model: { model: "esm2-150m-protein-language-model", version: "v0.1" },
      datasets: [
        { dataset: "uniprot-goa", version: "v1" },
        { dataset: "native-protein-structures-pdb", version: "v1.0" },
        { dataset: "biolip", version: "v1" },
        { dataset: "string-database-v11-0", version: "v11.0" },
        { dataset: "uniref90-sequence-clusters", version: "v0.1" },
      ],
    },
  },
};
const EMBEDDED_TRISOL_TOKEN = "trp_Oz6VMMtJgTx3_LRDhoZToY3sNykBxpwFITdr25Zu4bJ1T";
const SECRET_PATTERNS = [
  /BOHRIUM_ACCESS_KEY\s*=/i,
  /Authorization:\s*Bearer\s+[A-Za-z0-9._-]{16,}/i,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
];
const TRACE_SECRET_PATTERNS = [
  /asp_[a-zA-Z0-9]{40,}/g,
  /(Bearer\s+)[A-Za-z0-9._-]{20,}/gi,
];
const ARM_STEP_TYPES = new Set([
  "thought",
  "tool_call",
  "tool_result",
  "artifact",
  "decision",
  "error",
  "observation",
]);
const PRICE_IN: Record<string, number> = {
  "deepseek-v4-pro": 0.27,
  "deepseek-v3": 0.14,
  "claude-opus-4-7": 15.0,
  "claude-sonnet-4-6": 3.0,
  "claude-opus-4-5": 15.0,
  "claude-sonnet-4-5": 3.0,
  "gpt-4o": 2.5,
  "gpt-4o-mini": 0.15,
  "gpt-5": 5.0,
};
const PRICE_OUT: Record<string, number> = {
  "deepseek-v4-pro": 1.10,
  "deepseek-v3": 0.28,
  "claude-opus-4-7": 75.0,
  "claude-sonnet-4-6": 15.0,
  "claude-opus-4-5": 75.0,
  "claude-sonnet-4-5": 15.0,
  "gpt-4o": 10.0,
  "gpt-4o-mini": 0.60,
  "gpt-5": 15.0,
};

interface ParsedArgs {
  commands: string[];
  opts: Record<string, OptValue>;
}

interface BundleResult {
  bundlePath: string;
  manifest: Record<string, Json>;
  traceSteps: Record<string, Json>[];
  rawMessagesData?: Buffer;
  rawMessagesFilename?: string;
}

interface MultipartFile {
  name: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

interface TrisolDatasetRef {
  dataset: string;
  version?: string;
  split?: string;
  path?: string;
}

interface TrisolModelRef {
  model: string;
  version?: string;
  path?: string;
}

class CliError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseArgs(argv: string[]): ParsedArgs {
  const commands: string[] = [];
  const opts: Record<string, OptValue> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      commands.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    let value: string | boolean = eq >= 0 ? arg.slice(eq + 1) : true;
    if (eq < 0 && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      value = argv[i + 1];
      i += 1;
    }
    const existing = opts[key];
    if (existing === undefined) {
      opts[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(String(value));
    } else {
      opts[key] = [String(existing), String(value)];
    }
  }
  return { commands, opts };
}

function opt(opts: Record<string, OptValue>, key: string): string | undefined {
  const value = opts[key];
  if (value === undefined || typeof value === "boolean") return undefined;
  if (Array.isArray(value)) return value[value.length - 1];
  return value;
}

function optAll(opts: Record<string, OptValue>, key: string): string[] {
  const value = opts[key];
  if (value === undefined || typeof value === "boolean") return [];
  return Array.isArray(value) ? value : [value];
}

function flag(opts: Record<string, OptValue>, key: string): boolean {
  return opts[key] === true || opts[key] === "true";
}

function required(opts: Record<string, OptValue>, key: string): string {
  const value = opt(opts, key);
  if (!value) throw new CliError(`missing --${key}`);
  return value;
}

function asPlainObject(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  return Boolean(asPlainObject(value));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function timestampValue(value: unknown): string | undefined {
  const text = stringValue(value);
  if (text) return text;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const millis = value > 1_000_000_000_000 ? value : value * 1000;
  try {
    return new Date(millis).toISOString().replace(/\.\d{3}Z$/, "Z");
  } catch {
    return undefined;
  }
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function stableStepId(prefix: string, source: string, index: number): string {
  const digest = createHash("sha1").update(`${source}:${index}`).digest("hex").slice(0, 8);
  return `${prefix}_${index}_${digest}`;
}

function tracePrice(model: string | undefined, kind: "in" | "out"): number {
  const lower = (model || "").toLowerCase();
  const table = kind === "in" ? PRICE_IN : PRICE_OUT;
  for (const [name, price] of Object.entries(table)) {
    if (lower.includes(name)) return price;
  }
  return kind === "in" ? 0.50 : 1.50;
}

function estimateCostUsd(model: string | undefined, tokensIn: number, tokensOut: number): number {
  return Number(((tokensIn * tracePrice(model, "in") + tokensOut * tracePrice(model, "out")) / 1_000_000).toFixed(6));
}

function isoNoMillis(millis: number): string {
  return new Date(millis).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function timestampMillis(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function redactTraceText(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let clean = text;
  clean = clean.replace(TRACE_SECRET_PATTERNS[0], () => {
    redactions += 1;
    return "<asp_TOKEN_REDACTED>";
  });
  clean = clean.replace(TRACE_SECRET_PATTERNS[1], (_match, prefix: string) => {
    redactions += 1;
    return `${prefix}<REDACTED>`;
  });
  return { text: clean, redactions };
}

function objectRowsFromJsonl(text: string): Record<string, any>[] {
  const rows: Record<string, any>[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const obj = asPlainObject(parsed);
      if (obj) rows.push(obj);
    } catch {
      // Ignore non-JSON diagnostic lines in native trajectory logs.
    }
  }
  return rows;
}

function normalizeArmSteps(rows: Record<string, any>[]): Record<string, Json>[] {
  const steps: Record<string, Json>[] = [];
  for (const [index, row] of rows.entries()) {
    const stepType = stringValue(row.step_type) || stringValue(row.type);
    if (!stepType || !ARM_STEP_TYPES.has(stepType)) continue;
    const step: Record<string, Json> = { ...(row as Record<string, Json>) };
    step.step_type = stepType;
    step.type = stepType;
    step.step_order = numberValue(step.step_order) || index + 1;
    if (!step.timestamp) step.timestamp = utcNow();
    steps.push(step);
  }
  return steps;
}

function nativeTraceLike(rows: Record<string, any>[]): boolean {
  return rows.some((row) => {
    const type = stringValue(row.type);
    return Boolean(type && type.includes(".") && !ARM_STEP_TYPES.has(type));
  });
}

function bodyFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      const obj = asPlainObject(item);
      if (obj) return String(obj.text ?? obj.content ?? JSON.stringify(obj));
      return String(item);
    }).join("\n");
  }
  if (content === undefined || content === null) return "";
  return typeof content === "object" ? JSON.stringify(content) : String(content);
}

function contentTextFromRow(row: Record<string, any>): string {
  return bodyFromContent(row.content ?? row.text ?? row.message ?? row.body);
}

function jsonValue(value: unknown): Json {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value)) as Json;
  } catch {
    return String(value);
  }
}

function attachResourceSignals(
  step: Record<string, Json>,
  modelId: string | undefined,
  tokensIn: number,
  tokensOut: number,
  costUsd: number,
): void {
  if (modelId) step.model_id = modelId;
  if (tokensIn) step.tokens_in = tokensIn;
  if (tokensOut) step.tokens_out = tokensOut;
  if (costUsd) step.cost_usd = costUsd;
  else if (tokensIn || tokensOut) step.cost_usd = estimateCostUsd(modelId, tokensIn, tokensOut);
}

function metricsSignals(metrics: Record<string, any> | undefined, modelId: string | undefined): {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
} {
  const tokensIn = numberValue(metrics?.prompt_tokens ?? metrics?.prompt ?? metrics?.input_tokens ?? metrics?.input ?? metrics?.tokens_in);
  const tokensOut = numberValue(metrics?.completion_tokens ?? metrics?.completion ?? metrics?.output_tokens ?? metrics?.output ?? metrics?.tokens_out);
  const costUsd = numberValue(metrics?.cost_usd);
  return { tokensIn, tokensOut, costUsd: costUsd || estimateCostUsd(modelId, tokensIn, tokensOut) };
}

function appendToolBlocks(
  steps: Record<string, Json>[],
  messages: unknown,
  timestamp: string,
  source: string,
  rowIndex: number,
): void {
  if (!Array.isArray(messages)) return;
  let blockIndex = 0;
  for (const message of messages) {
    const msg = asPlainObject(message);
    if (!msg || !Array.isArray(msg.content)) continue;
    const msgTs = stringValue(msg.timestamp) || timestamp;
    for (const blockRaw of msg.content) {
      const block = asPlainObject(blockRaw);
      if (!block) continue;
      const type = stringValue(block.type);
      if (type === "tool_use") {
        const id = stringValue(block.id) || stableStepId("tool", source, rowIndex + blockIndex);
        steps.push({
          step_type: "tool_call",
          type: "tool_call",
          step_id: stableStepId("tc", source, rowIndex + blockIndex),
          step_order: steps.length + 1,
          tool_call_id: id,
          tool_name: stringValue(block.name) || "unknown",
          tool_args: (asPlainObject(block.input) || {}) as unknown as Json,
          timestamp: msgTs,
        });
      } else if (type === "tool_result") {
        steps.push({
          step_type: "tool_result",
          type: "tool_result",
          step_id: stableStepId("tr", source, rowIndex + blockIndex),
          step_order: steps.length + 1,
          tool_call_id: stringValue(block.tool_use_id) || "",
          tool_output: bodyFromContent(block.content).slice(0, 8000),
          timestamp: msgTs,
        });
      }
      blockIndex += 1;
    }
  }
}

function convertHarborAtifRows(
  rows: Record<string, any>[],
  source: string,
  root: Record<string, any> = {},
): Record<string, Json>[] {
  const steps: Record<string, Json>[] = [];
  const agent = asPlainObject(root.agent) || {};
  const defaultModel = stringValue(agent.model_name);

  for (const [index, row] of rows.entries()) {
    const sourceRole = stringValue(row.source) || stringValue(row.role);
    const hasAtifShape = Boolean(sourceRole || row.message !== undefined || row.text !== undefined || row.tool_calls || row.toolCalls || row.observation || row.metrics || row.tokens);
    if (!hasAtifShape) continue;

    const timestamp = timestampValue(row.timestamp) || "";
    const modelId = stringValue(row.model_name) || defaultModel;
    const metrics = metricsSignals(asPlainObject(row.metrics) || asPlainObject(row.tokens), modelId);
    const message = bodyFromContent(row.message ?? row.content ?? row.text).trim();
    const reasoning = stringValue(row.reasoning_content) || stringValue(row.reasoning);
    const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : Array.isArray(row.toolCalls) ? row.toolCalls : [];
    const observation = asPlainObject(row.observation);
    const observationResults = Array.isArray(observation?.results) ? observation?.results : [];
    const observationText = typeof row.observation === "string" ? row.observation : bodyFromContent(row.observation_text ?? row.tool_output).trim();
    const role = sourceRole || (toolCalls.length ? "agent" : "user");

    if (role !== "agent") {
      const body = message || contentTextFromRow(row);
      if (body) {
        steps.push({
          step_type: "observation",
          type: "observation",
          step_id: stableStepId("obs", source, index),
          step_order: steps.length + 1,
          title: role,
          body: body.slice(0, 8000),
          timestamp,
        });
      }
      continue;
    }

    const thoughtBody = [
      reasoning ? `[reasoning]\n${reasoning}` : "",
      message,
    ].filter(Boolean).join("\n\n").trim();
    let metricsAttached = false;
    if (thoughtBody || (!toolCalls.length && !observationResults.length)) {
      const step: Record<string, Json> = {
        step_type: "thought",
        type: "thought",
        step_id: stableStepId("thought", source, index),
        step_order: steps.length + 1,
        title: "agent",
        body: (thoughtBody || "(agent step)").slice(0, 8000),
        timestamp,
      };
      attachResourceSignals(step, modelId, metrics.tokensIn, metrics.tokensOut, metrics.costUsd);
      metricsAttached = true;
      steps.push(step);
    }

    for (const [toolIndex, toolRaw] of toolCalls.entries()) {
      const tool = asPlainObject(toolRaw);
      if (!tool) continue;
      const id = stringValue(tool.tool_call_id) || stringValue(tool.id) || stableStepId("tool", source, index * 1000 + toolIndex);
      const rawArgs = asPlainObject(tool.arguments) || tool.arguments || asPlainObject(tool.args) || tool.args || {};
      const step: Record<string, Json> = {
        step_type: "tool_call",
        type: "tool_call",
        step_id: stableStepId("tc", source, index * 1000 + toolIndex),
        step_order: steps.length + 1,
        tool_call_id: id,
        tool_name: stringValue(tool.function_name) || stringValue(tool.name) || "unknown",
        tool_args: jsonValue(rawArgs),
        timestamp,
      };
      if (!metricsAttached) {
        attachResourceSignals(step, modelId, metrics.tokensIn, metrics.tokensOut, metrics.costUsd);
        metricsAttached = true;
      }
      steps.push(step);
    }

    if (observationText && toolCalls.length) {
      const firstTool = asPlainObject(toolCalls[0]);
      steps.push({
        step_type: "tool_result",
        type: "tool_result",
        step_id: stableStepId("tr", source, index * 1000),
        step_order: steps.length + 1,
        tool_call_id: firstTool
          ? stringValue(firstTool.tool_call_id) || stringValue(firstTool.id) || stableStepId("tool", source, index * 1000)
          : stableStepId("tool", source, index * 1000),
        tool_output: observationText.slice(0, 8000),
        timestamp,
      });
    }

    for (const [resultIndex, resultRaw] of observationResults.entries()) {
      const result = asPlainObject(resultRaw);
      if (!result) continue;
      const output = bodyFromContent(result.content).slice(0, 8000);
      if (!output) continue;
      steps.push({
        step_type: "tool_result",
        type: "tool_result",
        step_id: stableStepId("tr", source, index * 1000 + resultIndex),
        step_order: steps.length + 1,
        tool_call_id: stringValue(result.source_call_id) || "",
        tool_output: output,
        timestamp,
      });
    }
  }

  return steps;
}

function convertNativeTrajectoryRows(rows: Record<string, any>[], source: string): Record<string, Json>[] {
  const steps: Record<string, Json>[] = [];
  let modelId: string | undefined;
  for (const [index, row] of rows.entries()) {
    const recordType = stringValue(row.type) || "";
    const timestamp = timestampValue(row.ts) || timestampValue(row.timestamp) || utcNow();
    const data = asPlainObject(row.data) || {};
    modelId = modelId || stringValue(row.modelId) || stringValue(data.modelId) || stringValue(data.model);

    if (recordType === "prompt.submitted") {
      const prompt = stringValue(data.prompt)?.trim();
      if (prompt) {
        steps.push({
          step_type: "observation",
          type: "observation",
          step_id: stableStepId("obs", source, index),
          step_order: steps.length + 1,
          timestamp,
          body: `[user prompt] ${prompt.slice(0, 8000)}`,
        });
      }
      continue;
    }

    if (recordType === "model.completed") {
      const usage = asPlainObject(data.usage) || {};
      const tokensIn = numberValue(usage.input ?? usage.input_tokens ?? usage.prompt_tokens);
      const tokensOut = numberValue(usage.output ?? usage.output_tokens ?? usage.completion_tokens);
      const texts = Array.isArray(data.assistantTexts) ? data.assistantTexts : [];
      let usedUsage = false;
      for (const textRaw of texts) {
        const text = String(textRaw || "").trim();
        if (!text) continue;
        const step: Record<string, Json> = {
          step_type: "thought",
          type: "thought",
          step_id: stableStepId("thought", source, index + steps.length),
          step_order: steps.length + 1,
          timestamp,
          body: text.slice(0, 8000),
        };
        if (modelId) step.model_id = modelId;
        if (!usedUsage && (tokensIn || tokensOut)) {
          step.tokens_in = tokensIn;
          step.tokens_out = tokensOut;
          step.cost_usd = estimateCostUsd(modelId, tokensIn, tokensOut);
          usedUsage = true;
        }
        steps.push(step);
      }
      if (texts.length === 0 && (tokensIn || tokensOut)) {
        steps.push({
          step_type: "thought",
          type: "thought",
          step_id: stableStepId("thought", source, index),
          step_order: steps.length + 1,
          timestamp,
          body: "(no assistant text)",
          model_id: modelId || "",
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_usd: estimateCostUsd(modelId, tokensIn, tokensOut),
        });
      }
      appendToolBlocks(steps, data.messagesSnapshot, timestamp, source, index * 1000);
      if (data.aborted || data.timedOut || data.idleTimedOut) {
        steps.push({
          step_type: "error",
          type: "error",
          step_id: stableStepId("err", source, index),
          step_order: steps.length + 1,
          timestamp,
          body: `model run failed: aborted=${Boolean(data.aborted)} timedOut=${Boolean(data.timedOut)} idleTimedOut=${Boolean(data.idleTimedOut)}`,
        });
      }
      continue;
    }

    if (recordType === "session.ended" && data.status && data.status !== "success") {
      steps.push({
        step_type: "error",
        type: "error",
        step_id: stableStepId("err", source, index),
        step_order: steps.length + 1,
        timestamp,
        body: `session ended with status=${String(data.status)}`,
      });
    }
  }
  return steps;
}

function opencodeEventLike(rows: Record<string, any>[]): boolean {
  return rows.some((row) => ["step_start", "step_finish", "text", "tool_use", "error"].includes(stringValue(row.type) || ""));
}

function convertOpenCodeEvents(rows: Record<string, any>[], source: string): Record<string, Json>[] {
  const steps: Record<string, Json>[] = [];
  const turns: { timestamp: string; parts: Record<string, any>[]; finish?: Record<string, any> }[] = [];
  let current: { timestamp: string; parts: Record<string, any>[]; finish?: Record<string, any> } | undefined;

  for (const [index, row] of rows.entries()) {
    const type = stringValue(row.type) || "";
    const timestamp = timestampValue(row.timestamp) || timestampValue(row.ts) || utcNow();
    if (type === "step_start") {
      current = { timestamp, parts: [] };
      continue;
    }
    if (type === "step_finish") {
      if (current) {
        current.finish = asPlainObject(row.part) || {};
        turns.push(current);
        current = undefined;
      }
      continue;
    }
    if (current && (type === "text" || type === "tool_use")) {
      current.parts.push(asPlainObject(row.part) || row);
      continue;
    }
    if (!current && (type === "text" || type === "tool_use")) {
      turns.push({ timestamp, parts: [asPlainObject(row.part) || row] });
      continue;
    }
    if (type === "error") {
      steps.push({
        step_type: "error",
        type: "error",
        step_id: stableStepId("err", source, index),
        step_order: steps.length + 1,
        body: bodyFromContent(row.error ?? row.message ?? row.part ?? row).slice(0, 8000),
        timestamp,
      });
    }
  }

  for (const [turnIndex, turn] of turns.entries()) {
    const finish = turn.finish || {};
    const tokens = asPlainObject(finish.tokens) || {};
    const cache = asPlainObject(tokens.cache) || {};
    const modelId = stringValue(finish.model) || stringValue(finish.modelID) || stringValue(finish.modelId);
    const tokensIn = numberValue(tokens.input) + numberValue(cache.read);
    const tokensOut = numberValue(tokens.output);
    const costUsd = numberValue(finish.cost) || estimateCostUsd(modelId, tokensIn, tokensOut);
    let metricsAttached = false;
    const textParts: string[] = [];

    for (const part of turn.parts) {
      if (stringValue(part.type) === "text" && stringValue(part.text)) {
        textParts.push(String(part.text).trim());
      }
    }

    const body = textParts.join("\n\n").trim();
    if (body) {
      const step: Record<string, Json> = {
        step_type: "thought",
        type: "thought",
        step_id: stableStepId("thought", source, turnIndex),
        step_order: steps.length + 1,
        body: body.slice(0, 8000),
        timestamp: turn.timestamp,
      };
      attachResourceSignals(step, modelId, tokensIn, tokensOut, costUsd);
      metricsAttached = true;
      steps.push(step);
    }

    for (const [partIndex, part] of turn.parts.entries()) {
      const type = stringValue(part.type);
      if (type === "text") continue;
      if (type !== "tool" && type !== "tool_use") continue;
      const state = asPlainObject(part.state) || {};
      const id = stringValue(part.callID) || stringValue(part.callId) || stringValue(part.id) || stableStepId("tool", source, turnIndex * 1000 + partIndex);
      const step: Record<string, Json> = {
        step_type: "tool_call",
        type: "tool_call",
        step_id: stableStepId("tc", source, turnIndex * 1000 + partIndex),
        step_order: steps.length + 1,
        tool_call_id: id,
        tool_name: stringValue(part.tool) || stringValue(part.name) || "unknown",
        tool_args: jsonValue(asPlainObject(state.input) || state.input || {}),
        timestamp: turn.timestamp,
      };
      if (!metricsAttached) {
        attachResourceSignals(step, modelId, tokensIn, tokensOut, costUsd);
        metricsAttached = true;
      }
      steps.push(step);
      if (state.output !== undefined) {
        steps.push({
          step_type: "tool_result",
          type: "tool_result",
          step_id: stableStepId("tr", source, turnIndex * 1000 + partIndex),
          step_order: steps.length + 1,
          tool_call_id: id,
          tool_output: bodyFromContent(state.output).slice(0, 8000),
          timestamp: turn.timestamp,
        });
      }
    }
  }

  return steps;
}

function openCodeExportLike(obj: Record<string, any>): boolean {
  const info = asPlainObject(obj.info);
  return Boolean(info && stringValue(info.id)?.startsWith("ses_") && Array.isArray(obj.messages));
}

function convertOpenCodeExport(obj: Record<string, any>, source: string): Record<string, Json>[] {
  const steps: Record<string, Json>[] = [];
  const messages = Array.isArray(obj.messages) ? obj.messages : [];

  for (const [messageIndex, messageRaw] of messages.entries()) {
    const message = asPlainObject(messageRaw);
    if (!message) continue;

    const info = asPlainObject(message.info) || {};
    const role = stringValue(info.role) || "unknown";
    const time = asPlainObject(info.time) || {};
    const created = numberValue(time.created);
    const timestamp = created ? isoNoMillis(created) : utcNow();
    const model = asPlainObject(info.model) || {};
    const modelId = stringValue(info.modelID) || stringValue(model.modelID) || stringValue(model.id);
    const providerId = stringValue(info.providerID) || stringValue(model.providerID);
    const fullModelId = providerId && modelId && !modelId.includes("/") ? `${providerId}/${modelId}` : modelId;
    const tokens = asPlainObject(info.tokens) || {};
    const cache = asPlainObject(tokens.cache) || {};
    const tokensIn = numberValue(tokens.input) + numberValue(cache.read);
    const tokensOut = numberValue(tokens.output) + numberValue(tokens.reasoning);
    const costUsd = numberValue(info.cost) || estimateCostUsd(fullModelId, tokensIn, tokensOut);
    const parts = Array.isArray(message.parts) ? message.parts : [];
    let metricsAttached = false;

    for (const [partIndex, partRaw] of parts.entries()) {
      const part = asPlainObject(partRaw);
      if (!part) continue;
      const type = stringValue(part.type) || "part";

      if (type === "step-start") continue;

      if (type === "tool") {
        const state = asPlainObject(part.state) || {};
        const id = stringValue(part.callID) || stringValue(part.callId) || stringValue(part.id) || stableStepId("tool", source, messageIndex * 1000 + partIndex);
        const callStep: Record<string, Json> = {
          step_type: "tool_call",
          type: "tool_call",
          step_id: stableStepId("tc", source, messageIndex * 1000 + partIndex),
          step_order: steps.length + 1,
          title: stringValue(state.title) || `${stringValue(part.tool) || "tool"} call`,
          tool_call_id: id,
          tool_name: stringValue(part.tool) || stringValue(part.name) || "unknown",
          tool_args: jsonValue(asPlainObject(state.input) || state.input || {}),
          timestamp,
        };
        if (!metricsAttached) {
          attachResourceSignals(callStep, fullModelId, tokensIn, tokensOut, costUsd);
          metricsAttached = true;
        }
        steps.push(callStep);

        if (state.output !== undefined) {
          steps.push({
            step_type: "tool_result",
            type: "tool_result",
            step_id: stableStepId("tr", source, messageIndex * 1000 + partIndex),
            step_order: steps.length + 1,
            title: `${stringValue(part.tool) || "tool"} result`,
            tool_call_id: id,
            tool_output: bodyFromContent(state.output).slice(0, 8000),
            timestamp,
          });
        }
        continue;
      }

      const text = bodyFromContent(part.text ?? part.content ?? part.summary ?? part).trim();
      if (!text) continue;
      const stepType = role === "assistant" || type === "reasoning" ? "thought" : "observation";
      const step: Record<string, Json> = {
        step_type: stepType,
        type: stepType,
        step_id: stableStepId(stepType, source, messageIndex * 1000 + partIndex),
        step_order: steps.length + 1,
        title: type === "reasoning" ? "assistant reasoning" : `${role} message`,
        body: text.slice(0, 8000),
        timestamp,
      };
      if (!metricsAttached) {
        attachResourceSignals(step, fullModelId, tokensIn, tokensOut, costUsd);
        metricsAttached = true;
      }
      steps.push(step);
    }

    if (!metricsAttached && (tokensIn || tokensOut)) {
      const step: Record<string, Json> = {
        step_type: "observation",
        type: "observation",
        step_id: stableStepId("usage", source, messageIndex),
        step_order: steps.length + 1,
        title: `${role} message token usage`,
        body: "(no exportable message parts)",
        timestamp,
      };
      attachResourceSignals(step, fullModelId, tokensIn, tokensOut, costUsd);
      steps.push(step);
    }
  }

  return steps;
}

function claudeCodeEventLike(rows: Record<string, any>[]): boolean {
  return rows.some((row) => ["assistant", "user", "system"].includes(stringValue(row.type) || "") && asPlainObject(row.message));
}

function extractClaudeContent(content: unknown): { text: string; reasoning: string; toolUses: Record<string, any>[]; toolResults: Record<string, any>[] } {
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const toolUses: Record<string, any>[] = [];
  const toolResults: Record<string, any>[] = [];
  if (typeof content === "string") {
    textParts.push(content);
  } else if (Array.isArray(content)) {
    for (const raw of content) {
      const block = asPlainObject(raw);
      if (!block) {
        textParts.push(String(raw));
        continue;
      }
      const type = stringValue(block.type);
      if (type === "tool_use") toolUses.push(block);
      else if (type === "tool_result") toolResults.push(block);
      else if (["thinking", "reasoning", "analysis"].includes(type || "")) reasoningParts.push(bodyFromContent(block.text ?? block.thinking));
      else textParts.push(bodyFromContent(block.text ?? block.content ?? block));
    }
  } else if (content !== undefined && content !== null) {
    textParts.push(bodyFromContent(content));
  }
  return {
    text: textParts.map((part) => part.trim()).filter(Boolean).join("\n\n"),
    reasoning: reasoningParts.map((part) => part.trim()).filter(Boolean).join("\n\n"),
    toolUses,
    toolResults,
  };
}

function convertClaudeCodeEvents(rows: Record<string, any>[], source: string): Record<string, Json>[] {
  const steps: Record<string, Json>[] = [];
  const pendingTools = new Map<string, string>();
  const sorted = [...rows].sort((a, b) => String(a.timestamp || "").localeCompare(String(b.timestamp || "")));

  for (const [index, row] of sorted.entries()) {
    const eventType = stringValue(row.type) || "";
    const message = asPlainObject(row.message);
    if (!message) continue;
    const timestamp = timestampValue(row.timestamp) || utcNow();
    const role = stringValue(message.role) || eventType;
    const content = extractClaudeContent(message.content);
    const usage = asPlainObject(message.usage);
    const modelId = stringValue(message.model);
    const metrics = metricsSignals({
      prompt_tokens: numberValue(usage?.input_tokens) + numberValue(usage?.cache_read_input_tokens) + numberValue(usage?.cache_creation_input_tokens),
      completion_tokens: numberValue(usage?.output_tokens),
      cost_usd: usage?.cost_usd,
    }, modelId);
    let metricsAttached = false;

    if (eventType === "assistant") {
      const thoughtBody = [
        content.reasoning ? `[reasoning]\n${content.reasoning}` : "",
        content.text,
      ].filter(Boolean).join("\n\n").trim();
      if (thoughtBody || !content.toolUses.length) {
        const step: Record<string, Json> = {
          step_type: "thought",
          type: "thought",
          step_id: stableStepId("thought", source, index),
          step_order: steps.length + 1,
          body: (thoughtBody || "(assistant message)").slice(0, 8000),
          timestamp,
        };
        attachResourceSignals(step, modelId, metrics.tokensIn, metrics.tokensOut, metrics.costUsd);
        metricsAttached = true;
        steps.push(step);
      }
      for (const [toolIndex, tool] of content.toolUses.entries()) {
        const id = stringValue(tool.id) || stringValue(tool.tool_use_id) || stableStepId("tool", source, index * 1000 + toolIndex);
        pendingTools.set(id, stringValue(tool.name) || "unknown");
        const step: Record<string, Json> = {
          step_type: "tool_call",
          type: "tool_call",
          step_id: stableStepId("tc", source, index * 1000 + toolIndex),
          step_order: steps.length + 1,
          tool_call_id: id,
          tool_name: stringValue(tool.name) || "unknown",
          tool_args: jsonValue(asPlainObject(tool.input) || tool.input || {}),
          timestamp,
        };
        if (!metricsAttached) {
          attachResourceSignals(step, modelId, metrics.tokensIn, metrics.tokensOut, metrics.costUsd);
          metricsAttached = true;
        }
        steps.push(step);
      }
      continue;
    }

    for (const [resultIndex, result] of content.toolResults.entries()) {
      const id = stringValue(result.tool_use_id) || stringValue(result.id) || stableStepId("tool", source, index * 1000 + resultIndex);
      pendingTools.delete(id);
      const resultBody = bodyFromContent(result.content ?? row.toolUseResult ?? result).slice(0, 8000);
      steps.push({
        step_type: "tool_result",
        type: "tool_result",
        step_id: stableStepId("tr", source, index * 1000 + resultIndex),
        step_order: steps.length + 1,
        tool_call_id: id,
        tool_output: resultBody,
        timestamp,
      });
    }

    const text = content.text || (!content.toolResults.length ? bodyFromContent(message.content) : "");
    if (text.trim()) {
      steps.push({
        step_type: "observation",
        type: "observation",
        step_id: stableStepId("obs", source, index),
        step_order: steps.length + 1,
        title: role,
        body: text.slice(0, 8000),
        timestamp,
      });
    }
  }

  for (const [id, name] of pendingTools.entries()) {
    steps.push({
      step_type: "error",
      type: "error",
      step_id: stableStepId("err", source, steps.length + 1),
      step_order: steps.length + 1,
      tool_call_id: id,
      body: `Claude Code tool call ${name} (${id}) has no matching result in raw session log.`,
      timestamp: utcNow(),
    });
  }

  return steps;
}

function convertMessageRows(rows: Record<string, any>[], source: string): Record<string, Json>[] {
  const steps: Record<string, Json>[] = [];
  for (const [index, row] of rows.entries()) {
    const role = stringValue(row.role) || stringValue(row.source) || "message";
    const toolCalls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
    const stepType = toolCalls.length > 0 ? "tool_call" : role === "tool" ? "tool_result" : ["assistant", "agent"].includes(role) ? "thought" : "observation";
    steps.push({
      step_type: stepType,
      type: stepType,
      step_id: stableStepId(stepType, source, index),
      step_order: index + 1,
      title: toolCalls.length > 0 ? "tool call" : role,
      body: contentTextFromRow(row).slice(0, 8000),
      timestamp: timestampValue(row.timestamp) || timestampValue(row.created_at) || utcNow(),
      cost_usd: 0,
    });
  }
  return steps;
}

function codexEventLike(rows: Record<string, any>[]): boolean {
  return rows.some((row) => row.type === "thread.started")
    && rows.some((row) => row.type === "item.started" || row.type === "item.completed" || row.type === "turn.completed");
}

function convertCodexEvents(rows: Record<string, any>[], source: string): Record<string, Json>[] {
  const steps: Record<string, Json>[] = [];
  const pending = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const eventType = stringValue(row.type) || "event";
    const item = asPlainObject(row.item) || {};
    const itemType = stringValue(item.type) || "";
    const id = stringValue(item.id) || stableStepId("codex", source, index);
    const timestamp = timestampValue(row.timestamp) || utcNow();
    if (eventType === "item.started" && itemType === "command_execution") {
      pending.add(id);
      steps.push({ step_type: "tool_call", type: "tool_call", step_id: stableStepId("tc", source, index),
        step_order: steps.length + 1, tool_call_id: id, tool_name: "shell",
        tool_args: { command: stringValue(item.command) || "" }, timestamp });
    } else if (eventType === "item.completed" && itemType === "command_execution") {
      pending.delete(id);
      steps.push({ step_type: "tool_result", type: "tool_result", step_id: stableStepId("tr", source, index),
        step_order: steps.length + 1, tool_call_id: id,
        tool_output: stringValue(item.aggregated_output) || "", timestamp });
    } else if (eventType === "item.completed" && ["agent_message", "reasoning"].includes(itemType)) {
      steps.push({ step_type: "thought", type: "thought", step_id: stableStepId("thought", source, index),
        step_order: steps.length + 1, body: (stringValue(item.text) || stringValue(item.message) || bodyFromContent(item)).slice(0, 8000), timestamp });
    } else if (eventType === "item.completed" && itemType === "error") {
      steps.push({ step_type: "error", type: "error", step_id: stableStepId("err", source, index),
        step_order: steps.length + 1, body: (stringValue(item.message) || bodyFromContent(item)).slice(0, 8000), timestamp });
    }
  }
  for (const id of pending) {
    steps.push({ step_type: "error", type: "error", step_id: stableStepId("err", source, steps.length),
      step_order: steps.length + 1, tool_call_id: id, body: `Codex command ${id} has no result at capture time.`, timestamp: utcNow() });
  }
  return steps;
}

function parseTraceSteps(text: string, source = "trace"): Record<string, Json>[] {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      const rows = parsed.map((item) => asPlainObject(item)).filter((item): item is Record<string, any> => Boolean(item));
      const normalized = normalizeArmSteps(rows);
      if (normalized.length) return normalized;
    }
    const obj = asPlainObject(parsed);
    if (obj && openCodeExportLike(obj)) {
      const exported = convertOpenCodeExport(obj, source);
      if (exported.length) return exported;
    }
    if (obj && Array.isArray(obj.steps)) {
      const rows = obj.steps.map((item: unknown) => asPlainObject(item)).filter((item: unknown): item is Record<string, any> => Boolean(item));
      const normalized = normalizeArmSteps(rows);
      if (normalized.length) return normalized;
      const harborAtif = convertHarborAtifRows(rows, source, obj);
      if (harborAtif.length) return harborAtif;
      if (rows.some((row) => row.role || row.source || row.content || row.text || row.message)) return convertMessageRows(rows, source);
    }
  } catch {
    // Most native traces are JSONL, not a single JSON document.
  }

  const rows = objectRowsFromJsonl(text);
  if (!rows.length) return [];
  const normalized = normalizeArmSteps(rows);
  if (normalized.length >= Math.max(1, Math.floor(rows.length * 0.8))) return normalized;
  if (opencodeEventLike(rows)) return convertOpenCodeEvents(rows, source);
  if (claudeCodeEventLike(rows)) return convertClaudeCodeEvents(rows, source);
  if (codexEventLike(rows)) return convertCodexEvents(rows, source);
  if (nativeTraceLike(rows)) return convertNativeTrajectoryRows(rows, source);
  if (rows.some((row) => row.role || row.source || row.content)) return convertMessageRows(rows, source);
  return [];
}

function validateTraceSteps(steps: Record<string, Json>[]): Record<string, Json> {
  const failures: string[] = [];
  const warnings: string[] = [];
  const byType: Record<string, number> = {};
  const calls = new Set<string>();
  const results = new Set<string>();
  const timestamps: string[] = [];
  const ids: string[] = [];
  let totalCost = 0;
  let totalTokens = 0;
  let longThoughts = 0;
  let badTypes = 0;

  for (const step of steps) {
    const stepType = String(step.step_type || step.type || "");
    byType[stepType] = (byType[stepType] || 0) + 1;
    if (!ARM_STEP_TYPES.has(stepType)) badTypes += 1;
    if (stepType === "tool_call" && step.tool_call_id) calls.add(String(step.tool_call_id));
    if (stepType === "tool_result" && step.tool_call_id) results.add(String(step.tool_call_id));
    if (step.timestamp) timestamps.push(String(step.timestamp));
    if (step.step_id) ids.push(String(step.step_id));
    const cost = numberValue(step.cost_usd);
    const tokensIn = numberValue(step.tokens_in);
    const tokensOut = numberValue(step.tokens_out);
    totalCost += cost;
    totalTokens += tokensIn + tokensOut;
    if (stepType === "thought" && String(step.body || "").length >= 80) longThoughts += 1;
  }

  const unpaired = [...calls].filter((id) => !results.has(id));
  const duplicateIds = ids.length - new Set(ids).size;
  const monotonic = timestamps.every((ts, index) => index === 0 || timestamps[index - 1] <= ts);
  if (!steps.length) failures.push("no_steps: trace is empty");
  if (badTypes) failures.push(`typed_step_type: ${badTypes} steps use invalid step_type`);
  if (unpaired.length) failures.push(`tool_call_pairing: ${unpaired.length} tool_calls lack matching tool_result`);
  if (totalCost < 0.01) failures.push(`cost_floor: total_cost_usd=${totalCost.toFixed(6)} < 0.01`);
  if (longThoughts < 3) failures.push(`thought_chain_thin: ${longThoughts} thoughts >=80 chars (need 3)`);
  if (!steps.some((step) => numberValue(step.cost_usd) > 0 || numberValue(step.tokens_in) > 0 || numberValue(step.tokens_out) > 0)) {
    failures.push("zero_resource_signals: every step has cost=0 and tokens=0");
  }
  if (!monotonic) failures.push("timestamp_monotonic: step timestamps not non-decreasing");
  if (duplicateIds) failures.push(`step_id_unique: ${duplicateIds} duplicate step_id values`);
  warnings.push("timestamp_window/artifact_existence/stdout_anchor need bundle context and are not checked here.");
  return {
    total_steps: steps.length,
    by_type: byType,
    paired_tool_calls: `${[...calls].filter((id) => results.has(id)).length}/${calls.size}`,
    total_cost_usd: Number(totalCost.toFixed(6)),
    total_tokens: totalTokens,
    failures,
    warnings,
    valid: failures.length === 0,
  };
}

async function readJsonFile<T = Record<string, Json>>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

async function writeJsonFile(file: string, data: Json): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function loadConfig(opts: Record<string, OptValue>): Promise<Record<string, Json>> {
  const configPath = opt(opts, "config") || DEFAULT_CONFIG_PATH;
  if (!(await exists(configPath))) return {};
  return readJsonFile(configPath);
}

async function saveConfig(configPath: string, data: Record<string, Json>): Promise<void> {
  await writeJsonFile(configPath, data);
}

async function runProcess(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer | string) => stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer | string) => stderr.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new CliError(`missing Playground data helper '${file}'. Install with: curl -fsSL ${DEFAULT_TRISOL_INSTALLER} | bash`));
        return;
      }
      reject(error);
    });
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (code === 0) {
        resolve({ stdout: out, stderr: err });
        return;
      }
      reject(new CliError(`${file} ${args.join(" ")} failed with exit ${code}\n${err || out}`.trim()));
    });
  });
}

function trisolBin(opts: Record<string, OptValue>): string {
  return opt(opts, "trisol-bin") || process.env.PLAYGROUND_TRISOL_BIN || "trisol";
}

function trisolGlobalArgs(opts: Record<string, OptValue>): string[] {
  const args = ["--no-input"];
  if (!flag(opts, "trisol-verbose")) args.push("--quiet");
  const profile = opt(opts, "trisol-profile") || process.env.PLAYGROUND_TRISOL_PROFILE;
  const server = opt(opts, "trisol-server") || process.env.PLAYGROUND_TRISOL_SERVER;
  const team = opt(opts, "trisol-team") || process.env.PLAYGROUND_TRISOL_TEAM || DEFAULT_TRISOL_TEAM;
  if (profile) args.push("--profile", profile);
  if (server) args.push("--server", server);
  if (team) args.push("--team", team);
  return args;
}

function trisolEnv(): NodeJS.ProcessEnv {
  return {
    TRISOL_TOKEN: process.env.TRISOL_TOKEN || EMBEDDED_TRISOL_TOKEN,
  };
}

function trisolError(error: unknown): CliError {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|unauthenticated|E_AUTH|not authenticated/i.test(message)) {
    return new CliError([
      "Playground dataset access is not authenticated.",
      "The CLI uses built-in dataset credentials by default; if this persists, ask the Playground operator to refresh them.",
      "",
      message,
    ].join("\n"));
  }
  const sanitized = message
    .replace(/trisol\s+--no-input\s+--quiet\s+--team\s+\S+\s+/g, "playground data helper ")
    .replace(/--team\s+\S+\s+/g, "");
  if (error instanceof CliError) return new CliError(sanitized, error.exitCode);
  if (error instanceof Error) return new CliError(sanitized);
  return new CliError(sanitized);
}

async function runTrisol(opts: Record<string, OptValue>, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    return await runProcess(trisolBin(opts), [...trisolGlobalArgs(opts), ...args], { env: trisolEnv() });
  } catch (error) {
    throw trisolError(error);
  }
}

async function installTrisol(opts: Record<string, OptValue>): Promise<void> {
  const installer = opt(opts, "trisol-installer") || DEFAULT_TRISOL_INSTALLER;
  await runProcess("bash", ["-lc", `curl -fsSL ${JSON.stringify(installer)} | bash`]);
}

function parseJsonOutput<T = unknown>(stdout: string, command: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new CliError(`${command} did not return JSON:\n${stdout.slice(0, 2000)}`);
  }
}

function targetName(opts: Record<string, OptValue>, config: Record<string, Json>): string {
  return opt(opts, "target") || String(config.defaultTarget || process.env.PLAYGROUND_TARGET || "play");
}

function apiBase(opts: Record<string, OptValue>, config: Record<string, Json>): string {
  if (opt(opts, "api-base")) return required(opts, "api-base").replace(/\/+$/, "");
  const target = targetName(opts, config);
  if (target === "worker") {
    return String(config.workerApiBase || process.env.PLAYGROUND_WORKER_API_BASE || DEFAULT_WORKER_API).replace(/\/+$/, "");
  }
  return String(config.apiBase || process.env.PLAYGROUND_API_BASE || DEFAULT_PLAY_API).replace(/\/+$/, "");
}

function publicBaseFromApi(base: string): string {
  return base.replace(/\/api\/?$/, "");
}

function bearerToken(opts: Record<string, OptValue>, config: Record<string, Json>): string | undefined {
  const explicitEnv = opt(opts, "token-env");
  if (explicitEnv) return process.env[explicitEnv];
  const target = targetName(opts, config);
  const configured = target === "worker" ? config.workerTokenEnv : config.tokenEnv;
  if (typeof configured === "string" && process.env[configured]) return process.env[configured];
  if (target === "worker") return process.env.PLAYGROUND_WORKER_TOKEN || process.env.PLAYGROUND_TOKEN;
  return process.env.PLAYGROUND_TOKEN;
}

async function requestJson<T = Record<string, Json>>(
  url: string,
  init: RequestInit = {},
  token?: string,
): Promise<T> {
  const headers = new Headers(init.headers || {});
  headers.set("Accept", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers });
  const text = await response.text();
  if (!response.ok) {
    throw new CliError(`HTTP ${response.status} ${response.statusText}: ${text}`);
  }
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { raw: text } as T;
  }
}

function challengeRowsFromPayload(payload: unknown): Record<string, any>[] {
  const rowsFromArray = (items: unknown[]): Record<string, any>[] =>
    items.map(asPlainObject).filter((row): row is Record<string, any> => Boolean(row && row.id));

  if (Array.isArray(payload)) return rowsFromArray(payload);

  const obj = asPlainObject(payload);
  if (!obj) return [];

  for (const key of ["challenges", "tasks", "items", "data"]) {
    const value = obj[key];
    if (Array.isArray(value)) return rowsFromArray(value);
    const dict = asPlainObject(value);
    if (dict) {
      return Object.entries(dict)
        .map(([id, row]) => ({ ...(asPlainObject(row) || {}), id: stringValue((row as any)?.id) || id }))
        .filter((row) => Boolean(row.id));
    }
  }

  return Object.entries(obj)
    .map(([id, row]) => ({ ...(asPlainObject(row) || {}), id: stringValue((row as any)?.id) || id }))
    .filter((row) => Boolean(row.id));
}

function tagsFromRow(row: Record<string, any>): string[] {
  const rawTags = Array.isArray(row.tags) ? row.tags : [];
  const tags = rawTags
    .map((tag) => String(tag).trim())
    .filter(Boolean);
  const origin = stringValue(row.origin);
  const journal = stringValue(row.journal);
  if (origin) tags.push(origin);
  if (journal && journal.toLowerCase().includes("harbor")) tags.push("harbor");
  if (String(row.id || "").toLowerCase().startsWith("harbor-")) tags.push("harbor");
  return Array.from(new Set(tags));
}

function matchesTagFilter(row: Record<string, any>, wantedTags: string[]): boolean {
  if (wantedTags.length === 0) return true;
  const tags = tagsFromRow(row).map((tag) => tag.toLowerCase());
  return wantedTags.every((wanted) => {
    const needle = wanted.toLowerCase();
    return tags.some((tag) => tag === needle || tag.includes(needle));
  });
}

async function fetchChallengeRows(base: string, token?: string): Promise<Record<string, any>[]> {
  const urls = [
    `${base}/challenges`,
    `${publicBaseFromApi(base)}/data/challenges.json`,
  ];
  const errors: string[] = [];
  for (const url of urls) {
    try {
      const payload = await requestJson<unknown>(url, {}, token);
      const rows = challengeRowsFromPayload(payload);
      if (rows.length > 0) return rows;
      errors.push(`${url}: empty challenge list`);
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new CliError(`Could not load challenge list.\n${errors.join("\n")}`);
}

async function resolveChallengeId(base: string, token: string | undefined, input: string): Promise<string> {
  if (!/^\d+$/.test(input)) return input;
  const index = Number(input);
  if (!Number.isSafeInteger(index) || index < 1) return input;
  const rows = await fetchChallengeRows(base, token);
  const row = rows[index - 1];
  if (!row || !stringValue(row.id)) {
    throw new CliError(`No challenge at numeric index ${input}. Run 'playground task list --limit 20' to see available challenge ids.`);
  }
  return String(row.id);
}

function encodeMultipart(
  fields: Record<string, string | undefined>,
  files: MultipartFile[],
): { body: Buffer; contentType: string } {
  const boundary = `----playground-cli-ts-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  const line = (value: string) => chunks.push(Buffer.from(`${value}\r\n`, "utf8"));
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    line(`--${boundary}`);
    line(`Content-Disposition: form-data; name="${name}"`);
    line("");
    line(value);
  }
  for (const file of files) {
    line(`--${boundary}`);
    line(`Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"`);
    line(`Content-Type: ${file.contentType}`);
    line("");
    chunks.push(file.data);
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  line(`--${boundary}--`);
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function postMultipartJson<T = Record<string, Json>>(
  url: string,
  fields: Record<string, string | undefined>,
  files: MultipartFile[],
  token?: string,
): Promise<T> {
  const { body, contentType } = encodeMultipart(fields, files);
  return requestJson<T>(
    url,
    {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: body as unknown as BodyInit,
    },
    token,
  );
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const stat = await fs.stat(current);
    if (stat.isFile()) {
      out.push(current);
      return;
    }
    if (!stat.isDirectory()) return;
    const entries = await fs.readdir(current);
    for (const entry of entries) {
      if ([".git", "node_modules", "__pycache__", ".venv", "venv"].includes(entry)) continue;
      await walk(path.join(current, entry));
    }
  }
  await walk(root);
  return out.sort();
}

async function copyPath(src: string, dest: string): Promise<void> {
  const stat = await fs.stat(src);
  if (stat.isDirectory()) {
    const files = await listFiles(src);
    for (const file of files) {
      const rel = path.relative(src, file);
      await copyPath(file, path.join(dest, rel));
    }
    return;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.copyFile(src, dest);
}

async function scanForSecrets(paths: string[]): Promise<string[]> {
  const hits: string[] = [];
  for (const root of paths) {
    if (!root) continue;
    const files = await listFiles(root);
    for (const file of files) {
      const stat = await fs.stat(file);
      if (stat.size > 2 * 1024 * 1024) continue;
      const buf = await fs.readFile(file);
      if (buf.includes(0)) continue;
      const text = buf.toString("utf8");
      if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) hits.push(file);
    }
  }
  return hits;
}

function slugify(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "harbor-task";
}

function parseTags(raw?: string): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    const data = JSON.parse(trimmed);
    if (!Array.isArray(data)) throw new CliError("--tags JSON must be an array");
    return data.map(String).filter(Boolean);
  }
  return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseExpectedOutputs(values: string[]): Record<string, Json>[] {
  if (values.length === 0) {
    return [{ path: "outputs/*", description: "Scored Harbor output artifacts", required: true }];
  }
  return values.map((item) => {
    const [outputPath, description = "Scored Harbor output artifact"] = item.split(":", 2);
    return { path: outputPath, description, required: true };
  });
}

function parseDatasetOption(raw: string): TrisolDatasetRef {
  const parts = raw.split(":");
  if (parts.length < 2) {
    throw new CliError("--dataset must be DATASET:VERSION or DATASET:VERSION:SPLIT[:PATH]");
  }
  const [dataset, version, split, ...pathParts] = parts;
  if (!dataset || !version) {
    throw new CliError("--dataset must include non-empty DATASET and VERSION");
  }
  return {
    dataset,
    version,
    split: split || undefined,
    path: pathParts.length ? pathParts.join(":") : undefined,
  };
}

function parseDatasetOptions(values: string[]): TrisolDatasetRef[] {
  return values.map(parseDatasetOption);
}

function datasetRefFromObject(obj: Record<string, any>): TrisolDatasetRef[] {
  const dataset = stringValue(obj.dataset)
    || stringValue(obj.dataset_id)
    || stringValue(obj.datasetId)
    || stringValue(obj.id)
    || stringValue(obj.name);
  const version = stringValue(obj.version)
    || stringValue(obj.version_code)
    || stringValue(obj.versionCode)
    || stringValue(obj.version_name)
    || stringValue(obj.versionName);
  const rawSplit = obj.split ?? obj.splits ?? obj.file ?? obj.files;
  const pathValue = stringValue(obj.path)
    || stringValue(obj.local_path)
    || stringValue(obj.localPath)
    || stringValue(obj.output);
  if (!dataset || !version) return [];
  const split = Array.isArray(rawSplit)
    ? stringValue(rawSplit[0])
    : stringValue(rawSplit);
  return [{ dataset, version, split, path: pathValue }];
}

function collectDatasetRefs(value: unknown): TrisolDatasetRef[] {
  if (typeof value === "string" && value.trim()) {
    const parts = value.split(":");
    return [{ dataset: parts[0], version: parts[1] || undefined }];
  }
  if (Array.isArray(value)) return value.flatMap(collectDatasetRefs);
  const obj = asPlainObject(value);
  if (!obj) return [];
  const direct = datasetRefFromObject(obj);
  if (direct.length) return direct;
  const nested = ["dataset", "datasets", "data", "resources", "assets"]
    .filter((key) => obj[key] !== value)
    .flatMap((key) => collectDatasetRefs(obj[key]));
  return [...direct, ...nested];
}

function datasetRefsFromChallenge(challenge: Record<string, any>): TrisolDatasetRef[] {
  const config = configFromChallenge(challenge) || BUILTIN_TASK_CONFIGS[stringValue(challenge.id) || ""];
  const configRefs = [
    ...collectDatasetRefs(config?.datasets),
    ...collectDatasetRefs(config?.dataset),
    ...collectDatasetRefs(asPlainObject(config?.trisol)?.datasets),
    ...collectDatasetRefs(asPlainObject(config?.trisol)?.dataset),
  ];
  const refs = configRefs.length ? configRefs : [
    ...collectDatasetRefs(challenge.datasets),
    ...collectDatasetRefs(challenge.dataset),
    ...collectDatasetRefs(challenge.data),
    ...collectDatasetRefs(asPlainObject(challenge.meta)?.datasets),
    ...collectDatasetRefs(asPlainObject(challenge.meta)?.dataset),
    ...collectDatasetRefs(asPlainObject(challenge.meta)?.resources),
  ];
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.dataset}\u0000${ref.version}\u0000${ref.path || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function modelRefFromObject(obj: Record<string, any>): TrisolModelRef[] {
  const model = stringValue(obj.model)
    || stringValue(obj.model_id)
    || stringValue(obj.modelId)
    || stringValue(obj.id)
    || stringValue(obj.name);
  const version = stringValue(obj.version)
    || stringValue(obj.version_code)
    || stringValue(obj.versionCode)
    || stringValue(obj.version_name)
    || stringValue(obj.versionName);
  const output = stringValue(obj.path) || stringValue(obj.output) || stringValue(obj.local_path);
  return model ? [{ model, version, path: output }] : [];
}

function collectModelRefs(value: unknown): TrisolModelRef[] {
  if (typeof value === "string" && value.trim()) {
    const index = value.lastIndexOf(":");
    return index > 0
      ? [{ model: value.slice(0, index), version: value.slice(index + 1) }]
      : [{ model: value }];
  }
  if (Array.isArray(value)) return value.flatMap(collectModelRefs);
  const obj = asPlainObject(value);
  if (!obj) return [];
  const direct = modelRefFromObject(obj);
  if (direct.length) return direct;
  const nested = ["model", "models", "weights", "checkpoints", "resources", "assets"]
    .filter((key) => obj[key] !== value)
    .flatMap((key) => collectModelRefs(obj[key]));
  return [...direct, ...nested];
}

function configFromChallenge(challenge: Record<string, any>): Record<string, any> | undefined {
  const candidates = [
    challenge.config,
    challenge.config_json,
    challenge.configJson,
    challenge.task_config,
    challenge.taskConfig,
    asPlainObject(challenge.meta)?.config,
    asPlainObject(challenge.metadata)?.config,
  ];
  for (const candidate of candidates) {
    const obj = asPlainObject(candidate);
    if (obj) return obj;
    if (typeof candidate === "string" && candidate.trim().startsWith("{")) {
      try {
        const parsed = JSON.parse(candidate);
        const parsedObj = asPlainObject(parsed);
        if (parsedObj) return parsedObj;
      } catch {
        // Keep looking; malformed optional config should not hide other sources.
      }
    }
  }
  return undefined;
}

function modelRefsFromChallenge(challenge: Record<string, any>): TrisolModelRef[] {
  const config = configFromChallenge(challenge) || BUILTIN_TASK_CONFIGS[stringValue(challenge.id) || ""];
  const refs = [
    ...collectModelRefs(challenge.models),
    ...collectModelRefs(challenge.model),
    ...collectModelRefs(asPlainObject(challenge.meta)?.models),
    ...collectModelRefs(asPlainObject(challenge.meta)?.model),
    ...collectModelRefs(config?.models),
    ...collectModelRefs(config?.model),
    ...collectModelRefs(asPlainObject(config?.trisol)?.models),
    ...collectModelRefs(asPlainObject(config?.trisol)?.model),
  ];
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.model}\u0000${ref.version || ""}\u0000${ref.path || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface TrisolDatasetFile {
  split: string;
  output: string;
  size_bytes?: number;
}

function versionCandidateValues(obj: Record<string, any>): string[] {
  return [
    stringValue(obj.version_name),
    stringValue(obj.versionName),
    stringValue(obj.name),
    stringValue(obj.version),
    obj.version_code === undefined ? undefined : String(obj.version_code),
    obj.versionCode === undefined ? undefined : String(obj.versionCode),
  ].filter(Boolean) as string[];
}

function splitNameFromObject(obj: Record<string, any>): string | undefined {
  return stringValue(obj.split_name)
    || stringValue(obj.splitName)
    || stringValue(obj.name)
    || stringValue(obj.file)
    || stringValue(obj.filename)
    || stringValue(obj.path);
}

function splitSizeFromObject(obj: Record<string, any>): number | undefined {
  const size = numberValue(obj.size_bytes ?? obj.sizeBytes ?? obj.size);
  return size > 0 ? size : undefined;
}

function collectVersionSplits(versionObj: Record<string, any>): { split: string; size_bytes?: number }[] {
  const rawSplits = versionObj.splits ?? versionObj.files ?? versionObj.assets;
  if (!Array.isArray(rawSplits)) return [];
  return rawSplits
    .map((item) => {
      if (typeof item === "string") return { split: item };
      const obj = asPlainObject(item);
      if (!obj) return undefined;
      const split = splitNameFromObject(obj);
      if (!split) return undefined;
      return { split, size_bytes: splitSizeFromObject(obj) };
    })
    .filter(Boolean) as { split: string; size_bytes?: number }[];
}

function simplifyDatasetList(payload: unknown): Json {
  const obj = asPlainObject(payload);
  const rawItems = Array.isArray(obj?.items) ? obj.items : Array.isArray(payload) ? payload : [];
  const items = rawItems
    .map(asPlainObject)
    .filter(isPlainRecord)
    .map((item) => ({
      id: stringValue(item.id) || "",
      name: stringValue(item.name) || "",
      description: stringValue(item.description) || "",
      version_count: numberValue(item.version_count ?? item.versionCount),
      total_size_bytes: numberValue(item.total_size_bytes ?? item.totalSizeBytes),
      updated_at: stringValue(item.updated_at) || stringValue(item.updatedAt) || "",
    }));
  return {
    schema_version: "playground-data-list/v1",
    source: "playground-data",
    scope: "team-visible",
    items: items as Json,
    total: numberValue(obj?.total ?? items.length),
    count: items.length,
  };
}

function simplifyDatasetGet(payload: unknown, dataset: string): Json {
  const obj = asPlainObject(payload);
  if (!obj) return { schema_version: "playground-data-get/v1", source: "playground-data", dataset, payload: null };
  const versions = Array.isArray(obj.versions)
    ? obj.versions.map(asPlainObject).filter(isPlainRecord).map((versionObj) => ({
      version: versionCandidateValues(versionObj)[0] || "",
      status: stringValue(versionObj.status) || "",
      total_size_bytes: numberValue(versionObj.total_size_bytes ?? versionObj.totalSizeBytes),
      files: collectVersionSplits(versionObj).map((file) => ({
        name: file.split,
        size_bytes: file.size_bytes || 0,
      })) as unknown as Json,
    }))
    : [];
  return {
    schema_version: "playground-data-get/v1",
    source: "playground-data",
    dataset: stringValue(obj.name) || dataset,
    id: stringValue(obj.id) || "",
    description: stringValue(obj.description) || "",
    version_count: numberValue(obj.version_count ?? obj.versionCount ?? versions.length),
    total_size_bytes: numberValue(obj.total_size_bytes ?? obj.totalSizeBytes),
    versions: versions as unknown as Json,
  };
}

async function getTrisolDatasetPayload(opts: Record<string, OptValue>, dataset: string): Promise<unknown> {
  const { stdout } = await runTrisol(opts, ["dataset", "get", dataset, "--output", "json"]);
  return parseJsonOutput<unknown>(stdout, "trisol dataset get");
}

async function resolveTrisolDatasetSplits(
  opts: Record<string, OptValue>,
  ref: TrisolDatasetRef,
): Promise<{ version: string; splits: { split: string; size_bytes?: number }[] }> {
  const payload = await getTrisolDatasetPayload(opts, ref.dataset);
  const obj = asPlainObject(payload);
  const versions = Array.isArray(obj?.versions) ? obj.versions.map(asPlainObject).filter(isPlainRecord) : [];
  const readyVersions = versions.filter((item) => !stringValue(item.status) || /ready|complete|available/i.test(stringValue(item.status) || ""));
  const versionObj = ref.version
    ? versions.find((item) => versionCandidateValues(item).includes(ref.version as string))
    : readyVersions[0] || versions[0];
  if (!versionObj) {
    const available = versions.flatMap(versionCandidateValues).filter(Boolean).join(", ") || "(none)";
    throw new CliError(ref.version
      ? `dataset '${ref.dataset}' has no version '${ref.version}'. Available versions: ${available}`
      : `dataset '${ref.dataset}' has no downloadable version`);
  }
  const resolvedVersion = versionCandidateValues(versionObj)[0];
  if (!resolvedVersion) throw new CliError(`dataset '${ref.dataset}' version metadata has no usable version identifier`);
  if (ref.split && flag(opts, "split-only")) return { version: resolvedVersion, splits: [{ split: ref.split }] };
  const splits = collectVersionSplits(versionObj);
  if (splits.length === 0) {
    throw new CliError(`dataset '${ref.dataset}' version '${resolvedVersion}' has no downloadable files`);
  }
  return { version: resolvedVersion, splits };
}

async function downloadTrisolDataset(
  opts: Record<string, OptValue>,
  ref: TrisolDatasetRef,
  outPath: string,
  outputIsDirectory = false,
): Promise<{ dataset: string; version: string; output: string; files: TrisolDatasetFile[] }> {
  const resolved = await resolveTrisolDatasetSplits(opts, ref);
  const { splits } = resolved;
  const wholeVersion = splits.length !== 1 || !ref.split || !flag(opts, "split-only");
  const useDirectory = outputIsDirectory || wholeVersion;
  if (useDirectory) {
    await fs.mkdir(outPath, { recursive: true });
  } else {
    await fs.mkdir(path.dirname(outPath), { recursive: true });
  }
  const files: TrisolDatasetFile[] = [];
  const trisolOutput = useDirectory && !outPath.endsWith(path.sep) ? `${outPath}${path.sep}` : outPath;
  for (const split of splits) {
    if (!flag(opts, "dry-run")) {
      await runTrisol(opts, [
        "dataset",
        "download",
        ref.dataset,
        resolved.version,
        split.split,
        "--output",
        trisolOutput,
      ]);
    }
    files.push({
      split: split.split,
      output: useDirectory ? path.join(outPath, split.split) : outPath,
      size_bytes: split.size_bytes,
    });
  }
  return { dataset: ref.dataset, version: resolved.version, output: outPath, files };
}

async function downloadTrisolModel(
  opts: Record<string, OptValue>,
  ref: TrisolModelRef,
  outPath: string,
): Promise<{ model: string; version: string; output: string }> {
  await fs.mkdir(outPath, { recursive: true });
  const modelRef = ref.version ? `${ref.model}:${ref.version}` : `${ref.model}:latest`;
  if (!flag(opts, "dry-run")) {
    await runTrisol(opts, ["model", "download", modelRef, "--output", `${outPath}${path.sep}`]);
  }
  return { model: ref.model, version: ref.version || "latest", output: outPath };
}

function parseTomlStringField(text: string, field: string): string | undefined {
  const match = text.match(new RegExp(`^\\s*${field}\\s*=\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)"\\s*$`, "m"));
  if (!match) return undefined;
  return match[1]
    .replace(/\\"/g, "\"")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .trim();
}

async function readHarborTaskMeta(taskDir: string): Promise<{ name?: string; description?: string }> {
  const taskToml = path.join(taskDir, "task.toml");
  if (!(await exists(taskToml))) return {};
  const text = await fs.readFile(taskToml, "utf8");
  return {
    name: parseTomlStringField(text, "name"),
    description: parseTomlStringField(text, "description"),
  };
}

function publicHarborTaskRef(taskDir: string): string {
  const parts = path.resolve(taskDir).split(path.sep);
  const tasksIndex = parts.lastIndexOf("tasks");
  if (tasksIndex >= 0 && tasksIndex < parts.length - 1) {
    return parts.slice(tasksIndex + 1).join("/");
  }
  return path.basename(taskDir);
}

async function discoverInstruction(taskDir: string): Promise<{ file?: string; content: string }> {
  const candidates = [
    "README.md",
    "readme.md",
    "task.md",
    "TASK.md",
    "prompt.md",
    "instructions.md",
    "instruction.md",
    "problem.md",
    "statement.md",
    "description.md",
  ];
  for (const candidate of candidates) {
    const file = path.join(taskDir, candidate);
    if (await exists(file)) {
      return { file, content: await fs.readFile(file, "utf8") };
    }
  }
  for (const candidate of ["task.json", "metadata.json", "config.json"]) {
    const file = path.join(taskDir, candidate);
    if (await exists(file)) {
      const json = await readJsonFile<Record<string, Json>>(file);
      const content =
        String(json.instruction || json.prompt || json.description || json.content || "").trim() ||
        `Harbor task metadata:\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\``;
      return { file, content };
    }
  }
  const files = (await listFiles(taskDir)).map((file) => path.relative(taskDir, file));
  return {
    content: [
      `# Harbor task ${path.basename(taskDir)}`,
      "",
      "No canonical markdown instruction file was found. The converted task keeps the Harbor directory as the executable source of truth.",
      "",
      "## Files",
      ...files.slice(0, 200).map((file) => `- ${file}`),
    ].join("\n"),
  };
}

async function cmdConfigInit(opts: Record<string, OptValue>): Promise<void> {
  const configPath = opt(opts, "config") || DEFAULT_CONFIG_PATH;
  const data: Record<string, Json> = {
    schema_version: "playground-cli-ts-config/v0",
    apiBase: opt(opts, "api-base") || DEFAULT_PLAY_API,
    workerApiBase: opt(opts, "worker-api-base") || DEFAULT_WORKER_API,
    defaultTarget: opt(opts, "target") || "play",
    tokenEnv: opt(opts, "token-env") || "PLAYGROUND_TOKEN",
    workerTokenEnv: opt(opts, "worker-token-env") || "PLAYGROUND_WORKER_TOKEN",
    trisolBin: opt(opts, "trisol-bin") || "trisol",
    createdAt: utcNow(),
  };
  await saveConfig(configPath, data);
  console.log(JSON.stringify({ status: "configured", configPath, config: data }, null, 2));
}

async function cmdHarborConvert(opts: Record<string, OptValue>): Promise<void> {
  const harborTask = path.resolve(required(opts, "harbor-task"));
  const outDir = path.resolve(opt(opts, "out") || path.join(process.cwd(), "playground-challenge"));
  const taskMeta = await readHarborTaskMeta(harborTask);
  const taskRef = publicHarborTaskRef(harborTask);
  const title = opt(opts, "title") || taskMeta.description || path.basename(harborTask);
  const challengeId = opt(opts, "challenge-id") || slugify(title);
  const tags = ["harbor", "paper2arm", ...parseTags(opt(opts, "tags"))];
  const instruction = await discoverInstruction(harborTask);
  const expectedOutputs = parseExpectedOutputs(optAll(opts, "expected-output"));
  const datasetRefs = parseDatasetOptions(optAll(opts, "dataset"));
  const instructionText = instruction.content.trim();
  const content = [
    ...(instructionText.match(/^#\s+/) ? [instructionText] : [`# ${title}`, "", instructionText]),
    "",
    "## Submission",
    "",
    "Submit an ARM v1.1 bundle that contains:",
    "",
    "- `outputs/` with the files required by the Harbor checker",
    "- `execution/run.log` or equivalent run log",
    "- `traces/trace.jsonl` and, when available, raw agent messages",
    "- `arm_manifest.json` and `characterization.json`",
    "",
    "## Expected outputs",
    "",
    ...expectedOutputs.map((item) => `- \`${item.path}\`: ${item.description}`),
  ].join("\n");
  const challenge: Record<string, Json> = {
    id: challengeId,
    title,
    title_zh: opt(opts, "title-zh") || title,
    abstract: opt(opts, "abstract") || "Solve the task and submit the required output artifacts for automated Harbor evaluation.",
    author: opt(opts, "author") || "Harbor / Paper2ARM",
    year: Number(opt(opts, "year") || "2026"),
    journal: opt(opts, "journal") || "Harbor",
    disc: opt(opts, "disc") || "physics",
    difficulty: Number(opt(opts, "difficulty") || "3"),
    tags,
    content,
    hasContent: true,
    status: "open",
    reviewStatus: "draft",
    origin: "harbor",
    attempts: 0,
    bestScore: null,
    scoring: {
      strategy: "harbor_hidden_verifier",
      score_range: [0, 100],
      formula_summary: "Score is produced by the Harbor/LBG checker after submission.",
      protocol_url: "/api/protocol",
    },
    meta: {
      source: "harbor",
      harborTaskRef: taskRef,
      harborTaskName: taskMeta.name || null,
      expectedOutputs,
      datasets: datasetRefs as unknown as Json,
      gettingStarted: "Open the Guide tab, solve the Harbor task, then submit an ARM v1.1 bundle with outputs and trace evidence.",
      generatedBy: `@paper2arm/playground-cli ${VERSION}`,
      generatedAt: utcNow(),
    },
  };
  const manifest: Record<string, Json> = {
    schema_version: "playground-harbor-task/v0",
    task_id: challengeId,
    domain: String(challenge.disc),
    title,
    harbor_task_path: taskRef,
    display: {
      instruction_md: "task.md",
      expected_outputs: expectedOutputs,
    },
    submission: {
      bundle_format: "zip",
      max_bytes: 256 * 1024 * 1024,
      required_paths: ["outputs/", "arm_manifest.json", "traces/trace.jsonl"],
      optional_paths: ["execution/run.log", "characterization.json", "traces/raw_messages.jsonl"],
    },
    evaluation: {
      result_checker: "harbor hidden verifier",
      process_checker: "Playground trace/bundle validation",
    },
    datasets: datasetRefs as unknown as Json,
  };
  await fs.mkdir(outDir, { recursive: true });
  await writeJsonFile(path.join(outDir, "challenge.json"), challenge);
  const suppliedConfig = configFromChallenge(challenge) || BUILTIN_TASK_CONFIGS[challengeId];
  const portableConfig: Record<string, Json> = suppliedConfig || {
    id: challengeId,
    trisol: {
      datasets: (challenge.datasets || challenge.dataset || []) as Json,
      models: (challenge.models || challenge.model || []) as Json,
    },
  };
  if (!portableConfig.id) portableConfig.id = challengeId;
  await writeJsonFile(path.join(outDir, "config.json"), portableConfig);
  await fs.writeFile(path.join(outDir, "task.md"), content);
  await fs.writeFile(path.join(outDir, "rubric.md"), [
    "# Rubric",
    "",
    "The original Harbor checker/verifier evaluates the submitted `outputs/`.",
    "Process evidence is inspected from the ARM bundle trace and logs.",
    "",
  ].join("\n"));
  await writeJsonFile(path.join(outDir, "playground_manifest.json"), manifest);
  console.log(JSON.stringify({
    status: "converted",
    challenge_id: challengeId,
    outDir,
    upload: `playground task upload --challenge-dir ${outDir} --target play`,
    workerUpload: `playground task upload --challenge-dir ${outDir} --target worker`,
  }, null, 2));
}

async function cmdTaskUpload(opts: Record<string, OptValue>): Promise<void> {
  const config = await loadConfig(opts);
  const base = apiBase(opts, config);
  const token = bearerToken(opts, config);
  const challengeDir = path.resolve(required(opts, "challenge-dir"));
  const challengePath = path.join(challengeDir, "challenge.json");
  const challenge = await readJsonFile<Record<string, Json>>(challengePath);
  const taskMd = path.join(challengeDir, "task.md");
  const rubricMd = path.join(challengeDir, "rubric.md");
  if (await exists(taskMd)) challenge.content = await fs.readFile(taskMd, "utf8");
  if (await exists(rubricMd)) challenge.rubric = await fs.readFile(rubricMd, "utf8");
  const created = await requestJson<Record<string, Json>>(
    `${base}/challenges`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(challenge),
    },
    token,
  );
  const challengeId = String(created.id || challenge.id);
  console.log(JSON.stringify({
    schema_version: "playground-task-upload/v0",
    status: "uploaded",
    target: targetName(opts, config),
    api_base: base,
    challenge_id: challengeId,
    challenge_url: `${publicBaseFromApi(base)}/#challenge/${challengeId}`,
    challenge: created,
  }, null, 2));
}

async function cmdTaskList(opts: Record<string, OptValue>): Promise<void> {
  const config = await loadConfig(opts);
  const base = apiBase(opts, config);
  const token = bearerToken(opts, config);
  const rows = await fetchChallengeRows(base, token);
  const tagFilters = optAll(opts, "tag")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const filteredRows = rows.filter((row) => matchesTagFilter(row, tagFilters));
  const rawLimit = Number(opt(opts, "limit") || "30");
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 30;
  const selected = filteredRows.slice(0, limit);
  if (flag(opts, "json")) {
    console.log(JSON.stringify({
      schema_version: "playground-task-list/v0",
      api_base: base,
      total: filteredRows.length,
      total_unfiltered: rows.length,
      tag_filter: tagFilters,
      tasks: selected.map((row, index) => ({
        index: index + 1,
        id: String(row.id),
        title: stringValue(row.title) || stringValue(row.title_zh) || "",
        status: stringValue(row.status) || "",
        attempts: numberValue(row.attempts),
        tags: tagsFromRow(row),
      })),
    }, null, 2));
    return;
  }
  if (selected.length === 0) {
    const detail = tagFilters.length > 0 ? ` for tag ${tagFilters.join(",")}` : "";
    console.error(`No tasks found${detail}.`);
    return;
  }
  for (const [index, row] of selected.entries()) {
    const title = stringValue(row.title) || stringValue(row.title_zh) || "";
    const tags = tagsFromRow(row);
    const tagText = tags.length ? `  [${tags.join(",")}]` : "";
    const suffix = title ? `  ${title}` : "";
    console.log(`${index + 1}\t${String(row.id)}${tagText}${suffix}`);
  }
  if (filteredRows.length > selected.length) {
    const filterText = tagFilters.length ? ` matching tag ${tagFilters.join(",")}` : "";
    console.error(`Showing ${selected.length}/${filteredRows.length}${filterText}; pass --limit ${filteredRows.length} to show all.`);
  }
}

async function cmdTaskDownload(opts: Record<string, OptValue>): Promise<void> {
  const config = await loadConfig(opts);
  const base = apiBase(opts, config);
  const token = bearerToken(opts, config);
  const inputChallengeId = required(opts, "challenge-id");
  const challengeId = await resolveChallengeId(base, token, inputChallengeId);
  const outDir = path.resolve(opt(opts, "out") || challengeId);
  let challenge: Record<string, Json>;
  try {
    challenge = await requestJson<Record<string, Json>>(`${base}/challenges/${encodeURIComponent(challengeId)}`, {}, token);
  } catch (error) {
    if (error instanceof CliError && error.message.includes("HTTP 404")) {
      throw new CliError(`${error.message}\nHint: run 'playground task list --limit 20' and pass one of the listed string ids, or use a numeric list index such as --challenge-id 1.`);
    }
    throw error;
  }
  await fs.mkdir(outDir, { recursive: true });
  await writeJsonFile(path.join(outDir, "challenge.json"), challenge);
  const suppliedConfig = configFromChallenge(challenge) || BUILTIN_TASK_CONFIGS[challengeId];
  const portableConfig: Record<string, Json> = suppliedConfig || {
    id: challengeId,
    trisol: {
      datasets: (challenge.datasets || challenge.dataset || []) as Json,
      models: (challenge.models || challenge.model || []) as Json,
    },
  };
  if (!portableConfig.id) portableConfig.id = challengeId;
  await writeJsonFile(path.join(outDir, "config.json"), portableConfig);
  if (typeof challenge.content === "string") await fs.writeFile(path.join(outDir, "task.md"), challenge.content);
  if (typeof challenge.rubric === "string") await fs.writeFile(path.join(outDir, "rubric.md"), challenge.rubric);
  const datasetRefs = flag(opts, "skip-datasets") ? [] : datasetRefsFromChallenge(challenge);
  const modelRefs = flag(opts, "skip-models") ? [] : modelRefsFromChallenge(challenge);
  const datasetRoot = path.resolve(opt(opts, "dataset-out") || path.join(outDir, "datasets"));
  const datasetDownloads: Awaited<ReturnType<typeof downloadTrisolDataset>>[] = [];
  for (const ref of datasetRefs) {
    const safeDataset = slugify(ref.dataset);
    const safeVersion = slugify(ref.version || "latest");
    const target = ref.path
      ? path.resolve(outDir, ref.path)
      : path.join(datasetRoot, safeDataset, safeVersion);
    datasetDownloads.push(await downloadTrisolDataset(opts, ref, target, !ref.path));
  }
  const modelRoot = path.resolve(opt(opts, "model-out") || path.join(outDir, "models"));
  const modelDownloads: Awaited<ReturnType<typeof downloadTrisolModel>>[] = [];
  for (const ref of modelRefs) {
    const target = ref.path
      ? path.resolve(outDir, ref.path)
      : path.join(modelRoot, slugify(ref.model), slugify(ref.version || "latest"));
    modelDownloads.push(await downloadTrisolModel(opts, ref, target));
  }
  console.log(JSON.stringify({
    status: "downloaded",
    challenge_id: challengeId,
    input_challenge_id: inputChallengeId,
    outDir,
    datasets: datasetDownloads,
    models: modelDownloads,
  }, null, 2));
}

function pushStringFlag(args: string[], opts: Record<string, OptValue>, optKey: string, cliFlag = optKey): void {
  const value = opt(opts, optKey);
  if (value) args.push(`--${cliFlag}`, value);
}

async function cmdDataList(opts: Record<string, OptValue>): Promise<void> {
  const args = ["dataset", "list", "--output", "json"];
  for (const key of ["page", "name", "search"]) {
    pushStringFlag(args, opts, key);
  }
  if (!flag(opts, "all")) {
    args.push("--limit", opt(opts, "limit") || String(DEFAULT_DATA_LIST_LIMIT));
  } else if (opt(opts, "limit")) {
    args.push("--limit", required(opts, "limit"));
  }
  args.push("--visibility", opt(opts, "visibility") || "team");
  if (flag(opts, "dry-run")) {
    console.log(JSON.stringify({
      schema_version: "playground-data-list/v1",
      status: "dry_run",
      source: "playground-data",
      scope: "team-visible",
      search: opt(opts, "search") || "",
      limit: flag(opts, "all") ? "all" : opt(opts, "limit") || String(DEFAULT_DATA_LIST_LIMIT),
    }, null, 2));
    return;
  }
  const { stdout } = await runTrisol(opts, args);
  let payload = parseJsonOutput<unknown>(stdout, "trisol dataset list");
  if (flag(opts, "all") && !opt(opts, "limit") && !opt(opts, "page")) {
    const firstPage = simplifyDatasetList(payload) as Record<string, any>;
    const total = typeof firstPage.total === "number" ? firstPage.total : undefined;
    const count = typeof firstPage.count === "number" ? firstPage.count : undefined;
    if (total !== undefined && count !== undefined && total > count) {
      const full = await runTrisol(opts, [...args, "--limit", String(total)]);
      payload = parseJsonOutput<unknown>(full.stdout, "trisol dataset list");
    }
  }
  console.log(JSON.stringify(simplifyDatasetList(payload), null, 2));
}

async function cmdDataGet(opts: Record<string, OptValue>): Promise<void> {
  const dataset = opt(opts, "dataset") || opt(opts, "id") || required(opts, "name");
  if (flag(opts, "dry-run")) {
    console.log(JSON.stringify({
      schema_version: "playground-data-get/v1",
      status: "dry_run",
      source: "playground-data",
      dataset,
    }, null, 2));
    return;
  }
  const payload = await getTrisolDatasetPayload(opts, dataset);
  console.log(JSON.stringify(simplifyDatasetGet(payload, dataset), null, 2));
}

async function cmdDataPull(opts: Record<string, OptValue>): Promise<void> {
  const dataset = opt(opts, "dataset") || opt(opts, "id") || required(opts, "name");
  const version = required(opts, "version");
  const split = opt(opts, "split");
  const ref: TrisolDatasetRef = { dataset, version, split };
  const rawOut = opt(opts, "out") || opt(opts, "output");
  const outPath = rawOut
    ? path.resolve(rawOut)
    : path.resolve("data", slugify(dataset), slugify(version));
  const outputIsDirectory = true;
  const result = await downloadTrisolDataset(opts, ref, outPath, outputIsDirectory);
  console.log(JSON.stringify({
    schema_version: "playground-data-pull/v1",
    status: flag(opts, "dry-run") ? "dry_run" : "downloaded",
    source: "playground-data",
    dataset: result.dataset,
    version: result.version,
    output: result.output,
    files: result.files as unknown as Json,
  }, null, 2));
}

async function cmdDoctor(opts: Record<string, OptValue>): Promise<void> {
  const results: Record<string, Json> = {
    schema_version: "playground-doctor/v0",
    playground_version: VERSION,
    node: process.version,
    trisol: null,
  };
  try {
    const { stdout } = await runProcess(trisolBin(opts), ["version"]);
    results.trisol = {
      status: "present",
      version: stdout.trim().split(/\r?\n/)[0] || "unknown",
    };
  } catch (error) {
    if (flag(opts, "install-trisol") || flag(opts, "install-if-missing")) {
      await installTrisol(opts);
      const { stdout } = await runProcess(trisolBin(opts), ["version"]);
      results.trisol = {
        status: "installed",
        version: stdout.trim().split(/\r?\n/)[0] || "unknown",
      };
    } else {
      results.trisol = {
        status: "missing",
        install: `curl -fsSL ${DEFAULT_TRISOL_INSTALLER} | bash`,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (!flag(opts, "quiet")) console.log(JSON.stringify(results, null, 2));
}

interface SubmissionIdentity {
  declaredModel?: string;
  declaredHarness?: string;
  detectedModel?: string;
  detectedHarness?: string;
  model: string;
  harness: string;
}

function mostFrequent(values: Array<string | undefined>): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

async function submissionIdentity(
  opts: Record<string, OptValue>,
  traceSteps: Record<string, Json>[],
): Promise<SubmissionIdentity> {
  const declaredModel = opt(opts, "model") || process.env.PLAYGROUND_MODEL;
  const declaredHarness = opt(opts, "harness") || process.env.PLAYGROUND_HARNESS;
  const detectedModel = mostFrequent(traceSteps.map((step) =>
    stringValue(step.model_id) || stringValue(step.modelId) || stringValue(step.model_name) || stringValue(step.model),
  ));
  let detectedHarness: string | undefined;
  const traceFormat = (opt(opts, "trace-format") || "").toLowerCase();
  const tracePath = opt(opts, "trace");
  if (traceFormat && traceFormat !== "auto" && traceFormat !== "arm") detectedHarness = traceFormat;
  if (!detectedHarness && tracePath) {
    const text = await fs.readFile(path.resolve(tracePath), "utf8");
    const rows = objectRowsFromJsonl(text);
    const lower = text.slice(0, 2_000_000).toLowerCase();
    if (opencodeEventLike(rows) || /\bopencode\b/.test(lower)) detectedHarness = "opencode";
    else if (claudeCodeEventLike(rows) || /\bclaude[-_ ]?code\b/.test(lower)) detectedHarness = "claude-code";
    else if (/\bcodex\b/.test(lower)) detectedHarness = "codex";
    else if (/\b(openclaw|arkclaw)\b/.test(lower)) detectedHarness = "openclaw";
    else if (/\bharbor[-_ ]?lbg\b/.test(lower)) detectedHarness = "harbor-lbg";
  }
  return {
    declaredModel,
    declaredHarness,
    detectedModel,
    detectedHarness,
    model: declaredModel || detectedModel || "unknown",
    harness: declaredHarness || detectedHarness || "harbor-lbg",
  };
}

type DetectedTrace = { path: string; harness: string };

async function detectNativeTrace(): Promise<DetectedTrace | undefined> {
  const configured = process.env.PLAYGROUND_TRACE;
  const candidates: DetectedTrace[] = [
    ...(configured ? [{ path: configured, harness: process.env.PLAYGROUND_HARNESS || "auto" }] : []),
    { path: "/logs/agent/opencode.txt", harness: "opencode" },
    { path: "/logs/agent/codex.txt", harness: "codex" },
    { path: "/logs/agent/claude-code.txt", harness: "claude-code" },
    { path: "/logs/agent/claude_code.txt", harness: "claude-code" },
    { path: "/logs/agent/claude.txt", harness: "claude-code" },
  ];
  const present: Array<DetectedTrace & { mtimeMs: number }> = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate.path);
    try {
      const stat = await fs.stat(resolved);
      if (stat.isFile() && stat.size > 0) present.push({ ...candidate, path: resolved, mtimeMs: stat.mtimeMs });
    } catch {
      // Candidate is not present in this harness.
    }
  }
  present.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return present[0];
}

async function ensureSubmissionTrace(opts: Record<string, OptValue>): Promise<void> {
  if (opt(opts, "trace")) return;
  const detected = await detectNativeTrace();
  if (!detected) {
    throw new CliError(
      "could not auto-detect a native agent trace; rerun with --trace PATH " +
      "(and optionally --trace-format opencode|codex|claude-code)",
    );
  }
  opts.trace = detected.path;
  if (!opt(opts, "trace-format") && detected.harness !== "auto") opts["trace-format"] = detected.harness;
}

async function loadTraceSteps(opts: Record<string, OptValue>, outputFiles: string[]): Promise<Record<string, Json>[]> {
  const trace = opt(opts, "trace");
  if (!trace) throw new CliError("submission requires a native trace; pass --trace PATH");
  const tracePath = path.resolve(trace);
  const text = await fs.readFile(tracePath, "utf8");
  const parsedSteps = parseTraceSteps(text, path.basename(tracePath));
  if (parsedSteps.length) return parsedSteps;
  throw new CliError(`could not derive normalized trace steps from native trace ${tracePath}`);
}

async function writeRawMessages(stage: string, source: string): Promise<{ data: Buffer; path: string; redactions: number }> {
  const raw = await fs.readFile(source, "utf8");
  const redacted = redactTraceText(raw);
  const rows = objectRowsFromJsonl(redacted.text);
  const hasSessionStart = stringValue(rows[0]?.type) === "session_start";
  const envelope = hasSessionStart ? "" : `${JSON.stringify({ type: "session_start", source: "playground-cli-auto-detect" })}\n`;
  const data = Buffer.from(`${envelope}${redacted.text}${redacted.text.endsWith("\n") ? "" : "\n"}`, "utf8");
  const rootTarget = path.join(stage, "raw_messages.jsonl");
  const tracesTarget = path.join(stage, "traces", "raw_messages.jsonl");
  await fs.mkdir(path.dirname(tracesTarget), { recursive: true });
  await fs.writeFile(rootTarget, data);
  await fs.writeFile(tracesTarget, data);
  return { data, path: rootTarget, redactions: redacted.redactions };
}

async function traceCanServeAsRawMessages(tracePath: string): Promise<boolean> {
  const text = await fs.readFile(tracePath, "utf8");
  try {
    const parsed = JSON.parse(text);
    const obj = asPlainObject(parsed);
    if (Array.isArray(parsed) || (obj && Array.isArray(obj.steps))) return true;
  } catch {
    // JSONL traces are handled below.
  }
  const rows = objectRowsFromJsonl(text);
  return nativeTraceLike(rows)
    || opencodeEventLike(rows)
    || claudeCodeEventLike(rows)
    || rows.some((row) => row.role || row.source || row.content || row.text || row.message);
}

async function cmdTraceConvert(opts: Record<string, OptValue>): Promise<void> {
  const input = path.resolve(opt(opts, "trace") || opt(opts, "in") || required(opts, "input"));
  const out = path.resolve(opt(opts, "out") || "trace.jsonl");
  const text = await fs.readFile(input, "utf8");
  const steps = parseTraceSteps(text, path.basename(input));
  if (!steps.length) throw new CliError(`could not derive ARM trace steps from ${input}`);
  await fs.mkdir(path.dirname(out), { recursive: true });
  await fs.writeFile(out, `${steps.map((step) => JSON.stringify(step)).join("\n")}\n`);
  let rawOut: string | undefined;
  let redactions = 0;
  if (opt(opts, "raw-out")) {
    rawOut = path.resolve(required(opts, "raw-out"));
    const redacted = redactTraceText(text);
    redactions = redacted.redactions;
    await fs.mkdir(path.dirname(rawOut), { recursive: true });
    await fs.writeFile(rawOut, redacted.text);
  }
  console.log(JSON.stringify({
    status: "converted",
    input,
    out,
    raw_out: rawOut || null,
    raw_redactions: redactions,
    validation: validateTraceSteps(steps),
  }, null, 2));
}

async function cmdTraceValidate(opts: Record<string, OptValue>): Promise<void> {
  const input = path.resolve(opt(opts, "trace") || opt(opts, "in") || required(opts, "input"));
  const text = await fs.readFile(input, "utf8");
  const steps = parseTraceSteps(text, path.basename(input));
  console.log(JSON.stringify({
    path: input,
    ...validateTraceSteps(steps),
  }, null, 2));
}

async function makeArmBundle(opts: Record<string, OptValue>): Promise<BundleResult> {
  const outputs = path.resolve(required(opts, "outputs"));
  const challengeId = required(opts, "challenge-id");
  const createdAt = utcNow();
  const runId = opt(opts, "run-id") || `local-${createdAt.replace(/[-:]/g, "").toLowerCase()}-${createHash("sha1").update(`${challengeId}:${process.cwd()}:${Date.now()}`).digest("hex").slice(0, 8)}`;
  const inputsForSecretScan = [outputs, opt(opts, "report"), opt(opts, "log"), opt(opts, "trace")].filter(Boolean) as string[];
  if (!flag(opts, "allow-secrets")) {
    const secretHits = await scanForSecrets(inputsForSecretScan);
    if (secretHits.length > 0) {
      throw new CliError(`possible secrets found; refusing to package:\n${secretHits.slice(0, 20).map((hit) => `  - ${hit}`).join("\n")}`);
    }
  }

  const bundlePath = path.resolve(opt(opts, "bundle-out") || "playground-arm.zip");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "playground-cli-ts-"));
  const stage = path.join(tmp, "stage");
  try {
    await fs.mkdir(stage, { recursive: true });
    await copyPath(outputs, path.join(stage, "outputs"));
    await copyPath(outputs, path.join(stage, "results"));
    await copyPath(outputs, path.join(stage, "execution", "results"));
    if (opt(opts, "report")) await copyPath(path.resolve(required(opts, "report")), path.join(stage, "reproduction_report.md"));
    if (opt(opts, "log")) await copyPath(path.resolve(required(opts, "log")), path.join(stage, "logs"));
    const tracePath = opt(opts, "trace") ? path.resolve(required(opts, "trace")) : undefined;
    if (tracePath) await copyPath(tracePath, path.join(stage, "native_trace", path.basename(tracePath)));
    const rawMessagesSource = opt(opts, "raw-messages")
      ? path.resolve(required(opts, "raw-messages"))
      : tracePath && await traceCanServeAsRawMessages(tracePath)
        ? tracePath
        : undefined;
    const rawMessages = rawMessagesSource ? await writeRawMessages(stage, rawMessagesSource) : undefined;

    const outputFiles = (await listFiles(path.join(stage, "outputs"))).map((file) => path.relative(stage, file).replaceAll(path.sep, "/"));
    const traceSteps = await loadTraceSteps(opts, outputFiles);
    const identity = await submissionIdentity(opts, traceSteps);
    const existingTimestamps = traceSteps.map((step) => timestampMillis(step.timestamp));
    const firstTimestampIndex = existingTimestamps.findIndex((millis) => millis !== undefined);
    const fallbackStart = firstTimestampIndex >= 0
      ? (existingTimestamps[firstTimestampIndex] as number) - firstTimestampIndex * 1000
      : Date.now();
    let previousTimestamp = 0;
    traceSteps.forEach((step, index) => {
      step.step_order = index + 1;
      let millis = timestampMillis(step.timestamp);
      if (millis === undefined) millis = fallbackStart + index * 1000;
      if (previousTimestamp && millis < previousTimestamp) millis = previousTimestamp + 1000;
      step.timestamp = isoNoMillis(millis);
      previousTimestamp = millis;
      if (!step.type && step.step_type) step.type = step.step_type;
      if (!step.step_type && step.type) step.step_type = step.type;
    });

    const artifacts = outputFiles.map((arc, index) => ({
      id: `artifact-${index + 1}`,
      path: arc.replace(/^outputs\//, "execution/results/"),
      kind: "output",
      type: "file",
      format: path.extname(arc).replace(/^\./, "") || "artifact",
    }));
    const manifest: Record<string, Json> = {
      arm_version: "1.1",
      paper: {
        title: challengeId,
        url: opt(opts, "task-url") || "",
      },
      entrypoint: "src/reproduce.py",
      environment: { dependencies: "requirements.txt" },
      execution: {
        ran_at: utcNow(),
        wall_time_s: 1,
        log_path: "execution/run.log",
        artifacts: artifacts as unknown as Json,
      },
      expected_outputs: outputFiles.map((arc, index) => ({
        name: path.basename(arc),
        path: arc,
        type: [".md", ".txt", ".json", ".csv"].includes(path.extname(arc).toLowerCase()) ? "text" : "artifact",
        comparison_method: "harbor_checker",
        produced_by: [`artifact-${index + 1}`],
      })) as unknown as Json,
      characterization: "characterization.json",
      trace: "traces/trace.jsonl",
      ...(rawMessages ? { raw_messages: "raw_messages.jsonl" } : {}),
      provenance: {
        created_by: "@paper2arm/playground-cli",
        created_at: createdAt,
        challenge_id: challengeId,
        task_id: opt(opts, "task-id") || challengeId,
        run_id: runId,
        model: identity.model,
        harness: identity.harness,
        declared_model: identity.declaredModel || "",
        declared_harness: identity.declaredHarness || "",
        detected_model: identity.detectedModel || "",
        detected_harness: identity.detectedHarness || "",
        model_source: identity.declaredModel ? "declared" : identity.detectedModel ? "detected" : "fallback",
        harness_source: identity.declaredHarness ? "declared" : identity.detectedHarness ? "detected" : "fallback",
      },
    };
    const submission: Record<string, Json> = {
      schema_version: "playground-submission/v0",
      task_id: opt(opts, "task-id") || challengeId,
      challenge_id: challengeId,
      run_id: runId,
      created_at: createdAt,
      task_url: opt(opts, "task-url") || "",
      agent: {
        name: opt(opts, "agent-name") || "playground-cli",
        version: opt(opts, "agent-version") || VERSION,
        model: identity.model,
      },
      harness: {
        name: identity.harness,
        native_trace_format: opt(opts, "trace-format") || (tracePath ? "auto" : "arm"),
      },
      artifacts: [] as unknown as Json,
      privacy: {
        redaction: "playground-cli-secret-scan-v0",
        contains_raw_credentials: false,
      },
    };
    const characterization: Record<string, Json> = {
      envelope: {
        challenge_id: challengeId,
        task_id: opt(opts, "task-id") || challengeId,
        run_id: runId,
        status: "submitted",
        note: "Generated by @paper2arm/playground-cli. Final scoring is delegated to Playground/Harbor.",
      },
      failure_modes: [
        {
          name: "independent_characterization_pending",
          status: "pending",
          mitigation: "Evaluate with the Playground rubric or Harbor checker.",
        },
      ],
    };
    const runLog = [
      `Packaged Playground submission for ${challengeId}.`,
      `Outputs: ${outputFiles.join(", ") || "(none)"}`,
      "Generated by @paper2arm/playground-cli.",
      "",
    ].join("\n");
    const submissionArtifacts: Record<string, Json>[] = [];
    for (const arc of outputFiles) {
      submissionArtifacts.push({
        path: arc,
        sha256: await sha256File(path.join(stage, arc)),
      });
    }
    if (await exists(path.join(stage, "reproduction_report.md"))) {
      submissionArtifacts.push({
        path: "reproduction_report.md",
        sha256: await sha256File(path.join(stage, "reproduction_report.md")),
      });
    }
    submission.artifacts = submissionArtifacts as unknown as Json;
    await writeJsonFile(path.join(stage, "submission.json"), submission);
    await writeJsonFile(path.join(stage, "arm_manifest.json"), manifest);
    await writeJsonFile(path.join(stage, "characterization.json"), characterization);
    await fs.mkdir(path.join(stage, "execution"), { recursive: true });
    await fs.writeFile(path.join(stage, "execution", "run.log"), runLog);
    await fs.mkdir(path.join(stage, "logs"), { recursive: true });
    await fs.writeFile(path.join(stage, "logs", "run.log"), runLog);
    await fs.mkdir(path.join(stage, "traces"), { recursive: true });
    await fs.writeFile(path.join(stage, "traces", "trace.jsonl"), `${traceSteps.map((step) => JSON.stringify(step)).join("\n")}\n`);
    await fs.writeFile(path.join(stage, "README.md"), `# Playground submission\n\nChallenge: \`${challengeId}\`\n`);
    await fs.writeFile(path.join(stage, "Dockerfile"), "FROM python:3.11-slim\nWORKDIR /workspace\n");
    await fs.writeFile(path.join(stage, "requirements.txt"), "");
    await fs.mkdir(path.join(stage, "src"), { recursive: true });
    await fs.writeFile(
      path.join(stage, "src", "reproduce.py"),
      "from pathlib import Path\nPath('outputs').mkdir(exist_ok=True)\nprint('Playground bundle contains submitted outputs.')\n",
    );
    await zipDirectory(stage, bundlePath);
    return {
      bundlePath,
      manifest,
      traceSteps,
      rawMessagesData: rawMessages?.data,
      rawMessagesFilename: rawMessages ? "raw_messages.jsonl" : undefined,
    };
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function cmdSubmit(opts: Record<string, OptValue>): Promise<void> {
  const config = await loadConfig(opts);
  const playOpts = { ...opts, target: "play" };
  const workerOpts = { ...opts, target: "worker" };
  const base = apiBase(playOpts, config);
  const token = bearerToken(playOpts, config);
  const workerBase = apiBase(workerOpts, config);
  const workerToken = bearerToken(workerOpts, config);
  const challengeId = required(opts, "challenge-id");
  let bundlePath = opt(opts, "bundle") ? path.resolve(required(opts, "bundle")) : "";
  let manifest: Record<string, Json> = {};
  let traceSteps: Record<string, Json>[] = [];
  let rawMessagesData: Buffer | undefined;
  let rawMessagesFilename: string | undefined;
  if (!bundlePath) {
    await ensureSubmissionTrace(opts);
    const built = await makeArmBundle(opts);
    bundlePath = built.bundlePath;
    manifest = built.manifest;
    traceSteps = built.traceSteps;
    rawMessagesData = built.rawMessagesData;
    rawMessagesFilename = built.rawMessagesFilename;
  } else {
    manifest = opt(opts, "manifest") ? await readJsonFile<Record<string, Json>>(path.resolve(required(opts, "manifest"))) : {};
    traceSteps = await loadTraceSteps(opts, []);
  }
  const bundleSha256 = await sha256File(bundlePath);
  const identity = await submissionIdentity(opts, traceSteps);
  if (flag(opts, "dry-run")) {
    console.log(JSON.stringify({ status: "dry_run", bundle: bundlePath, bundle_sha256: bundleSha256, manifest, trace_steps: traceSteps }, null, 2));
    return;
  }
  const rawMessages = opt(opts, "raw-messages");
  const files: MultipartFile[] = [];
  if (rawMessages) {
    files.push({
      name: "raw_messages",
      filename: path.basename(rawMessages),
      contentType: "application/x-ndjson",
      data: await fs.readFile(rawMessages),
    });
  } else if (rawMessagesData) {
    files.push({
      name: "raw_messages",
      filename: rawMessagesFilename || "raw_messages.jsonl",
      contentType: "application/x-ndjson",
      data: rawMessagesData,
    });
  }
  const attemptFields: Record<string, string> = {
    method: opt(opts, "method") || "Playground CLI submission",
    model: identity.model,
    harness: identity.harness,
    type: "agent",
    status: "submitted",
    detail: opt(opts, "detail") || `Submitted by @paper2arm/playground-cli ${VERSION}.`,
    manifest_json: JSON.stringify(manifest),
    trace: JSON.stringify(traceSteps),
    author_name: opt(opts, "author-name") || "Playground CLI",
  };
  const declaredOutcome = opt(opts, "outcome");
  if (declaredOutcome) attemptFields.outcome = declaredOutcome;
  const attempt = await postMultipartJson<Record<string, Json>>(
    `${base}/challenges/${encodeURIComponent(challengeId)}/attempts`,
    attemptFields,
    files,
    token,
  );
  const attemptId = String(attempt.id);
  if (!attemptId || attemptId === "undefined") throw new CliError(`attempt response did not include id: ${JSON.stringify(attempt)}`);
  const separateWorker = workerBase !== base;
  const bundleResponse = await postMultipartJson<Record<string, Json>>(
    separateWorker ? `${workerBase}/uploads` : `${base}/attempts/${encodeURIComponent(attemptId)}/bundle`,
    separateWorker ? { attempt_id: attemptId, challenge_id: challengeId } : {},
    [{
      name: "bundle",
      filename: path.basename(bundlePath),
      contentType: "application/zip",
      data: await fs.readFile(bundlePath),
    }],
    separateWorker ? workerToken : token,
  );
  console.log(JSON.stringify({
    schema_version: "playground-cli-submission/v0",
    status: "submitted",
    target: targetName(opts, config),
    api_base: base,
    worker_api_base: workerBase,
    challenge_id: challengeId,
    attempt_id: attemptId,
    attempt_url: `${publicBaseFromApi(base)}/#challenge/${challengeId}`,
    bundle: bundlePath,
    bundle_sha256: bundleSha256,
    attempt,
    bundle_response: bundleResponse,
  }, null, 2));
}

async function cmdStatus(opts: Record<string, OptValue>): Promise<void> {
  const config = await loadConfig(opts);
  const base = apiBase(opts, config);
  const token = bearerToken(opts, config);
  const attemptId = required(opts, "attempt-id");
  const suffix = flag(opts, "bundle") ? "bundle/status" : "";
  const url = `${base}/attempts/${encodeURIComponent(attemptId)}${suffix ? `/${suffix}` : ""}`;
  console.log(JSON.stringify(await requestJson(url, {}, token), null, 2));
}

async function cmdResultUpdate(opts: Record<string, OptValue>): Promise<void> {
  const config = await loadConfig(opts);
  const base = apiBase(opts, config);
  const token = bearerToken(opts, config);
  const attemptId = required(opts, "attempt-id");
  const payload: Record<string, Json> = {
    score: Number(required(opts, "score")),
    status: opt(opts, "status") || "scored",
    outcome: opt(opts, "outcome") || "scored",
    summary: opt(opts, "summary") || "Harbor evaluation completed.",
    evaluatedAt: utcNow(),
  };
  if (opt(opts, "results-json")) {
    payload.resultsJson = await readJsonFile(path.resolve(required(opts, "results-json"))) as unknown as Json;
  }
  console.log(JSON.stringify(await requestJson(
    `${base}/attempts/${encodeURIComponent(attemptId)}/result`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token,
  ), null, 2));
}

function asRecord(value: unknown): Record<string, any> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findHarborResultFiles(root: string): Promise<string[]> {
  if (!(await exists(root))) return [];
  return (await listFiles(root)).filter((file) => path.basename(file) === "result.json");
}

function rewardFromJobResult(result: Record<string, any>): { reward?: number; errors?: number; evalName?: string } {
  const stats = asRecord(result.stats);
  if (!stats) return {};
  const errors = finiteNumber(stats.n_errors);
  const evals = asRecord(stats.evals);
  if (!evals) return { errors };
  for (const [evalName, rawEval] of Object.entries(evals)) {
    const evalRow = asRecord(rawEval);
    if (!evalRow) continue;
    const metrics = Array.isArray(evalRow.metrics) ? evalRow.metrics : [];
    for (const metric of metrics) {
      const mean = finiteNumber(asRecord(metric)?.mean);
      if (mean !== undefined) return { reward: mean, errors, evalName };
    }
    const rewardStats = asRecord(asRecord(evalRow.reward_stats)?.reward);
    if (rewardStats) {
      const values = Object.keys(rewardStats).map((key) => finiteNumber(key)).filter((n): n is number => n !== undefined);
      if (values.length) return { reward: Math.max(...values), errors, evalName };
    }
  }
  return { errors };
}

function rewardFromTrialResult(result: Record<string, any>): { reward?: number; errors?: number } {
  const reward = finiteNumber(asRecord(asRecord(result.verifier_result)?.rewards)?.reward);
  const errors = result.exception_info ? 1 : 0;
  return { reward, errors };
}

async function collectHarborScore(opts: Record<string, OptValue>): Promise<{
  reward: number;
  errors: number;
  jobResult?: string;
  trialResult?: string;
  evalName?: string;
}> {
  let jobResult = opt(opts, "harbor-result");
  let trialResult = opt(opts, "trial-result");
  const evalRoot = opt(opts, "eval-root");
  if (evalRoot && (!jobResult || !trialResult)) {
    const files = await findHarborResultFiles(path.resolve(evalRoot));
    for (const file of files) {
      const data = await readJsonFile<Record<string, any>>(file);
      if (!jobResult && asRecord(data.stats)?.evals) jobResult = file;
      if (!trialResult && asRecord(data.verifier_result)) trialResult = file;
    }
  }

  let reward: number | undefined;
  let errors = 0;
  let evalName: string | undefined;
  if (jobResult) {
    const data = await readJsonFile<Record<string, any>>(path.resolve(jobResult));
    const extracted = rewardFromJobResult(data);
    reward = extracted.reward ?? reward;
    errors = extracted.errors ?? errors;
    evalName = extracted.evalName;
  }
  if (reward === undefined && trialResult) {
    const data = await readJsonFile<Record<string, any>>(path.resolve(trialResult));
    const extracted = rewardFromTrialResult(data);
    reward = extracted.reward;
    errors = extracted.errors ?? errors;
  }
  if (reward === undefined) {
    throw new CliError("Harbor result is not ready or did not contain a numeric reward");
  }
  return {
    reward,
    errors,
    jobResult: jobResult ? path.resolve(jobResult) : undefined,
    trialResult: trialResult ? path.resolve(trialResult) : undefined,
    evalName,
  };
}

async function cmdResultPoll(opts: Record<string, OptValue>): Promise<void> {
  const config = await loadConfig(opts);
  const base = apiBase(opts, config);
  const token = bearerToken(opts, config);
  const attemptId = required(opts, "attempt-id");
  const scoreMultiplier = Number(opt(opts, "score-multiplier") || "100");
  if (!Number.isFinite(scoreMultiplier)) throw new CliError("--score-multiplier must be numeric");
  const watch = flag(opts, "watch");
  const intervalMs = Number(opt(opts, "interval-ms") || "5000");
  const timeoutMs = Number(opt(opts, "timeout-ms") || (watch ? "1800000" : "0"));
  const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : 0;

  let collected: Awaited<ReturnType<typeof collectHarborScore>> | undefined;
  for (;;) {
    try {
      collected = await collectHarborScore(opts);
      break;
    } catch (error) {
      if (!watch || (deadline && Date.now() >= deadline)) throw error;
      await sleep(intervalMs);
    }
  }
  const score = Number((collected.reward * scoreMultiplier).toFixed(6));
  const summary = opt(opts, "summary") ||
    `Harbor evaluation completed. Reward ${collected.reward}; Playground score ${score}.`;
  const payload: Record<string, Json> = {
    score,
    status: opt(opts, "status") || "scored",
    outcome: opt(opts, "outcome") || "scored",
    summary,
    evaluatedAt: utcNow(),
    resultsJson: {
      harbor_reward: collected.reward,
      score_percent: score,
      harbor_errors: collected.errors,
      eval_name: collected.evalName || null,
      harbor_job_result: collected.jobResult || null,
      harbor_trial_result: collected.trialResult || null,
    },
    scorecard: {
      harbor_replay_executed: 1,
      verifier_errors: collected.errors,
      reward: collected.reward,
    },
    execStatus: collected.errors > 0 ? "completed_with_errors" : "completed",
  };
  if (flag(opts, "dry-run")) {
    console.log(JSON.stringify({
      status: "dry_run",
      attempt_id: attemptId,
      target: targetName(opts, config),
      api_base: base,
      payload,
    }, null, 2));
    return;
  }
  console.log(JSON.stringify(await requestJson(
    `${base}/attempts/${encodeURIComponent(attemptId)}/result`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
    token,
  ), null, 2));
}

function makeCrcTable(): number[] {
  const table: number[] = [];
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = makeCrcTable();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value & 0xffff, 0);
  return buf;
}

function u32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}

async function zipDirectory(root: string, output: string): Promise<void> {
  const files = await listFiles(root);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const rel = path.relative(root, file).replaceAll(path.sep, "/");
    const name = Buffer.from(rel, "utf8");
    const data = await fs.readFile(file);
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      data,
    ]);
    localParts.push(local);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0o100644 << 16),
      u32(offset),
      name,
    ]);
    centralParts.push(central);
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const end = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.length),
    u32(offset),
    u16(0),
  ]);
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, Buffer.concat([...localParts, central, end]));
}

function printHelp(): void {
  console.log(`Playground CLI ${VERSION}

Usage:
  playground config init [--api-base ${DEFAULT_PLAY_API}]
  playground harbor convert --harbor-task DIR --out challenge-dir [--title TEXT] [--challenge-id ID]
  playground trace convert --trace trajectory.jsonl --out trace.jsonl [--raw-out raw_messages.jsonl]
  playground trace validate --trace trace.jsonl
  playground task list [--limit 30] [--tag harbor] [--json]
  playground task download --challenge-id ID --out challenge-dir [--skip-datasets]
  playground data pull --dataset DATASET --version VERSION [--out data-dir/]
  playground data list [--search TEXT] [--limit 20] [--all]
  playground submit --challenge-id ID --outputs outputs-dir [--trace native-trace] [--raw-messages raw.jsonl]
                    [--model MODEL] [--harness HARNESS]
  playground status --attempt-id ID [--bundle]
  playground doctor [--install-trisol]

Important environment variables:
  PLAYGROUND_TOKEN          Bearer token, if the deployed Playground requires one
  PLAYGROUND_API_BASE       Optional override for the built-in Playground API
  PLAYGROUND_MODEL          Optional self-reported model (same as --model)
  PLAYGROUND_HARNESS        Optional self-reported harness (same as --harness)
  PLAYGROUND_TRACE          Optional native trace path; submit auto-detects OpenCode,
                            Codex, and Claude Code traces under /logs/agent first
`);
}

async function main(): Promise<void> {
  const { commands, opts } = parseArgs(process.argv.slice(2));
  if (flag(opts, "version") || commands[0] === "version") {
    console.log(VERSION);
    return;
  }
  if (commands.length === 0 || flag(opts, "help") || commands[0] === "help") {
    printHelp();
    return;
  }
  const key = commands.join(" ");
  if (key === "config init") return cmdConfigInit(opts);
  if (key === "harbor convert") return cmdHarborConvert(opts);
  if (key === "trace convert") return cmdTraceConvert(opts);
  if (key === "trace validate") return cmdTraceValidate(opts);
  if (key === "task upload") return cmdTaskUpload(opts);
  if (key === "task list") return cmdTaskList(opts);
  if (key === "task download") return cmdTaskDownload(opts);
  if (key === "data list" || key === "dataset list") return cmdDataList(opts);
  if (key === "data get" || key === "dataset get") return cmdDataGet(opts);
  if (key === "data pull" || key === "data download" || key === "dataset pull" || key === "dataset download") return cmdDataPull(opts);
  if (key === "submit") return cmdSubmit(opts);
  if (key === "status") return cmdStatus(opts);
  if (key === "doctor") return cmdDoctor(opts);
  if (key === "result update") return cmdResultUpdate(opts);
  if (key === "result poll") return cmdResultPoll(opts);
  throw new CliError(`unknown command: ${commands.join(" ")}`);
}

main().catch((error: unknown) => {
  const err = error instanceof CliError ? error : new CliError(error instanceof Error ? error.message : String(error));
  console.error(`error: ${err.message}`);
  process.exit(err.exitCode);
});
