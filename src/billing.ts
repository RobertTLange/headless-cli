import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import type { HeadlessConfig } from "./config.js";
import type { AgentName, BillingMode, BuildOptions, Env } from "./types.js";

export type { BillingMode } from "./types.js";
export type BillingRoute = "subscription" | "openai-api" | "bedrock" | "native";
export interface BillingAttempt { route: BillingRoute; env: Env }

export class BillingError extends Error {
  readonly exitCode = 78;
  constructor(message: string) {
    super(message);
    this.name = "BillingError";
  }
}

const claudePaidVariables = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "HEADLESS_CLAUDE_AUTH",
];
const maxAuthBytes = 1024 * 1024;
type StoredAuth = "subscription" | "api" | "missing";

export function resolveBillingMode(
  agent: AgentName, explicit: BillingMode | undefined, env: Env, config: HeadlessConfig,
): BillingMode {
  if (agent !== "claude" && agent !== "codex") return explicit ?? "auto";
  const value = explicit ?? env.HEADLESS_BILLING ?? config.agents[agent]?.billing ?? "auto";
  if (value === "auto" || value === "subscription" || value === "api") return value;
  throw new BillingError("HEADLESS_BILLING must be auto, subscription, or api");
}

export function prepareBillingAttempt(
  agent: AgentName, options: BuildOptions, env: Env, mode: BillingMode, routeOverride?: BillingRoute,
): BillingAttempt {
  if (agent !== "claude" && agent !== "codex") {
    if (mode !== "auto" || (routeOverride && routeOverride !== "native")) {
      throw new BillingError("billing selection is supported only for Claude and Codex");
    }
    return { route: "native", env: { ...env } };
  }
  const route = routeOverride ?? selectRoute(agent, options, env, mode);
  validateRoute(agent, mode, route);
  if (route === "native") return { route, env: { ...env } };
  if (route === "subscription") return prepareSubscription(agent, options, env);
  return agent === "codex" ? prepareOpenAiApi(options, env) : prepareBedrock(env);
}

export function prepareBillingPreview(
  agent: AgentName, options: BuildOptions, env: Env, mode: BillingMode,
): BillingAttempt {
  if (agent !== "claude" && agent !== "codex") return prepareBillingAttempt(agent, options, env, mode);
  const route = selectRoute(agent, options, env, mode);
  if (route === "openai-api") return { route, env: openAiApiEnvironment(env) };
  if (route === "bedrock") return { route, env: bedrockEnvironment(env) };
  return prepareBillingAttempt(agent, options, env, mode, route);
}

function selectRoute(agent: "claude" | "codex", options: BuildOptions, env: Env, mode: BillingMode): BillingRoute {
  if (agent === "codex" && hasCustomCodexRouting(options, env)) {
    if (mode === "auto") return "native";
    throw new BillingError("explicit Codex profile/provider routing cannot be combined with billing selection");
  }
  if (mode === "subscription") return "subscription";
  const paidRoute = agent === "codex" ? "openai-api" : "bedrock";
  if (mode === "api") return paidRoute;
  if (agent === "codex" && isApiOnlyCodexModel(options.model ?? env.CODEX_MODEL)) return paidRoute;
  if (hasSubscription(agent, env)) return "subscription";
  if (agent === "codex" ? openAiKey(env) : hasBedrockConfiguration(env)) return paidRoute;
  return "native";
}

function validateRoute(agent: "claude" | "codex", mode: BillingMode, route: BillingRoute): void {
  if (mode === "subscription" && route !== "subscription") {
    throw new BillingError("subscription billing cannot switch to a paid or unspecified authentication route");
  }
  if ((route === "openai-api" && agent !== "codex") || (route === "bedrock" && agent !== "claude")) {
    throw new BillingError("billing route does not match the selected agent");
  }
  if (mode === "api" && (route === "native" || route === "subscription")) {
    throw new BillingError("API billing requires an explicit paid authentication route");
  }
}

