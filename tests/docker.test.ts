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

const dockerfile = readFileSync("Dockerfile", "utf8");
const dockerWorkflow = readFileSync(".github/workflows/docker-image.yml", "utf8");

test("Dockerfile exposes Cursor agent from a non-root path", () => {
  assert.match(dockerfile, /^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /@anthropic-ai\/claude-code@\d+\.\d+\.\d+/);
  assert.match(dockerfile, /@google\/gemini-cli@\d+\.\d+\.\d+/);
  assert.match(dockerfile, /@mariozechner\/pi-coding-agent@\d+\.\d+\.\d+/);
  assert.match(dockerfile, /@openai\/codex@0\.147\.0/);
  assert.match(dockerfile, /opencode-ai@\d+\.\d+\.\d+/);
  assert.match(dockerfile, /ARG CURSOR_AGENT_VERSION=\d{4}\.\d{2}\.\d{2}-[a-f0-9]+/);
  assert.match(dockerfile, /ARG CURSOR_AGENT_SHA256_AMD64=[a-f0-9]{64}/);
  assert.match(dockerfile, /ARG CURSOR_AGENT_SHA256_ARM64=[a-f0-9]{64}/);
  assert.match(dockerfile, /ARG AGY_VERSION=\d+\.\d+\.\d+/);
  assert.match(dockerfile, /ARG AGY_SHA256_AMD64=[a-f0-9]{64}/);
  assert.match(dockerfile, /ARG AGY_SHA256_ARM64=[a-f0-9]{64}/);
  assert.match(dockerfile, /sha256sum -c -/);
  assert.match(dockerfile, /ln -sf \/opt\/cursor-agent\/cursor-agent \/usr\/local\/bin\/cursor-agent/);
  assert.match(dockerfile, /ln -sf \/usr\/local\/bin\/cursor-agent \/usr\/local\/bin\/agent/);
  assert.match(dockerfile, /github\.com\/google-antigravity\/antigravity-cli\/releases\/download/);
  assert.match(dockerfile, /install -m 0755 \/tmp\/antigravity \/usr\/local\/bin\/agy/);
  assert.match(dockerfile, /ENV AGY_CLI_DISABLE_AUTO_UPDATE=true/);
});

test("Dockerfile links published images to the source repository", () => {
  assert.match(
    dockerfile,
    /^LABEL org\.opencontainers\.image\.source=https:\/\/github\.com\/RobertTLange\/headless-cli$/m,
  );
});

