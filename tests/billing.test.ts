import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BillingError, prepareBillingAttempt, prepareBillingPreview, resolveBillingMode } from "../src/billing.js";
import { parseHeadlessConfig } from "../src/config.js";
import type { Env } from "../src/types.js";

const prompt = { prompt: "inspect" };

function credentialHome(files: Record<string, unknown>): { env: Env; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), "headless-billing-"));
  for (const [path, value] of Object.entries(files)) {
    const target = join(home, path);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, JSON.stringify(value));
  }
  return { env: { HOME: home }, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test("billing defaults to auto and CLI overrides environment and per-agent config", () => {
  const config = parseHeadlessConfig('[agents.codex]\nbilling = "subscription"\n');
  assert.equal(resolveBillingMode("codex", undefined, {}, config), "subscription");
  assert.equal(resolveBillingMode("claude", undefined, {}, config), "auto");
  assert.equal(resolveBillingMode("codex", undefined, { HEADLESS_BILLING: "api" }, config), "api");
  assert.equal(resolveBillingMode("codex", "auto", { HEADLESS_BILLING: "api" }, config), "auto");
});

test("invalid billing config and environment values fail without echoing their value", () => {
  assert.throws(() => parseHeadlessConfig('[agents.codex]\nbilling = "secret-value"'), /billing.*auto.*subscription.*api/);
  assert.throws(() => resolveBillingMode("codex", undefined, { HEADLESS_BILLING: "secret-value" }, parseHeadlessConfig("")),
    (error: unknown) => error instanceof BillingError && error.exitCode === 78 && !error.message.includes("secret-value"));
});

test("automatic routing leaves unsupported harnesses and credential-free invocations native", () => {
  assert.deepEqual(prepareBillingAttempt("pi", prompt, { OPENAI_API_KEY: "example" }, "auto"),
    { route: "native", env: { OPENAI_API_KEY: "example" } });
  assert.equal(prepareBillingAttempt("codex", prompt, {}, "auto").route, "native");
  assert.equal(prepareBillingAttempt("claude", prompt, {}, "auto").route, "native");
  assert.throws(() => prepareBillingAttempt("pi", prompt, {}, "subscription"), BillingError);
});

test("Codex automatic billing selects subscription and masks API environment credentials", () => {
  const home = credentialHome({ ".codex/auth.json": { auth_mode: "chatgpt", tokens: { access_token: "oauth" } } });
  try {
    const env = { ...home.env, CODEX_API_KEY: "api", OPENAI_API_KEY: "api", OPENAI_BASE_URL: "https://proxy.test" };
    const result = prepareBillingAttempt("codex", prompt, env, "auto");
    assert.equal(result.route, "subscription");
    assert.equal(result.env.CODEX_API_KEY, undefined);
    assert.equal(result.env.OPENAI_API_KEY, undefined);
    assert.equal(result.env.OPENAI_BASE_URL, undefined);
    assert.equal(env.CODEX_API_KEY, "api");
  } finally { home.cleanup(); }
});

test("Codex GPT-5.4 aliases select same-model API auth even when subscription exists", () => {
  const home = credentialHome({ ".codex/auth.json": { auth_mode: "chatgpt", tokens: { access_token: "oauth" } } });
  try {
    for (const model of ["gpt-5.4", "gpt-5.4-2026-03-05"]) {
      const options = { ...prompt, model };
      const result = prepareBillingAttempt("codex", options, { ...home.env, OPENAI_API_KEY: "api" }, "auto");
      assert.equal(result.route, "openai-api");
      assert.equal(result.env.CODEX_API_KEY, "api");
      assert.equal(options.model, model);
    }
    assert.equal(prepareBillingAttempt("codex", { ...prompt, model: "gpt-5.4-mini" }, home.env, "auto").route, "subscription");
    assert.throws(() => prepareBillingAttempt("codex", { ...prompt, model: "gpt-5.4" }, home.env, "auto"), /CODEX_API_KEY.*OPENAI_API_KEY/);
  } finally { home.cleanup(); }
});

test("Codex API credential precedence is process-local and removes subscription token override", () => {
  const result = prepareBillingAttempt("codex", prompt,
    { CODEX_API_KEY: "preferred", OPENAI_API_KEY: "other", CODEX_ACCESS_TOKEN: "subscription" }, "api");
  assert.equal(result.env.CODEX_API_KEY, "preferred");
  assert.equal(result.env.CODEX_ACCESS_TOKEN, undefined);
});

test("Codex respects CODEX_HOME and refuses stored API login in subscription mode without modifying it", () => {
  const home = credentialHome({ "custom/auth.json": { auth_mode: "apikey", OPENAI_API_KEY: "api" } });
  try {
    const env = { ...home.env, CODEX_HOME: join(home.env.HOME!, "custom") };
    const before = readFileSync(join(env.CODEX_HOME, "auth.json"), "utf8");
    assert.throws(() => prepareBillingAttempt("codex", prompt, env, "subscription"), /stored API/);
    assert.equal(readFileSync(join(env.CODEX_HOME, "auth.json"), "utf8"), before);
  } finally { home.cleanup(); }
});

test("Codex auto preserves explicit profiles while subscription rejects unknown provider routing", () => {
  const env = { CODEX_API_KEY: "api" };
  assert.deepEqual(prepareBillingAttempt("codex", { ...prompt, profile: "private", model: "gpt-5.4" }, env, "auto"),
    { route: "native", env });
  assert.throws(() => prepareBillingAttempt("codex", { ...prompt, profile: "private" }, env, "subscription"), /profile/);
});

test("Codex API configuration errors identify missing key without leaking credentials", () => {
  assert.throws(() => prepareBillingAttempt("codex", prompt, {}, "api"),
    (error: unknown) => error instanceof BillingError && error.exitCode === 78 && /CODEX_API_KEY/.test(error.message));
});

test("Claude auto prefers OAuth and removes conflicting API and backend variables", () => {
  const env = {
    CLAUDE_CODE_OAUTH_TOKEN: "oauth", ANTHROPIC_API_KEY: "api", ANTHROPIC_AUTH_TOKEN: "token",
    ANTHROPIC_BASE_URL: "https://proxy.test", CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_VERTEX: "1", CLAUDE_CODE_USE_FOUNDRY: "1", HEADLESS_CLAUDE_AUTH: "api",
  };
  const result = prepareBillingAttempt("claude", prompt, env, "auto");
  assert.equal(result.route, "subscription");
  assert.equal(result.env.CLAUDE_CODE_OAUTH_TOKEN, "oauth");
  for (const name of Object.keys(env).filter((name) => name !== "CLAUDE_CODE_OAUTH_TOKEN")) {
    assert.equal(result.env[name], undefined, name);
  }
});

test("Claude detects actual stored OAuth and does not treat ordinary settings as credentials", () => {
  const home = credentialHome({ ".claude.json": {}, ".claude/.credentials.json": { claudeAiOauth: { accessToken: "oauth" } } });
  try {
    assert.equal(prepareBillingAttempt("claude", prompt, home.env, "auto").route, "subscription");
    assert.equal(prepareBillingAttempt("claude", prompt, { ...home.env, CLAUDE_CONFIG_DIR: join(home.env.HOME!, "absent") }, "auto").route, "native");
  } finally { home.cleanup(); }
});

test("Claude API route uses Bedrock credentials and masks OAuth and direct API auth", () => {
  const home = credentialHome({ ".claude/.credentials.json": { claudeAiOauth: { accessToken: "oauth" } } });
  try {
    const env = { ...home.env, CLAUDE_CODE_OAUTH_TOKEN: "oauth", ANTHROPIC_API_KEY: "direct",
      AWS_ACCESS_KEY_ID: "aws", AWS_SECRET_ACCESS_KEY: "secret", AWS_REGION: "us-east-1",
      CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "1" };
    const result = prepareBillingAttempt("claude", prompt, env, "api");
    assert.equal(result.route, "bedrock");
    assert.equal(result.env.CLAUDE_CODE_USE_BEDROCK, "1");
    assert.equal(result.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(result.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(result.env.CLAUDE_CODE_USE_VERTEX, undefined);
    assert.equal(result.env.AWS_SECRET_ACCESS_KEY, "secret");
  } finally { home.cleanup(); }
});

test("Claude automatic billing uses Bedrock when no OAuth is available", () => {
  assert.equal(prepareBillingAttempt("claude", prompt,
    { AWS_BEARER_TOKEN_BEDROCK: "test", AWS_REGION: "us-east-1" }, "auto").route, "bedrock");
});

test("Claude missing Bedrock backup is actionable even when direct Anthropic key exists", () => {
  assert.throws(() => prepareBillingAttempt("claude", prompt, { ANTHROPIC_API_KEY: "secret" }, "api"),
    (error: unknown) => error instanceof BillingError && /Bedrock/.test(error.message) && !error.message.includes("secret"));
});

test("route override cannot cross billing policy or use another harness backend", () => {
  assert.throws(() => prepareBillingAttempt("codex", prompt, { OPENAI_API_KEY: "api" }, "subscription", "openai-api"), /subscription/);
  assert.throws(() => prepareBillingAttempt("claude", prompt, {}, "auto", "openai-api"), BillingError);
});

test("unsafe credential files fail closed instead of selecting a paid fallback", () => {
  const home = credentialHome({ "outside.json": { tokens: { access_token: "oauth" } } });
  try {
    mkdirSync(join(home.env.HOME!, ".codex"));
    symlinkSync(join(home.env.HOME!, "outside.json"), join(home.env.HOME!, ".codex/auth.json"));
    assert.throws(() => prepareBillingAttempt("codex", prompt, { ...home.env, OPENAI_API_KEY: "api" }, "auto"), BillingError);
    assert.throws(() => prepareBillingAttempt("codex", prompt, home.env, "subscription"), BillingError);
  } finally { home.cleanup(); }
});

test("billing preview shows direct API routing without requiring or fabricating a key", () => {
  const result = prepareBillingPreview("codex", { ...prompt, model: "gpt-5.4" }, {}, "auto");
  assert.equal(result.route, "openai-api");
  assert.equal(result.env.CODEX_API_KEY, undefined);
  assert.equal(prepareBillingPreview("claude", prompt, {}, "api").route, "bedrock");
});

test("auth masks remain explicit for remote credential and secret overlays", () => {
  const result = prepareBillingAttempt("claude", prompt, { CLAUDE_CODE_OAUTH_TOKEN: "oauth" }, "subscription");
  assert.ok(Object.hasOwn(result.env, "ANTHROPIC_API_KEY"));
  assert.ok(Object.hasOwn(result.env, "CLAUDE_CODE_USE_MANTLE"));
  assert.ok(Object.hasOwn(result.env, "CLAUDE_CODE_USE_ANTHROPIC_AWS"));
});

test("Codex preserves base custom provider routing", () => {
  const home = credentialHome({});
  try {
    mkdirSync(join(home.env.HOME!, ".codex"));
    writeFileSync(join(home.env.HOME!, ".codex/config.toml"), 'model_provider = "private"\n');
    assert.equal(prepareBillingAttempt("codex", { ...prompt, model: "gpt-5.4" }, home.env, "auto").route, "native");
    assert.throws(() => prepareBillingAttempt("codex", prompt, home.env, "auto", "openai-api"), /profile\/provider/);
  } finally { home.cleanup(); }
});

test("auth policy rejects incompatible native login restrictions without deleting auth", () => {
  const home = credentialHome({ ".codex/auth.json": { auth_mode: "chatgpt", tokens: { access_token: "oauth" } } });
  try {
    writeFileSync(join(home.env.HOME!, ".codex/config.toml"), 'forced_login_method = "chatgpt"\n');
    assert.throws(() => prepareBillingAttempt("codex", prompt, { ...home.env, OPENAI_API_KEY: "api" }, "api"), /forced_login_method/);
    writeFileSync(join(home.env.HOME!, ".codex/config.toml"), 'forced_login_method = "api"\n');
    assert.throws(() => prepareBillingAttempt("codex", prompt, home.env, "subscription"), /forced_login_method/);
    assert.ok(readFileSync(join(home.env.HOME!, ".codex/auth.json"), "utf8").includes("oauth"));
  } finally { home.cleanup(); }
});

test("Claude paid settings cannot bypass subscription mode", () => {
  const home = credentialHome({ ".claude/settings.json": { apiKeyHelper: "get-key" } });
  try {
    assert.throws(() => prepareBillingAttempt("claude", prompt, { ...home.env, CLAUDE_CODE_OAUTH_TOKEN: "oauth" }, "subscription"), /apiKeyHelper/);
  } finally { home.cleanup(); }
});

test("Claude disabled backend settings are compatible with subscription mode", () => {
  const home = credentialHome({ ".claude/settings.json": { env: { CLAUDE_CODE_USE_BEDROCK: "0" } } });
  try {
    assert.equal(prepareBillingAttempt("claude", prompt, home.env, "subscription").route, "subscription");
  } finally { home.cleanup(); }
});

test("Claude workspace settings cannot override a subscription route", () => {
  const home = credentialHome({ "workspace/.claude/settings.local.json": { env: { ANTHROPIC_API_KEY: "test" } } });
  try {
    assert.throws(() => prepareBillingAttempt("claude", { ...prompt, workDir: join(home.env.HOME!, "workspace", "nested") }, home.env, "subscription"), /paid backend/);
  } finally { home.cleanup(); }
});

test("malformed or oversized credential metadata fails closed", () => {
  const home = credentialHome({ ".codex/auth.json": {} });
  try {
    const path = join(home.env.HOME!, ".codex/auth.json");
    writeFileSync(path, "not json");
    assert.throws(() => prepareBillingAttempt("codex", prompt, home.env, "auto"), BillingError);
    writeFileSync(path, "x".repeat(1024 * 1024 + 1));
    assert.throws(() => prepareBillingAttempt("codex", prompt, home.env, "subscription"), BillingError);
  } finally { home.cleanup(); }
});

test("API mode rejects a subscription route override", () => {
  assert.throws(() => prepareBillingAttempt("codex", prompt, {}, "api", "subscription"), /API billing/);
});

test("other agents ignore inherited billing policies", () => {
  const config = parseHeadlessConfig('[agents.pi]\nbilling = "subscription"');
  assert.equal(resolveBillingMode("pi", undefined, { HEADLESS_BILLING: "api" }, config), "auto");
  assert.equal(resolveBillingMode("opencode", undefined, { HEADLESS_BILLING: "invalid" }, config), "auto");
  assert.equal(resolveBillingMode("pi", "subscription", {}, config), "subscription");
});

function fakeNativeStatus(home: string, binary: string, output: string, status = 0): Env {
  const binDir = join(home, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, binary), `#!${process.execPath}\n` +
    `process.stderr.write(${JSON.stringify(output)}); process.exitCode = ${status};\n`, { mode: 0o755 });
  return { HOME: home, PATH: binDir };
}

test("Codex auto recognizes keyring OAuth ahead of an available API key", () => {
  const home = credentialHome({});
  try {
    mkdirSync(join(home.env.HOME!, ".codex"));
    writeFileSync(join(home.env.HOME!, ".codex/config.toml"), 'cli_auth_credentials_store = "keyring"\n');
    const env = fakeNativeStatus(home.env.HOME!, "codex", "Logged in using ChatGPT\n");
    const result = prepareBillingAttempt("codex", prompt, { ...env, OPENAI_API_KEY: "api" }, "auto");
    assert.equal(result.route, "subscription");
    assert.equal(result.env.OPENAI_API_KEY, undefined);
  } finally { home.cleanup(); }
});

test("Codex subscription rejects keyring API authentication without exposing native output", () => {
  const home = credentialHome({});
  try {
    mkdirSync(join(home.env.HOME!, ".codex"));
    writeFileSync(join(home.env.HOME!, ".codex/config.toml"), 'cli_auth_credentials_store = "auto"\n');
    const env = fakeNativeStatus(home.env.HOME!, "codex", "Logged in using an API key - secret-key\n");
    assert.throws(() => prepareBillingAttempt("codex", prompt, env, "subscription"),
      (error: unknown) => error instanceof BillingError && /stored API/.test(error.message) && !error.message.includes("secret-key"));
  } finally { home.cleanup(); }
});

test("ambiguous native credential-store output fails closed before a paid attempt", () => {
  const home = credentialHome({});
  try {
    mkdirSync(join(home.env.HOME!, ".codex"));
    writeFileSync(join(home.env.HOME!, ".codex/config.toml"), 'cli_auth_credentials_store = "keyring"\n');
    const env = fakeNativeStatus(home.env.HOME!, "codex", "unknown native state");
    assert.throws(() => prepareBillingAttempt("codex", prompt, { ...env, OPENAI_API_KEY: "api" }, "auto"), /login status/);
  } finally { home.cleanup(); }
});

test("Claude checks current-directory settings when workDir is omitted", () => {
  const home = credentialHome({ ".claude/settings.json": { apiKeyHelper: "get-key" } });
  const previous = process.cwd();
  try {
    process.chdir(home.env.HOME!);
    assert.throws(() => prepareBillingAttempt("claude", prompt, { CLAUDE_CODE_OAUTH_TOKEN: "oauth" }, "subscription"), /apiKeyHelper/);
  } finally { process.chdir(previous); home.cleanup(); }
});

test("Claude auto checks macOS keychain authentication before selecting Bedrock", () => {
  const home = credentialHome({});
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { value: "darwin" });
    const env = fakeNativeStatus(home.env.HOME!, "claude", JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }));
    const result = prepareBillingAttempt("claude", prompt,
      { ...env, AWS_BEARER_TOKEN_BEDROCK: "test", AWS_REGION: "us-east-1" }, "auto");
    assert.equal(result.route, "subscription");
  } finally { Object.defineProperty(process, "platform", platform); home.cleanup(); }
});