function prepareSubscription(agent: "claude" | "codex", options: BuildOptions, env: Env): BillingAttempt {
  const prepared = { ...env };
  if (agent === "codex") {
    if (hasCustomCodexRouting(options, env)) throw new BillingError("subscription billing cannot use a custom Codex profile/provider");
    if (storedAuth(agent, env) === "api") {
      throw new BillingError("subscription billing cannot use the stored API login; sign in to Codex with ChatGPT first");
    }
    rejectCodexLoginRestriction(env, "api");
    remove(prepared, ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENAI_BASE_URL"]);
  } else {
    rejectClaudePaidSettings(options, env);
    if (storedAuth(agent, env) === "api") {
      throw new BillingError("subscription billing cannot use stored Claude API authentication; sign in to Claude with a subscription first");
    }
    remove(prepared, claudePaidVariables);
  }
  return { route: "subscription", env: prepared };
}

function prepareOpenAiApi(options: BuildOptions, env: Env): BillingAttempt {
  if (hasCustomCodexRouting(options, env)) {
    throw new BillingError("API billing cannot replace an explicit Codex profile/provider; use its native authentication");
  }
  const key = openAiKey(env);
  if (!key) throw new BillingError("Codex API billing requires CODEX_API_KEY or OPENAI_API_KEY; configure an API key for this invocation");
  rejectCodexLoginRestriction(env, "chatgpt");
  return { route: "openai-api", env: openAiApiEnvironment(env) };
}

function prepareBedrock(env: Env): BillingAttempt {
  if (!hasBedrockConfiguration(env)) {
    throw new BillingError("Claude API billing requires Amazon Bedrock credentials and AWS_REGION or AWS_DEFAULT_REGION; configure the AWS credential chain");
  }
  return { route: "bedrock", env: bedrockEnvironment(env) };
}

function openAiApiEnvironment(env: Env): Env {
  return { ...env, CODEX_API_KEY: openAiKey(env), CODEX_ACCESS_TOKEN: undefined };
}

function bedrockEnvironment(env: Env): Env {
  const prepared = { ...env };
  remove(prepared, [...claudePaidVariables, "CLAUDE_CODE_OAUTH_TOKEN"]);
  prepared.CLAUDE_CODE_USE_BEDROCK = "1";
  return prepared;
}

function hasSubscription(agent: "claude" | "codex", env: Env): boolean {
  return storedAuth(agent, env) === "subscription";
}

function storedAuth(agent: "claude" | "codex", env: Env): StoredAuth {
  if (agent === "codex") {
    if (nonempty(env.CODEX_ACCESS_TOKEN)) return "subscription";
    const home = codexConfigDir(env);
    const config = home ? readBoundedFile(join(home, "config.toml")) : undefined;
    const store = rootTomlString(config, "cli_auth_credentials_store");
    if (store === "keyring" || store === "auto") return nativeStoredAuth(agent, env);
    const auth = codexAuth(env);
    if (auth.auth_mode === "apikey") return "api";
    if (nonempty(asRecord(auth.tokens).access_token)) return "subscription";
    if (nonempty(auth.OPENAI_API_KEY)) return "api";
    return "missing";
  }
  if (nonempty(env.CLAUDE_CODE_OAUTH_TOKEN)) return "subscription";
  const configDir = claudeConfigDir(env);
  if (!configDir) return "missing";
  if (nonempty(claudeGlobalConfig(env, configDir).primaryApiKey)) return "api";
  for (const name of [".credentials.json", "auth.json"]) {
    const auth = readJson(join(configDir, name));
    if (nonempty(asRecord(auth.claudeAiOauth).accessToken)) return "subscription";
  }
  return process.platform === "darwin" ? nativeStoredAuth(agent, env) : "missing";
}

function claudeGlobalConfig(env: Env, configDir: string): Record<string, unknown> {
  const legacyConfig = readBoundedFile(join(configDir, ".config.json"));
  if (legacyConfig !== undefined) return parseJson(legacyConfig);
  const root = env.CLAUDE_CONFIG_DIR || env.HOME;
  return root ? readJson(join(root, ".claude.json")) : {};
}

function codexAuth(env: Env): Record<string, unknown> {
  const home = codexConfigDir(env);
  return home ? readJson(join(home, "auth.json")) : {};
}

function hasCustomCodexRouting(options: BuildOptions, env: Env): boolean {
  if (options.profile) return true;
  const home = codexConfigDir(env);
  const config = home ? readBoundedFile(join(home, "config.toml")) : undefined;
  const provider = rootTomlString(config, "model_provider");
  return Boolean(provider && provider !== "openai");
}

function rejectCodexLoginRestriction(env: Env, conflicting: "api" | "chatgpt"): void {
  const home = codexConfigDir(env);
  const config = home ? readBoundedFile(join(home, "config.toml")) : undefined;
  const restriction = rootTomlString(config, "forced_login_method");
  if (restriction === conflicting) {
    throw new BillingError("Codex forced_login_method conflicts with selected billing; update the native configuration before switching auth");
  }
}

function rootTomlString(content: string | undefined, key: string): string | undefined {
  let multiline: string | undefined;
  for (const line of (content ?? "").split(/\r?\n/)) {
    if (multiline) {
      if (line.includes(multiline)) multiline = undefined;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) break;
    if (trimmed.startsWith("#")) continue;
    const assignment = trimmed.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[\w-]+)\s*=\s*(.*)$/);
    if (!assignment) continue;
    const name = /^["']/.test(assignment[1]) ? tomlString(assignment[1]) : assignment[1];
    const rawValue = assignment[2];
    const triple = rawValue.match(/^("""|''')/);
    if (triple) {
      if (name === key) throw uninspectableToml();
      if (!rawValue.slice(3).includes(triple[1])) multiline = triple[1];
      continue;
    }
    if (name !== key) continue;
    const single = rawValue.match(/^("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
    if (!single) throw uninspectableToml();
    return tomlString(single[1]);
  }
  return undefined;
}

function tomlString(value: string): string {
  if (value.startsWith("'")) return value.slice(1, -1);
  try { return JSON.parse(value) as string; } catch { throw uninspectableToml(); }
}

function uninspectableToml(): BillingError {
  return new BillingError("cannot inspect native billing configuration; use a plain quoted root setting");
}

function rejectClaudePaidSettings(options: BuildOptions, env: Env): void {
  const configDir = claudeConfigDir(env);
  if (configDir) rejectClaudePaidConfiguration(claudeGlobalConfig(env, configDir));
  const paths = configDir ? [join(configDir, "settings.json"), join(configDir, "settings.local.json")] : [];
  let directory = resolve(options.workDir ?? process.cwd());
  while (true) {
    paths.push(join(directory, ".claude", "settings.json"), join(directory, ".claude", "settings.local.json"));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const path of paths) {
    rejectClaudePaidConfiguration(readJson(path));
  }
}

function rejectClaudePaidConfiguration(settings: Record<string, unknown>): void {
  const configuredEnv = asRecord(settings.env);
  if (nonempty(settings.apiKeyHelper) || claudePaidVariables.some((key) => isPaidSetting(key, configuredEnv[key]))) {
    throw new BillingError("subscription billing conflicts with Claude apiKeyHelper or paid backend settings; remove those settings for this invocation");
  }
}

function isPaidSetting(key: string, value: unknown): boolean {
  if (!nonempty(value)) return false;
  if (key.startsWith("CLAUDE_CODE_USE_")) return !["0", "false"].includes(value.toLowerCase());
  return key !== "HEADLESS_CLAUDE_AUTH";
}

function hasBedrockConfiguration(env: Env): boolean {
  const region = env.AWS_REGION || env.AWS_DEFAULT_REGION;
  const identity = (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) || env.AWS_BEARER_TOKEN_BEDROCK
    || env.AWS_PROFILE || env.AWS_WEB_IDENTITY_TOKEN_FILE || env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
    || env.AWS_CONTAINER_CREDENTIALS_FULL_URI || env.AWS_SHARED_CREDENTIALS_FILE;
  return Boolean(region && (identity || env.CLAUDE_CODE_USE_BEDROCK === "1"));
}

function isApiOnlyCodexModel(model: string | undefined): boolean {
  return model === "gpt-5.4" || model === "gpt-5.4-2026-03-05";
}

function openAiKey(env: Env): string | undefined {
  return nonempty(env.CODEX_API_KEY) ? env.CODEX_API_KEY : nonempty(env.OPENAI_API_KEY) ? env.OPENAI_API_KEY : undefined;
}

function codexConfigDir(env: Env): string | undefined {
  return env.CODEX_HOME || (env.HOME ? join(env.HOME, ".codex") : undefined);
}

function claudeConfigDir(env: Env): string | undefined {
  return env.CLAUDE_CONFIG_DIR || (env.HOME ? join(env.HOME, ".claude") : undefined);
}

function remove(env: Env, names: string[]): void {
  for (const name of names) env[name] = undefined;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readJson(path: string): Record<string, unknown> {
  const content = readBoundedFile(path);
  if (content === undefined) return {};
  return parseJson(content);
}

function parseJson(content: string): Record<string, unknown> {
  try { return asRecord(JSON.parse(content)); } catch {
    throw new BillingError("cannot inspect malformed native auth/config metadata; repair it before selecting billing");
  }
}

function readBoundedFile(path: string): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxAuthBytes) throw new BillingError("native auth/config metadata must be a bounded regular file");
    const buffer = Buffer.alloc(maxAuthBytes + 1);
    const size = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (size > maxAuthBytes) throw new BillingError("native auth/config metadata exceeds the size limit");
    return buffer.subarray(0, size).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new BillingError("cannot safely inspect native auth/config metadata; repair its file or permissions before selecting billing");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function nativeStoredAuth(agent: "claude" | "codex", env: Env): StoredAuth {
  const prepared = { ...env };
  remove(prepared, [...claudePaidVariables, "CLAUDE_CODE_OAUTH_TOKEN", "CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_ACCESS_TOKEN"]);
  const command = agent === "codex" ? "codex" : env.CLAUDE_CODE_BIN || env.CLAUDE_BIN || "claude";
  const args = agent === "codex" ? ["login", "status"] : ["auth", "status", "--json"];
  const result = spawnSync(command, args, { env: prepared, encoding: "utf8", timeout: 2000, maxBuffer: 16 * 1024, windowsHide: true });
  const action = agent === "codex" ? "codex login status" : "claude auth status --json";
  if (!result.error && result.signal === null) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    const auth = agent === "codex" ? parseCodexStatus(output, result.status) : parseClaudeStatus(output, result.status);
    if (auth) return auth;
  }
  throw new BillingError(`cannot determine stored ${agent} authentication; check ${action} before selecting billing`);
}

function parseCodexStatus(output: string, status: number | null): StoredAuth | undefined {
  if (status === 0 && /(?:^|\n)Logged in using ChatGPT(?:\r?\n|$)/.test(output)) return "subscription";
  if (status === 0 && /(?:^|\n)Logged in using (?:an? )?API key\b/.test(output)) return "api";
  if (status === 1 && /(?:^|\n)Not logged in(?:\r?\n|$)/.test(output)) return "missing";
  return undefined;
}

function parseClaudeStatus(output: string, status: number | null): StoredAuth | undefined {
  let auth: Record<string, unknown>;
  try { auth = asRecord(JSON.parse(output)); } catch { return undefined; }
  if (status === 1 && auth.loggedIn === false) return "missing";
  if (status !== 0 || auth.loggedIn !== true) return undefined;
  if (auth.apiKeySource === "/login managed key") return "api";
  if (auth.authMethod === "claude.ai" || auth.authMethod === "oauth_token") return "subscription";
  if (["api_key", "api_key_helper", "third_party"].includes(String(auth.authMethod))) return "api";
  return undefined;
}
