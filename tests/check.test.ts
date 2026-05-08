import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCli } from "../src/cli.ts";

async function writeExecutable(path: string, source: string): Promise<void> {
  await import("node:fs/promises").then(async ({ chmod, writeFile }) => {
    await writeFile(path, source);
    await chmod(path, 0o755);
  });
}

test("CLI --check prints installed status and numeric versions for all agents", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    await writeExecutable(
      join(binDir, "codex"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'codex-cli 1.2.3'; exit 0; fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    await writeExecutable(
      join(binDir, "gemini"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo '0.39.1'; exit 0; fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    await writeExecutable(
      join(binDir, "opencode"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'warn: noisy startup'; echo 'https://example.test/bun-v1.3.11.zip'; echo '1.4.10'; exit 0; fi",
        "exit 1",
        "",
      ].join("\n"),
    );
    await writeExecutable(
      join(binDir, "pi-agent"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'pi-agent 4.5.6'; exit 0; fi",
        "exit 1",
        "",
      ].join("\n"),
    );

    const stdout: string[] = [];
    const code = await runCli(["--check"], {
      env: { PATH: binDir, PI_CODING_AGENT_BIN: "pi-agent" },
      stdout: (text) => stdout.push(text),
    });

    const output = stdout.join("");
    assert.equal(code, 0);
    assert.match(output, /^\+[-+]+\+$/m);
    assert.match(output, /^\| Agent\s+\| S\s+\| Auth\s+\| Version\s+\| Model\s+\| Effort\s+\|$/m);
    assert.match(output, /^\| codex\s+\| ✓\s+\| -\s+\| 1\.2\.3\s+\| gpt-5\.5\s+\| -\s+\|$/m);
    assert.match(output, /^\| gemini\s+\| ✓\s+\| -\s+\| 0\.39\.1\s+\| gemini-3\.1-pro-preview\s+\| -\s+\|$/m);
    assert.match(output, /^\| opencode\s+\| ✓\s+\| -\s+\| 1\.4\.10\s+\| openai\/gpt-5\.4\s+\| -\s+\|$/m);
    assert.match(output, /^\| pi\s+\| ✓\s+\| -\s+\| 4\.5\.6\s+\| openai-codex\/gpt-5\.5\s+\| -\s+\|$/m);
    assert.match(output, /^\| claude\s+\| ✗\s+\| -\s+\| -\s+\| claude-opus-4-6\s+\| -\s+\|$/m);
    assert.match(output, /^\| cursor\s+\| ✗\s+\| -\s+\| -\s+\| gpt-5\.5\s+\| medium\s+\|$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --check uses cursor env binary and strips hash suffixes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    await writeExecutable(
      join(binDir, "cursor-agent"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo '2026.04.17-787b533'; exit 0; fi",
        "exit 1",
        "",
      ].join("\n"),
    );

    const stdout: string[] = [];
    const code = await runCli(["--check"], {
      env: { PATH: binDir, CURSOR_CLI_BIN: "cursor-agent" },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /^\| cursor\s+\| ✓\s+\| -\s+\| 2026\.04\.17\s+\| gpt-5\.5\s+\| medium\s+\|$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --check reports agent model and effort from headless config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".headless"), { recursive: true });
    writeFileSync(
      join(home, ".headless", "config.toml"),
      [
        "[agents.codex]",
        'model = "gpt-config"',
        'reasoning_effort = "high"',
        "",
        "[agents.pi]",
        'model = "bedrock/claude-sonnet"',
        'reasoning_effort = "xhigh"',
        "",
      ].join("\n"),
    );

    const stdout: string[] = [];
    const code = await runCli(["--check"], {
      env: { AWS_PROFILE: "dev", HOME: home, PATH: join(dir, "bin"), CODEX_MODEL: "gpt-env" },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    const output = stdout.join("");
    assert.match(output, /^\| codex\s+\| ✗\s+\| -\s+\| -\s+\| gpt-env\s+\| high\s+\|$/m);
    assert.match(output, /^\| pi\s+\| ✗\s+\| api\s+\| -\s+\| bedrock\/claude-sonnet\s+\| xhigh\s+\|$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --check does not report Cursor implicit effort for configured custom models", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".headless"), { recursive: true });
    writeFileSync(join(home, ".headless", "config.toml"), ["[agents.cursor]", 'model = "gpt-custom"', ""].join("\n"));

    const stdout: string[] = [];
    const code = await runCli(["--check"], {
      env: { HOME: home, PATH: join(dir, "bin") },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /^\| cursor\s+\| ✗\s+\| -\s+\| -\s+\| gpt-custom\s+\| -\s+\|$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --check keeps installed status when version probe fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    await writeExecutable(
      join(binDir, "cursor-agent"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'no version' >&2; exit 9; fi",
        "exit 1",
        "",
      ].join("\n"),
    );

    const stdout: string[] = [];
    const code = await runCli(["--check"], {
      env: { PATH: binDir, CURSOR_CLI_BIN: "cursor-agent" },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /^\| cursor\s+\| ✓\s+\| -\s+\| unknown\s+\| gpt-5\.5\s+\| medium\s+\|$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --check retries transient empty version output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    const statePath = join(dir, "version-state");
    mkdirSync(binDir);
    await writeExecutable(
      join(binDir, "cursor-agent"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then",
        "  if [ ! -f \"$HEADLESS_VERSION_STATE\" ]; then printf x > \"$HEADLESS_VERSION_STATE\"; exit 0; fi",
        "  echo '9.8.7'; exit 0",
        "fi",
        "exit 1",
        "",
      ].join("\n"),
    );

    const stdout: string[] = [];
    const code = await runCli(["--check"], {
      env: { PATH: binDir, CURSOR_CLI_BIN: "cursor-agent", HEADLESS_VERSION_STATE: statePath },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /^\| cursor\s+\| ✓\s+\| -\s+\| 9\.8\.7\s+\| gpt-5\.5\s+\| medium\s+\|$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --check reports docker and default image status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    await writeExecutable(
      join(binDir, "docker"),
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo 'Docker version 27.1.2, build abc'; exit 0; fi",
        "if [ \"$1\" = \"image\" ] && [ \"$2\" = \"inspect\" ]; then exit 0; fi",
        "exit 1",
        "",
      ].join("\n"),
    );

    const stdout: string[] = [];
    const code = await runCli(["--check"], {
      env: { PATH: binDir },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /^\| Docker\s+\| Status\s+\| Version\s+\| Default image\s+\|$/m);
    assert.match(stdout.join(""), /^\| docker\s+\| ✓\s+\| 27\.1\.2\s+\| ghcr\.io\/roberttlange\/headless:latest \(present\)\s+\|$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --check reports API auth from environment variables", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const stdout: string[] = [];
    const code = await runCli(["--check"], {
      env: { PATH: join(dir, "bin"), OPENAI_API_KEY: "sk-test" },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /^\| codex\s+\| ✗\s+\| api\s+\| -\s+\| gpt-5\.5\s+\| -\s+\|$/m);
    assert.match(stdout.join(""), /^\| opencode\s+\| ✗\s+\| api\s+\| -\s+\| openai\/gpt-5\.4\s+\| -\s+\|$/m);
    assert.match(stdout.join(""), /^\| pi\s+\| ✗\s+\| api\s+\| -\s+\| openai-codex\/gpt-5\.5\s+\| -\s+\|$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --check reports OAuth auth from local seed files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "{}\n");
    writeFileSync(join(home, ".claude.json"), "{}\n");

    const stdout: string[] = [];
    const code = await runCli(["--check"], {
      env: { HOME: home, PATH: join(dir, "bin") },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /^\| claude\s+\| ✗\s+\| oauth\s+\| -\s+\| claude-opus-4-6\s+\| -\s+\|$/m);
    assert.match(stdout.join(""), /^\| codex\s+\| ✗\s+\| oauth\s+\| -\s+\| gpt-5\.5\s+\| -\s+\|$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --check reports combined Claude API and OAuth auth", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, ".claude.json"), "{}\n");

    const stdout: string[] = [];
    const code = await runCli(["--check"], {
      env: { ANTHROPIC_API_KEY: "sk-test", HOME: home, PATH: join(dir, "bin") },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /^\| claude\s+\| ✗\s+\| api\+oauth\s+\| -\s+\| claude-opus-4-6\s+\| -\s+\|$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --check reports combined API and OAuth auth", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "{}\n");

    const stdout: string[] = [];
    const code = await runCli(["--check"], {
      env: { CODEX_API_KEY: "codex-test", HOME: home, PATH: join(dir, "bin") },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /^\| codex\s+\| ✗\s+\| api\+oauth\s+\| -\s+\| gpt-5\.5\s+\| -\s+\|$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --check reports Pi API auth from AWS credentials for Bedrock provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const stdout: string[] = [];
    const code = await runCli(["--check"], {
      env: {
        AWS_PROFILE: "dev",
        PATH: join(dir, "bin"),
        PI_CODING_AGENT_PROVIDER: "bedrock",
        PI_CODING_AGENT_MODEL: "opus",
      },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /^\| pi\s+\| ✗\s+\| api\s+\| -\s+\| opus\s+\| -\s+\|$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("CLI --check does not report Pi AWS auth for the default OpenAI provider", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-test-"));
  try {
    const stdout: string[] = [];
    const code = await runCli(["--check"], {
      env: { AWS_PROFILE: "dev", PATH: join(dir, "bin") },
      stdout: (text) => stdout.push(text),
    });

    assert.equal(code, 0);
    assert.match(stdout.join(""), /^\| pi\s+\| ✗\s+\| -\s+\| -\s+\| openai-codex\/gpt-5\.5\s+\| -\s+\|$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