test("dormant Codex profile settings do not change root billing or login policy", () => {
  const home = credentialHome({ ".codex/auth.json": { auth_mode: "chatgpt", tokens: { access_token: "oauth" } } });
  try {
    writeFileSync(join(home.env.HOME!, ".codex/config.toml"),
      '[profiles.private]\nmodel_provider = "private"\nforced_login_method = "chatgpt"\ncli_auth_credentials_store = "keyring"\n');
    const result = prepareBillingAttempt("codex", { ...prompt, model: "gpt-5.4" }, { ...home.env, OPENAI_API_KEY: "api" }, "auto");
    assert.equal(result.route, "openai-api");
    assert.equal(prepareBillingAttempt("codex", prompt, home.env, "subscription").route, "subscription");
  } finally { home.cleanup(); }
});

test("quoted Codex provider keys are respected but instruction text is not configuration", () => {
  const home = credentialHome({ ".codex/auth.json": {} });
  try {
    const path = join(home.env.HOME!, ".codex/config.toml");
    writeFileSync(path, '"model_provider" = "private"\n');
    assert.equal(prepareBillingAttempt("codex", { ...prompt, model: "gpt-5.4" }, home.env, "auto").route, "native");
    writeFileSync(path, 'developer_instructions = """\nmodel_provider = "private"\n"""\n');
    assert.equal(prepareBillingAttempt("codex", { ...prompt, model: "gpt-5.4" }, { ...home.env, OPENAI_API_KEY: "api" }, "auto").route, "openai-api");
  } finally { home.cleanup(); }
});

