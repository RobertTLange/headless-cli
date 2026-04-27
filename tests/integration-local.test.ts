import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const agents = ["claude", "codex", "cursor", "gemini", "opencode", "pi"] as const;
const selectedAgents = parseSelectedAgents(process.env.HEADLESS_INTEGRATION_AGENTS);
const commandTimeoutMs = Number.parseInt(process.env.HEADLESS_INTEGRATION_TIMEOUT_MS ?? "300000", 10);
const dockerTimeoutMs = Number.parseInt(process.env.HEADLESS_INTEGRATION_DOCKER_TIMEOUT_MS ?? "900000", 10);
const modalTimeoutMs = Number.parseInt(process.env.HEADLESS_INTEGRATION_MODAL_TIMEOUT_MS ?? "1200000", 10);
const suiteNonce = `headless-local-${Date.now()}-${process.pid}`;
const createdTmuxSessions = new Set<string>();
const createdCursorTrustDirs = new Set<string>();

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
}

function parseSelectedAgents(value: string | undefined): readonly (typeof agents)[number][] {
  if (!value || value === "all") {
    return agents;
  }

  const selected = value
    .split(",")
    .map((agent) => agent.trim())
    .filter(Boolean);

  for (const agent of selected) {
    assert.ok(
      agents.includes(agent as (typeof agents)[number]),
      `HEADLESS_INTEGRATION_AGENTS contains unsupported agent: ${agent}`,
    );
  }
  assert.ok(selected.length > 0, "HEADLESS_INTEGRATION_AGENTS must select at least one agent");

  return selected as (typeof agents)[number][];
}

async function run(command: string, args: string[], options: RunOptions = {}): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? commandTimeoutMs;
  return await new Promise<CommandResult>((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    }, timeoutMs);

    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      stderr += `${error.message}\n`;
      finish(127);
    });
    child.on("close", (code, signal) => {
      finish(timedOut ? 124 : signal ? 1 : (code ?? 1));
    });
  });
}

async function headless(args: string[], options: RunOptions = {}): Promise<CommandResult> {
  return await run(process.env.HEADLESS_BIN ?? "headless", args, options);
}

function assertSuccess(result: CommandResult, label: string): void {
  assert.equal(
    result.code,
    0,
    [
      `${label} failed with exit code ${result.code}${result.timedOut ? " after timeout" : ""}`,
      "stdout:",
      result.stdout,
      "stderr:",
      result.stderr,
    ].join("\n"),
  );
}

function assertNonce(result: CommandResult, nonce: string, label: string): void {
  assertSuccess(result, label);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(escapeRegExp(nonce)),
    `${label} did not include nonce ${nonce}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function prompt(nonce: string): string {
  return `Read-only check. Reply with this nonce and no file edits: ${nonce}`;
}

function tempWorkdir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `headless-${label}-`));
  writeFileSync(join(dir, "README.md"), `# ${label}\n\nTemporary Headless local integration workspace.\n`);
  return dir;
}

function prepareAgentWorkdir(agent: (typeof agents)[number], dir: string): void {
  if (agent === "cursor") {
    trustCursorWorkspace(dir);
  }
}

function trustCursorWorkspace(dir: string): void {
  const workspace = realpathSync(dir);
  const projectDir = join(process.env.HOME ?? homedir(), ".cursor", "projects", cursorProjectKey(workspace));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, ".workspace-trusted"),
    `${JSON.stringify({ trustedAt: new Date().toISOString(), workspacePath: workspace }, null, 2)}\n`,
  );
  createdCursorTrustDirs.add(projectDir);
}

function cursorProjectKey(workspace: string): string {
  return workspace.replace(/^\/+/, "").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function tempGitWorkdir(label: string): Promise<string> {
  const dir = tempWorkdir(label);
  assertSuccess(await run("git", ["init"], { cwd: dir, timeoutMs: 30000 }), "git init");
  return dir;
}

function sessionsPath(): string {
  return join(process.env.HOME ?? homedir(), ".headless", "sessions.json");
}

function snapshotSessionStore(): () => void {
  const path = sessionsPath();
  const existed = existsSync(path);
  const original = existed ? readFileSync(path) : undefined;
  return () => {
    if (original) {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, original);
      return;
    }
    if (!existed) {
      rmSync(path, { force: true });
    }
  };
}

function modalConfigured(): boolean {
  return Boolean(
    (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) ||
      existsSync(join(process.env.HOME ?? homedir(), ".modal.toml")),
  );
}

