import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildDockerAgentCommand, DEFAULT_DOCKER_IMAGE } from "../src/docker.ts";
import { quoteCommand } from "../src/shell.ts";

test("Dockerfile exposes Cursor agent from a non-root path", () => {
  const dockerfile = readFileSync("Dockerfile", "utf8");

  assert.match(dockerfile, /^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /@anthropic-ai\/claude-code@\d+\.\d+\.\d+/);
  assert.match(dockerfile, /@google\/gemini-cli@\d+\.\d+\.\d+/);
  assert.match(dockerfile, /@mariozechner\/pi-coding-agent@\d+\.\d+\.\d+/);
  assert.match(dockerfile, /@openai\/codex@\d+\.\d+\.\d+/);
  assert.match(dockerfile, /opencode-ai@\d+\.\d+\.\d+/);
  assert.match(dockerfile, /ARG CURSOR_AGENT_VERSION=\d{4}\.\d{2}\.\d{2}-[a-f0-9]+/);
  assert.match(dockerfile, /ARG CURSOR_AGENT_SHA256_AMD64=[a-f0-9]{64}/);
  assert.match(dockerfile, /ARG CURSOR_AGENT_SHA256_ARM64=[a-f0-9]{64}/);
  assert.match(dockerfile, /sha256sum -c -/);
  assert.match(dockerfile, /ln -sf \/opt\/cursor-agent\/cursor-agent \/usr\/local\/bin\/cursor-agent/);
  assert.match(dockerfile, /ln -sf \/usr\/local\/bin\/cursor-agent \/usr\/local\/bin\/agent/);
});

test("wraps stdin-based agent command in docker with workdir, user, env, and config mounts", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "project");
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "{}");
    const resolvedWorkDir = realpathSync(workDir);

    const command = buildDockerAgentCommand({
      agent: "codex",
      command: {
        command: "codex",
        args: ["exec", "--json", "-"],
        stdinText: "hello",
      },
      dockerArgs: ["--network=host"],
      dockerEnv: ["EXTRA_TOKEN", "INLINE_TOKEN=value"],
      env: {
        HOME: home,
        OPENAI_API_KEY: "sk-test",
        EXTRA_TOKEN: "extra",
        UNRELATED_SECRET: "nope",
      },
      hostUser: "501:20",
      image: DEFAULT_DOCKER_IMAGE,
      workDir,
    });

    assert.equal(command.command, "docker");
    assert.deepEqual(command.args.slice(0, 17), [
      "run",
      "--rm",
      "--interactive",
      "--tmpfs",
      "/headless-home:rw,mode=1777",
      "--user",
      "501:20",
      "--workdir",
      resolvedWorkDir,
      "--volume",
      `${resolvedWorkDir}:${resolvedWorkDir}`,
      "--volume",
      `${join(home, ".codex", "auth.json")}:/tmp/headless-host-home/.codex/auth.json:ro`,
      "--env",
      "OPENAI_API_KEY",
      "--env",
      "EXTRA_TOKEN",
    ]);
    assert.deepEqual(command.args.slice(17, 25), [
      "--env",
      "INLINE_TOKEN=value",
      "--env",
      "HOME=/headless-home",
      "--network=host",
      DEFAULT_DOCKER_IMAGE,
      "sh",
      "-lc",
    ]);
    assert.match(command.args[25] ?? "", /cp -R "\/tmp\/headless-host-home\/\." "\$HOME"/);
    assert.deepEqual(command.args.slice(26), ["headless-agent", "codex", "exec", "--json", "-"]);
    assert.equal(command.stdinText, "hello");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("wraps argument-mode commands without stdin or unrelated env", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    const resolvedWorkDir = realpathSync(workDir);

    const command = buildDockerAgentCommand({
      agent: "pi",
      command: {
        command: "pi",
        args: ["--no-session", "--mode", "json", "hello"],
      },
      dockerArgs: [],
      dockerEnv: [],
      env: { HOME: home, UNRELATED_SECRET: "nope" },
      hostUser: undefined,
      image: "custom/headless:dev",
      workDir,
    });

    assert.equal(command.command, "docker");
    assert.deepEqual(command.args.slice(0, 11), [
      "run",
      "--rm",
      "--tmpfs",
      "/headless-home:rw,mode=1777",
      "--workdir",
      resolvedWorkDir,
      "--volume",
      `${resolvedWorkDir}:${resolvedWorkDir}`,
      "--env",
      "HOME=/headless-home",
      "custom/headless:dev",
    ]);
    assert.deepEqual(command.args.slice(11, 15), ["sh", "-lc", command.args[13], "headless-agent"]);
    assert.deepEqual(command.args.slice(15), ["pi", "--no-session", "--mode", "json", "hello"]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("uses a writable container home while keeping host agent config read-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "project");
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(home, ".codex", "auth.json"), "{}");

    const command = buildDockerAgentCommand({
      agent: "codex",
      command: {
        command: "codex",
        args: ["exec", "-"],
        stdinText: "hello",
      },
      dockerArgs: [],
      dockerEnv: [],
      env: { HOME: home },
      hostUser: "501:20",
      image: DEFAULT_DOCKER_IMAGE,
      workDir,
    });

    assert.ok(command.args.includes(`${join(home, ".codex", "auth.json")}:/tmp/headless-host-home/.codex/auth.json:ro`));
    assert.ok(command.args.includes("/headless-home:rw,mode=1777"));
    assert.ok(command.args.includes("HOME=/headless-home"));
    assert.ok(!command.args.includes(`${join(home, ".codex")}:${join(home, ".codex")}:ro`));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("preserves prompt-file stdin through docker for print-command output", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "project");
    const promptFile = join(dir, "prompt.md");
    mkdirSync(home, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(promptFile, "hello");

    const command = buildDockerAgentCommand({
      agent: "claude",
      command: {
        command: "claude",
        args: ["-p"],
        stdinFile: promptFile,
      },
      dockerArgs: [],
      dockerEnv: [],
      env: { HOME: home },
      hostUser: "501:20",
      image: DEFAULT_DOCKER_IMAGE,
      workDir,
    });

    assert.match(quoteCommand(command), /^docker run --rm --interactive --tmpfs '\/headless-home:rw,mode=1777' --user 501:20 /);
    assert.match(quoteCommand(command), new RegExp(`< ${promptFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("mounts provider credential files needed by forwarded env vars", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "project");
    const googleCredentials = join(dir, "google", "service-account.json");
    mkdirSync(join(home, ".aws"), { recursive: true });
    mkdirSync(join(dir, "google"), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(home, ".aws", "config"), "[profile dev]\nregion = us-west-2\n");
    writeFileSync(join(home, ".aws", "credentials"), "[dev]\naws_access_key_id = test\n");
    writeFileSync(googleCredentials, "{}");

    const command = buildDockerAgentCommand({
      agent: "codex",
      command: {
        command: "codex",
        args: ["exec", "-"],
        stdinText: "hello",
      },
      dockerArgs: [],
      dockerEnv: [],
      env: {
        AWS_PROFILE: "dev",
        GOOGLE_APPLICATION_CREDENTIALS: googleCredentials,
        HOME: home,
      },
      hostUser: "501:20",
      image: DEFAULT_DOCKER_IMAGE,
      workDir,
    });

    assert.ok(command.args.includes(`${googleCredentials}:${googleCredentials}:ro`));
    assert.ok(command.args.includes(`${join(home, ".aws")}:/tmp/headless-host-home/.aws:ro`));
    assert.ok(command.args.includes("AWS_PROFILE"));
    assert.ok(command.args.includes("GOOGLE_APPLICATION_CREDENTIALS"));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