test("Docker image workflow publishes the pinned image for both host architectures", () => {
  assert.match(dockerWorkflow, /packages:\s+write/);
  assert.match(dockerWorkflow, /ghcr\.io\/roberttlange\/headless/);
  assert.match(dockerWorkflow, /platforms:\s+linux\/amd64,linux\/arm64/);
  assert.match(dockerWorkflow, /docker\/build-push-action@[a-f0-9]{40} # v6/);
  assert.match(dockerWorkflow, /persist-credentials: false/);
  assert.match(dockerWorkflow, /provenance: mode=max/);
  assert.match(dockerWorkflow, /sbom: true/);
});

test("Docker image workflow runs for published releases and manual recovery", () => {
  assert.match(
    dockerWorkflow,
    /on:\s+release:\s+types:\s+- published\s+workflow_dispatch:/,
  );
});

test("Docker image workflow only manually publishes the default branch", () => {
  assert.match(dockerWorkflow, /if: >-\s+github\.event_name == 'release' \|\|/);
  assert.match(
    dockerWorkflow,
    /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/,
  );
  assert.match(dockerWorkflow, /environment: docker-publish/);
});

test("Docker image workflow keeps prereleases off latest", () => {
  assert.match(dockerWorkflow, /flavor: latest=false/);
  assert.match(
    dockerWorkflow,
    /if: github\.event_name != 'release' \|\| !github\.event\.release\.prerelease/,
  );
});

test("Docker image workflow serializes every publish", () => {
  assert.match(
    dockerWorkflow,
    /concurrency:\s+group: docker-image-publish\s+cancel-in-progress: false\s+queue: max/,
  );
});

test("Docker image workflow only promotes the freshest stable release", () => {
  const buildIndex = dockerWorkflow.indexOf("- name: Build and push");
  const promotionIndex = dockerWorkflow.indexOf("- name: Promote current image to latest");
  const buildBlock = dockerWorkflow.slice(buildIndex, promotionIndex);

  assert.notEqual(buildIndex, -1);
  assert.ok(promotionIndex > buildIndex);
  assert.match(buildBlock, /push: true/);
  assert.match(buildBlock, /tags: \$\{\{ steps\.meta\.outputs\.tags \}\}/);
  assert.match(dockerWorkflow, /id: build/);
  assert.match(dockerWorkflow, /type=ref,event=tag/);
  assert.match(dockerWorkflow, /type=sha,format=long,prefix=sha-/);
  assert.match(dockerWorkflow, /gh api "repos\/\$GITHUB_REPOSITORY\/releases\/latest" --jq \.tag_name/);
  assert.match(dockerWorkflow, /"\$RELEASE_TAG" != "\$latest_release_tag"/);
  assert.doesNotMatch(dockerWorkflow, /releases\/latest.*\|\| true/);
  assert.match(dockerWorkflow, /IMAGE_DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/);
  assert.match(
    dockerWorkflow,
    /docker buildx imagetools create --tag "\$IMAGE_NAME:latest" "\$IMAGE_NAME@\$IMAGE_DIGEST"/,
  );
});

test("Docker image workflow rejects a stale manual dispatch", () => {
  const validationIndex = dockerWorkflow.indexOf("- name: Validate manual source");
  const buildIndex = dockerWorkflow.indexOf("- name: Build and push");
  const promotionIndex = dockerWorkflow.indexOf("- name: Promote current image to latest");
  const defaultHeadCheckIndices = [
    ...dockerWorkflow.matchAll(
      /gh api "repos\/\$GITHUB_REPOSITORY\/commits\/\$DEFAULT_BRANCH" --jq \.sha/g,
    ),
  ].map((match) => match.index);

  assert.notEqual(validationIndex, -1);
  assert.ok(validationIndex < buildIndex);
  assert.ok(buildIndex < promotionIndex);
  assert.equal(defaultHeadCheckIndices.length, 2);
  assert.ok((defaultHeadCheckIndices[0] ?? -1) > validationIndex);
  assert.ok((defaultHeadCheckIndices[0] ?? -1) < buildIndex);
  assert.ok((defaultHeadCheckIndices[1] ?? -1) > promotionIndex);
  assert.match(dockerWorkflow, /DEFAULT_BRANCH: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(dockerWorkflow, /"\$GITHUB_SHA" != "\$default_branch_sha"/);
  assert.match(dockerWorkflow, /exit 1/);
});

test("Docker image workflow isolates release caches while reusing the default-branch cache", () => {
  const cacheScope = /\$\{\{ github\.event_name == 'workflow_dispatch' && 'main' \|\| github\.sha \}\}/;

  assert.match(dockerWorkflow, new RegExp(`cache-from:[\\s\\S]*scope=docker-${cacheScope.source}`));
  assert.match(dockerWorkflow, /cache-from:[\s\S]*type=gha,scope=docker-main/);
  assert.match(dockerWorkflow, new RegExp(`cache-to: type=gha,mode=max,scope=docker-${cacheScope.source}`));
});

test("Docker image workflow pins every action to a commit", () => {
  const actionReferences = [...dockerWorkflow.matchAll(/^\s+uses:\s+([^@\s]+)@(\S+)(?:\s+#.*)?$/gm)];

  assert.equal(actionReferences.length, 6);
  for (const [, action, revision] of actionReferences) {
    assert.match(revision ?? "", /^[a-f0-9]{40}$/, `${action} must use a full commit SHA`);
  }
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

test("forwards Sakana credentials to Docker without rendering the secret value", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const home = join(dir, "home");
    const workDir = join(dir, "project");
    mkdirSync(home);
    mkdirSync(workDir);

    const command = buildDockerAgentCommand({
      agent: "codex",
      command: { command: "codex", args: ["exec", "-"] },
      dockerArgs: [],
      dockerEnv: [],
      env: { HOME: home, SAKANA_API_KEY: "sakana-secret" },
      image: DEFAULT_DOCKER_IMAGE,
      workDir,
    });

    const rendered = quoteCommand(command);
    assert.match(rendered, /--env SAKANA_API_KEY/);
    assert.doesNotMatch(rendered, /sakana-secret/);
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

test("mounts a selected Codex profile and its relative catalog for Docker", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const home = join(dir, "home");
    const codexHome = join(dir, "codex-home");
    const workDir = join(dir, "project");
    const profilePath = join(codexHome, "fugu.config.toml");
    const catalogPath = join(codexHome, "fugu.json");
    mkdirSync(home);
    mkdirSync(codexHome);
    mkdirSync(workDir);
    writeFileSync(join(codexHome, "config.toml"), '[model_providers.sakana]\nname = "Sakana"\n');
    writeFileSync(profilePath, 'model_catalog_json = "fugu.json"\n');
    writeFileSync(catalogPath, '{"models":[]}\n');

    const command = buildDockerAgentCommand({
      agent: "codex",
      command: { command: "codex", args: ["--profile", "fugu", "exec", "-"] },
      dockerArgs: [],
      dockerEnv: [],
      env: { CODEX_HOME: codexHome, HOME: home },
      image: DEFAULT_DOCKER_IMAGE,
      profile: "fugu",
      workDir,
    });

    assert.ok(
      command.args.includes(`${profilePath}:/tmp/headless-host-home/.codex/fugu.config.toml:ro`),
    );
    assert.ok(
      command.args.includes(`${join(codexHome, "config.toml")}:/tmp/headless-host-home/.codex/config.toml:ro`),
    );
    assert.ok(command.args.includes(`${catalogPath}:/headless-home/.codex/fugu.json:ro`));
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

test("refreshes a Codex profile when resuming a durable Docker session", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-docker-test-"));
  try {
    const codexHome = join(dir, "codex-home");
    const persistentHome = join(dir, "sessions", "codex", "work");
    const workDir = join(dir, "project");
    mkdirSync(codexHome);
    mkdirSync(workDir);
    writeFileSync(join(codexHome, "auth.json"), "{}");
    writeFileSync(join(codexHome, "fugu.config.toml"), 'model = "fugu"\n');

    const command = buildDockerAgentCommand({
      agent: "codex",
      command: { command: "codex", args: ["--profile", "fugu", "exec", "-"] },
      dockerArgs: [],
      dockerEnv: [],
      env: { CODEX_HOME: codexHome },
      image: DEFAULT_DOCKER_IMAGE,
      persistentHome,
      profile: "fugu",
      workDir,
    });

    const bootstrap = command.args.find((arg) => arg.includes("cp -R -n")) ?? "";
    assert.match(
      bootstrap,
      /cp -f "\/tmp\/headless-host-home\/\.codex\/fugu\.config\.toml" "\$HOME\/\.codex\/fugu\.config\.toml"/,
    );
    assert.doesNotMatch(bootstrap, /cp -f .*auth\.json/);
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