async function killCreatedTmuxSessions(): Promise<void> {
  await Promise.all(
    [...createdTmuxSessions].map((session) =>
      run("tmux", ["kill-session", "-t", session], { timeoutMs: 30000 }).catch(() => ({
        code: 1,
        stdout: "",
        stderr: "",
        timedOut: false,
      })),
    ),
  );
}

test.after(async () => {
  await killCreatedTmuxSessions();
  for (const dir of createdCursorTrustDirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("preflight verifies global Headless, selected backends, Docker, Modal, and tmux", { timeout: 120000 }, async () => {
  const help = await headless(["--help"], { timeoutMs: 30000 });
  assertSuccess(help, "headless --help");
  assert.match(help.stdout, /--session/, "global headless must support --session; reinstall or npm link this repo");

  const check = await headless(["--check"], { timeoutMs: 120000 });
  assertSuccess(check, "headless --check");
  for (const agent of selectedAgents) {
    assert.match(
      check.stdout,
      new RegExp(`^${agent}\\s+✓\\s+`, "m"),
      `missing ${agent} backend in \`headless --check\`; install and authenticate all six backends`,
    );
  }
  assert.match(check.stdout, /^docker\s+✓\s+/m, "Docker must be installed and running");

  const docker = await run("docker", ["info"], { timeoutMs: 30000 });
  assertSuccess(docker, "docker info");

  const tmux = await run("tmux", ["-V"], { timeoutMs: 30000 });
  assertSuccess(tmux, "tmux -V");

  assert.equal(
    modalConfigured(),
    true,
    "Modal must be configured with MODAL_TOKEN_ID/MODAL_TOKEN_SECRET or ~/.modal.toml",
  );
});

test("selected backends complete a basic read-only run", { timeout: commandTimeoutMs * selectedAgents.length }, async () => {
  for (const agent of selectedAgents) {
    const dir = tempWorkdir(`${agent}-basic`);
    try {
      prepareAgentWorkdir(agent, dir);
      const nonce = `${suiteNonce}-${agent}-basic`;
      const result = await headless([agent, "--work-dir", dir, "--allow", "read-only", "--prompt", prompt(nonce)], {
        timeoutMs: commandTimeoutMs,
      });
      assertNonce(result, nonce, `${agent} basic run`);
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

test("selected backends support --json, --debug, and --usage", { timeout: commandTimeoutMs * selectedAgents.length * 3 }, async () => {
  for (const agent of selectedAgents) {
    for (const mode of ["--json", "--debug", "--usage"]) {
      const dir = tempWorkdir(`${agent}-${mode.slice(2)}`);
      try {
        prepareAgentWorkdir(agent, dir);
        const nonce = `${suiteNonce}-${agent}-${mode.slice(2)}`;
        const result = await headless(
          [agent, "--work-dir", dir, "--allow", "read-only", mode, "--prompt", prompt(nonce)],
          { timeoutMs: commandTimeoutMs },
        );
        assertNonce(result, nonce, `${agent} ${mode}`);
        if (mode === "--usage") {
          assert.match(result.stdout, /"usage"\s*:/, `${agent} --usage did not print usage JSON`);
        }
      } finally {
        rmSync(dir, { force: true, recursive: true });
      }
    }
  }
});

test("selected backends start and resume native --session aliases", { timeout: commandTimeoutMs * selectedAgents.length * 2 }, async () => {
  const restoreSessions = snapshotSessionStore();
  try {
    for (const agent of selectedAgents) {
      const dir = tempWorkdir(`${agent}-session`);
      try {
        prepareAgentWorkdir(agent, dir);
        const alias = `${suiteNonce}-${agent}-native`.replace(/[^A-Za-z0-9_.-]/g, "-");
        const firstNonce = `${alias}-start`;
        const secondNonce = `${alias}-resume`;
        assertNonce(
          await headless([agent, "--work-dir", dir, "--allow", "read-only", "--session", alias, "--prompt", prompt(firstNonce)], {
            timeoutMs: commandTimeoutMs,
          }),
          firstNonce,
          `${agent} --session start`,
        );
        assertNonce(
          await headless(
            [agent, "--work-dir", dir, "--allow", "read-only", "--session", alias, "--prompt", prompt(secondNonce)],
            { timeoutMs: commandTimeoutMs },
          ),
          secondNonce,
          `${agent} --session resume`,
        );
      } finally {
        rmSync(dir, { force: true, recursive: true });
      }
    }
  } finally {
    restoreSessions();
  }
});

test("selected backends start and send to --tmux --session aliases", { timeout: commandTimeoutMs * selectedAgents.length * 2 }, async () => {
  for (const agent of selectedAgents) {
    const dir = tempWorkdir(`${agent}-tmux`);
    const alias = `${suiteNonce}-${agent}-tmux`.replace(/[^A-Za-z0-9_.-]/g, "-");
    const sessionName = `headless-${agent}-${alias}`;
    createdTmuxSessions.add(sessionName);
    try {
      const first = await headless(
        [agent, "--work-dir", dir, "--allow", "read-only", "--tmux", "--session", alias, "--prompt", prompt(`${alias}-start`)],
        { timeoutMs: commandTimeoutMs },
      );
      assertSuccess(first, `${agent} --tmux --session start`);
      assert.match(first.stdout, new RegExp(`tmux session: ${escapeRegExp(sessionName)}`));

      const second = await headless(
        [agent, "--work-dir", dir, "--allow", "read-only", "--tmux", "--session", alias, "--prompt", prompt(`${alias}-send`)],
        { timeoutMs: commandTimeoutMs },
      );
      assertSuccess(second, `${agent} --tmux --session send`);
      assert.match(second.stdout, new RegExp(`sent: ${escapeRegExp(sessionName)}`));
    } finally {
      await run("tmux", ["kill-session", "-t", sessionName], { timeoutMs: 30000 });
      createdTmuxSessions.delete(sessionName);
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

test("Codex completes through Docker", { timeout: dockerTimeoutMs }, async () => {
  const dir = tempWorkdir("codex-docker");
  try {
    const nonce = `${suiteNonce}-codex-docker`;
    const result = await headless(
      ["codex", "--docker", "--work-dir", dir, "--allow", "read-only", "--prompt", prompt(nonce)],
      { timeoutMs: dockerTimeoutMs },
    );
    assertNonce(result, nonce, "Codex Docker smoke");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("Codex Docker non-smoke modes return nonce output", { timeout: dockerTimeoutMs * 3 }, async () => {
  for (const mode of ["--json", "--debug", "--usage"]) {
    const dir = tempWorkdir(`codex-docker-${mode.slice(2)}`);
    try {
      const nonce = `${suiteNonce}-codex-docker-${mode.slice(2)}`;
      const result = await headless(
        ["codex", "--docker", "--work-dir", dir, "--allow", "read-only", mode, "--prompt", prompt(nonce)],
        { timeoutMs: dockerTimeoutMs },
      );
      assertNonce(result, nonce, `Codex Docker ${mode}`);
      if (mode === "--usage") {
        assert.match(result.stdout, /"usage"\s*:/, "Codex Docker --usage did not print usage JSON");
      }
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});

test("Codex completes through Modal in a temporary git workdir", { timeout: modalTimeoutMs }, async () => {
  const dir = await tempGitWorkdir("codex-modal");
  try {
    const nonce = `${suiteNonce}-codex-modal`;
    const result = await headless(
      [
        "codex",
        "--modal",
        "--modal-timeout",
        String(Math.ceil(modalTimeoutMs / 1000)),
        "--work-dir",
        dir,
        "--allow",
        "read-only",
        "--prompt",
        prompt(nonce),
      ],
      { timeoutMs: modalTimeoutMs },
    );
    assertNonce(result, nonce, "Codex Modal smoke");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("Codex Modal non-smoke modes return nonce output", { timeout: modalTimeoutMs * 3 }, async () => {
  for (const mode of ["--json", "--debug", "--usage"]) {
    const dir = await tempGitWorkdir(`codex-modal-${mode.slice(2)}`);
    try {
      const nonce = `${suiteNonce}-codex-modal-${mode.slice(2)}`;
      const result = await headless(
        [
          "codex",
          "--modal",
          "--modal-timeout",
          String(Math.ceil(modalTimeoutMs / 1000)),
          "--work-dir",
          dir,
          "--allow",
          "read-only",
          mode,
          "--prompt",
          prompt(nonce),
        ],
        { timeoutMs: modalTimeoutMs },
      );
      assertNonce(result, nonce, `Codex Modal ${mode}`);
      if (mode === "--usage") {
        assert.match(result.stdout, /"usage"\s*:/, "Codex Modal --usage did not print usage JSON");
      }
    } finally {
      rmSync(dir, { force: true, recursive: true });
    }
  }
});