test("subscription masks the native Anthropic Google Cloud backend selector", () => {
  const result = prepareBillingAttempt("claude", prompt,
    { CLAUDE_CODE_OAUTH_TOKEN: "oauth", CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "1" }, "subscription");
  assert.equal(result.env.CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD, undefined);
});

for (const [relativePath, customDir] of [
  [".claude.json", undefined],
  ["custom/.claude.json", "custom"],
  [".claude/.config.json", undefined],
] as const) {
  test(`Claude subscription rejects managed API key in ${relativePath}`, () => {
    const home = credentialHome({ [relativePath]: { primaryApiKey: "must-not-leak" } });
    try {
      const env = customDir ? { ...home.env, CLAUDE_CONFIG_DIR: join(home.env.HOME!, customDir) } : home.env;
      assert.throws(() => prepareBillingAttempt("claude", prompt, env, "subscription"),
        (error: unknown) => error instanceof BillingError && /stored Claude API/.test(error.message) && !error.message.includes("must-not-leak"));
      assert.equal(readFileSync(join(home.env.HOME!, relativePath), "utf8"), JSON.stringify({ primaryApiKey: "must-not-leak" }));
    } finally { home.cleanup(); }
  });
}

test("explicit Claude subscription token takes precedence over a saved managed API key", () => {
  const home = credentialHome({ ".claude.json": { primaryApiKey: "saved-api" } });
  try {
    const result = prepareBillingAttempt("claude", prompt,
      { ...home.env, CLAUDE_CODE_OAUTH_TOKEN: "subscription" }, "subscription");
    assert.equal(result.route, "subscription");
    assert.equal(result.env.CLAUDE_CODE_OAUTH_TOKEN, "subscription");
  } finally { home.cleanup(); }
});

