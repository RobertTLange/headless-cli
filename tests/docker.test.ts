import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildDockerAgentCommand,
  dockerSessionHomePath,
  dockerSessionNativeId,
  ensureDockerSessionHome,
  ensureDockerSessionStoreDirectory,
  DEFAULT_DOCKER_IMAGE,
  readDockerCursorSessionId,
  validateDockerSessionRootWorkDir,
} from "../src/docker.ts";
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
  assert.match(dockerfile, /ARG AGY_RELEASE=\d+\.\d+\.\d+-\d+/);
  assert.match(dockerfile, /ARG AGY_SHA512_AMD64=[a-f0-9]{128}/);
  assert.match(dockerfile, /ARG AGY_SHA512_ARM64=[a-f0-9]{128}/);
  assert.match(dockerfile, /sha256sum -c -/);
  assert.match(dockerfile, /ln -sf \/opt\/cursor-agent\/cursor-agent \/usr\/local\/bin\/cursor-agent/);
  assert.match(dockerfile, /ln -sf \/usr\/local\/bin\/cursor-agent \/usr\/local\/bin\/agent/);
  assert.match(dockerfile, /storage\.googleapis\.com\/antigravity-public\/antigravity-cli/);
  assert.match(dockerfile, /sha512sum -c -/);
  assert.match(dockerfile, /install -m 0755 \/tmp\/antigravity \/usr\/local\/bin\/agy/);
  assert.match(dockerfile, /ENV AGY_CLI_DISABLE_AUTO_UPDATE=true/);
});