test("Claude global config lookup respects custom directory and legacy file precedence", () => {
  const home = credentialHome({ ".claude.json": { primaryApiKey: "unused-api" }, "custom/.config.json": {} });
  try {
    const env = { ...home.env, CLAUDE_CONFIG_DIR: join(home.env.HOME!, "custom") };
    assert.equal(prepareBillingAttempt("claude", prompt, env, "subscription").route, "subscription");
  } finally { home.cleanup(); }
});

for (const key of ["model_provider", "forced_login_method", "cli_auth_credentials_store"]) {
  for (const quote of ['"""', "'''"]) {
    test(`unsupported multiline ${key} fails closed (${quote})`, () => {
      const home = credentialHome({ ".codex/auth.json": { auth_mode: "chatgpt", tokens: { access_token: "oauth" } } });
      try {
        writeFileSync(join(home.env.HOME!, ".codex/config.toml"), `${key} = ${quote}private-value${quote}\n`);
        assert.throws(() => prepareBillingAttempt("codex", prompt, home.env, "subscription"),
          (error: unknown) => error instanceof BillingError && !error.message.includes("private-value"));
      } finally { home.cleanup(); }
    });
  }
}

test("Codex root key decoding and comment text cannot hide a provider override", () => {
  const home = credentialHome({ ".codex/auth.json": {} });
  try {
    const path = join(home.env.HOME!, ".codex/config.toml");
    for (const config of [
      '"\\u006dodel_provider" = "private"\n',
      'developer_instructions = "hello" # example = """\nmodel_provider = "private"\n',
    ]) {
      writeFileSync(path, config);
      assert.throws(() => prepareBillingAttempt("codex", prompt, home.env, "subscription"), /profile\/provider/);
    }
  } finally { home.cleanup(); }
});