test("Docker image workflow publishes the pinned image for both host architectures", () => {
  const workflow = readFileSync(".github/workflows/docker-image.yml", "utf8");

  assert.match(workflow, /packages:\s+write/);
  assert.match(workflow, /ghcr\.io\/roberttlange\/headless/);
  assert.match(workflow, /platforms:\s+linux\/amd64,linux\/arm64/);
  assert.match(workflow, /docker\/build-push-action@v6/);
  assert.match(workflow, /provenance: mode=max/);
  assert.match(workflow, /sbom: true/);
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

test("mounts only selected Antigravity credential files from its state directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const home = join(dir, "home");
    const antigravityDir = join(home, ".gemini", "antigravity-cli");
    const configDir = join(home, ".gemini", "config");
    const workDir = join(dir, "project");
    mkdirSync(antigravityDir, { recursive: true });
    mkdirSync(join(antigravityDir, "brain"), { recursive: true });
    mkdirSync(configDir, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(join(antigravityDir, "antigravity-oauth-token"), "token");
    writeFileSync(join(antigravityDir, "settings.json"), "{}");
    writeFileSync(join(antigravityDir, "conversation_summaries.db"), "large state");
    writeFileSync(join(antigravityDir, "brain", "transcript.jsonl"), "history");
    writeFileSync(join(configDir, "mcp_config.json"), "{}");

    const command = buildDockerAgentCommand({
      agent: "antigravity",
      command: {
        command: "agy",
        args: ["--prompt", "hello"],
      },
      dockerArgs: [],
      dockerEnv: [],
      env: { HOME: home },
      hostUser: "501:20",
      image: DEFAULT_DOCKER_IMAGE,
      workDir,
    });

    assert.ok(
      command.args.includes(
        `${join(antigravityDir, "antigravity-oauth-token")}:/tmp/headless-host-home/.gemini/antigravity-cli/antigravity-oauth-token:ro`,
      ),
    );
    assert.ok(
      command.args.includes(
        `${join(antigravityDir, "settings.json")}:/tmp/headless-host-home/.gemini/antigravity-cli/settings.json:ro`,
      ),
    );
    assert.ok(!command.args.some((arg) => arg.includes("conversation_summaries.db")));
    assert.ok(!command.args.some((arg) => arg.includes("/antigravity-cli:/tmp/headless-host-home")));
    assert.ok(!command.args.some((arg) => arg.includes(`${configDir}:`)));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("mounts a resolved symlinked Antigravity credential file", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const home = join(dir, "home");
    const antigravityDir = join(home, ".gemini", "antigravity-cli");
    const workDir = join(dir, "project");
    const tokenFile = join(dir, "secrets", "antigravity-oauth-token");
    mkdirSync(antigravityDir, { recursive: true });
    mkdirSync(join(dir, "secrets"), { recursive: true });
    mkdirSync(workDir, { recursive: true });
    writeFileSync(tokenFile, "token");
    symlinkSync(tokenFile, join(antigravityDir, "antigravity-oauth-token"));

    const command = buildDockerAgentCommand({
      agent: "antigravity",
      command: {
        command: "agy",
        args: ["--prompt", "hello"],
      },
      dockerArgs: [],
      dockerEnv: [],
      env: { HOME: home },
      hostUser: "501:20",
      image: DEFAULT_DOCKER_IMAGE,
      workDir,
    });

    assert.ok(
      command.args.includes(
        `${realpathSync(tokenFile)}:/tmp/headless-host-home/.gemini/antigravity-cli/antigravity-oauth-token:ro`,
      ),
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("does not mount a symlinked Antigravity credential with a directory target", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const home = join(dir, "home");
    const antigravityDir = join(home, ".gemini", "antigravity-cli");
    const workDir = join(dir, "project");
    const tokenDirectory = join(dir, "secrets");
    mkdirSync(antigravityDir, { recursive: true });
    mkdirSync(tokenDirectory, { recursive: true });
    mkdirSync(workDir, { recursive: true });
    symlinkSync(tokenDirectory, join(antigravityDir, "antigravity-oauth-token"));

    const command = buildDockerAgentCommand({
      agent: "antigravity",
      command: {
        command: "agy",
        args: ["--prompt", "hello"],
      },
      dockerArgs: [],
      dockerEnv: [],
      env: { HOME: home },
      hostUser: "501:20",
      image: DEFAULT_DOCKER_IMAGE,
      workDir,
    });

    assert.ok(
      !command.args.some((arg) =>
        arg.endsWith(":/tmp/headless-host-home/.gemini/antigravity-cli/antigravity-oauth-token:ro"),
      ),
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("uses a persistent host home for durable Docker sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const home = join(dir, "home");
    const persistentHome = join(dir, "sessions", "codex", "work");
    const workDir = join(dir, "project");
    mkdirSync(home, { recursive: true });
    mkdirSync(workDir, { recursive: true });

    const command = buildDockerAgentCommand({
      agent: "codex",
      command: {
        command: "codex",
        args: ["exec", "--json", "-"],
        stdinText: "hello",
      },
      dockerArgs: ["--env", "CODEX_HOME=/headless-home/custom"],
      dockerEnv: [],
      env: { HOME: home },
      hostUser: "501:20",
      image: DEFAULT_DOCKER_IMAGE,
      persistentHome,
      workDir,
    });

    assert.ok(command.args.includes(`${persistentHome}:/headless-home:rw`));
    assert.ok(!command.args.includes("/headless-home:rw,mode=1777"));
    assert.match(command.args.find((arg) => arg.includes("cp -R -n")) ?? "", /cp -R -n/);
    assert.match(command.args.find((arg) => arg.includes("cp -R -n")) ?? "", /export HOME="\/headless-home"/);
    assert.match(command.args.find((arg) => arg.includes("cp -R -n")) ?? "", /unset CODEX_HOME/);
    assert.equal(
      dockerSessionNativeId("pi", join(persistentHome, ".pi", "agent", "sessions", "turn.jsonl"), persistentHome),
      "/headless-home/.pi/agent/sessions/turn.jsonl",
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("requires an absolute configured Docker session root", () => {
  assert.throws(
    () =>
      dockerSessionHomePath("codex", "work", {
        HEADLESS_DOCKER_SESSION_ROOT: ".headless/docker-sessions",
        HOME: "/home/test",
      }),
    /HEADLESS_DOCKER_SESSION_ROOT must be an absolute path/,
  );
  assert.equal(
    dockerSessionHomePath("codex", "work", {
      HEADLESS_DOCKER_SESSION_ROOT: "/var/lib/headless-sessions",
      HOME: "/home/test",
    }),
    "/var/lib/headless-sessions/codex/work-00e13ed7af55b27622f1d6eab5bec0147e68efe28dc2b12461117afa1a5ed40e",
  );
});

test("uses distinct Docker homes for aliases that differ only by case", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const env = { HEADLESS_DOCKER_SESSION_ROOT: join(dir, "sessions") };
    const lowerHome = dockerSessionHomePath("codex", "work", env) as string;
    const upperHome = dockerSessionHomePath("codex", "WORK", env) as string;

    assert.notEqual(lowerHome.toLowerCase(), upperHome.toLowerCase());
    assert.notEqual(ensureDockerSessionHome(lowerHome), ensureDockerSessionHome(upperHome));
    assert.notEqual(statSync(lowerHome).ino, statSync(upperHome).ino);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("bounds long Docker session directory names without alias collisions", () => {
  const root = "/var/lib/headless-sessions";
  const sharedPrefix = "a".repeat(200);
  const first = dockerSessionHomePath("codex", `${sharedPrefix}x`, { HEADLESS_DOCKER_SESSION_ROOT: root }) as string;
  const second = dockerSessionHomePath("codex", `${sharedPrefix}y`, { HEADLESS_DOCKER_SESSION_ROOT: root }) as string;

  assert.ok(first.length < root.length + 180);
  assert.notEqual(first, second);
});

test("rejects workdirs that overlap the Docker container home target", () => {
  for (const workDir of ["/headless-home", "/headless-home/project"]) {
    assert.throws(
      () => validateDockerSessionRootWorkDir("/var/lib/headless-sessions/codex/work", workDir),
      /work dir must not overlap the container home/,
    );
  }
});

test("maps Pi transcripts stored through a former symlinked Docker root", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const targetHome = join(dir, "target", "sessions", "pi", "work");
    const linkedRoot = join(dir, "current");
    const transcriptSuffix = join(".pi", "agent", "sessions", "turn.jsonl");
    mkdirSync(join(targetHome, ".pi", "agent", "sessions"), { recursive: true });
    writeFileSync(join(targetHome, transcriptSuffix), "{}\n");
    symlinkSync(join(dir, "target"), linkedRoot);

    assert.equal(
      dockerSessionNativeId("pi", join(linkedRoot, "sessions", "pi", "work", transcriptSuffix), realpathSync(targetHome)),
      `/headless-home/${transcriptSuffix}`,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rejects symlinked Docker session path components", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const root = join(dir, "sessions");
    const external = join(dir, "external");
    mkdirSync(join(root, "codex"), { recursive: true });
    mkdirSync(external);
    symlinkSync(external, join(root, "codex", "work"));

    assert.throws(
      () => ensureDockerSessionHome(join(root, "codex", "work")),
      /symbolic link/,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("enforces private permissions on existing Docker session directories", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const root = join(dir, "sessions");
    const agentDir = join(root, "codex");
    const sessionHome = join(agentDir, "work");
    mkdirSync(sessionHome, { recursive: true });
    chmodSync(root, 0o755);
    chmodSync(agentDir, 0o755);
    chmodSync(sessionHome, 0o755);

    ensureDockerSessionHome(sessionHome);

    assert.equal(statSync(root).mode & 0o777, 0o755);
    for (const path of [agentDir, sessionHome]) {
      assert.equal(statSync(path).mode & 0o777, 0o700);
    }
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rejects an unsafe existing Docker session root without mutating it", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const root = join(dir, "sessions");
    mkdirSync(root);
    chmodSync(root, 0o777);

    assert.throws(
      () => ensureDockerSessionHome(join(root, "codex", "work")),
      /root must not be group- or world-writable/,
    );
    assert.equal(statSync(root).mode & 0o777, 0o777);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rejects Docker session roots below writable non-sticky parents", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const unsafeParent = join(dir, "shared");
    const root = join(unsafeParent, "sessions");
    mkdirSync(root, { recursive: true });
    chmodSync(unsafeParent, 0o777);

    assert.throws(
      () => ensureDockerSessionHome(join(root, "codex", "work")),
      /root ancestor is writable by other users/,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("returns a canonical Docker session home despite ancestor symlink changes", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const firstTarget = join(dir, "first");
    const secondTarget = join(dir, "second");
    const linkedRoot = join(dir, "current");
    mkdirSync(firstTarget);
    mkdirSync(secondTarget);
    symlinkSync(firstTarget, linkedRoot);

    const sessionHome = ensureDockerSessionHome(join(linkedRoot, "sessions", "codex", "work"));
    unlinkSync(linkedRoot);
    symlinkSync(secondTarget, linkedRoot);

    assert.equal(sessionHome, realpathSync(join(firstTarget, "sessions", "codex", "work")));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rejects permissive macOS ACLs on Docker session roots", { skip: process.platform !== "darwin" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const root = join(dir, "sessions");
    mkdirSync(root);
    const acl = spawnSync(
      "/bin/chmod",
      ["+a", "everyone allow list,search,add_file,add_subdirectory,delete_child", root],
      { encoding: "utf8" },
    );
    assert.equal(acl.status, 0, acl.stderr);

    assert.throws(
      () => ensureDockerSessionHome(join(root, "codex", "work")),
      /permissive access ACL/,
    );
    assert.equal(existsSync(join(root, "codex")), false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rejects symlinked Docker session metadata directories", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const sessionHome = ensureDockerSessionHome(join(dir, "sessions", "codex", "work"));
    const external = join(dir, "external");
    mkdirSync(external);
    symlinkSync(external, join(sessionHome, ".headless"));

    assert.throws(
      () => ensureDockerSessionStoreDirectory(sessionHome),
      /symbolic link/,
    );
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("rejects durable Docker session homes on Windows", { skip: process.platform !== "win32" }, () => {
  assert.throws(
    () => ensureDockerSessionHome("C:\\headless-sessions\\codex\\work"),
    /not supported on Windows/,
  );
});

test("reads regular Docker Cursor session IDs and rejects symlinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const persistentHome = join(dir, "session");
    const externalId = join(dir, "external-id");
    mkdirSync(persistentHome);
    const marker = join(persistentHome, ".headless-cursor-session-id");
    writeFileSync(marker, "cursor-chat\n");

    assert.equal(readDockerCursorSessionId(persistentHome), "cursor-chat");

    rmSync(marker);
    writeFileSync(externalId, "external-chat\n");
    symlinkSync(externalId, marker);

    assert.equal(readDockerCursorSessionId(persistentHome), "");

    if (process.platform !== "win32") {
      rmSync(marker);
      const fifo = spawnSync("mkfifo", [marker], { encoding: "utf8" });
      assert.equal(fifo.status, 0, fifo.stderr);
      assert.equal(readDockerCursorSessionId(persistentHome), "");
    }
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
