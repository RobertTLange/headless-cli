import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildModalRunSummary,
  collectModalEnv,
  DEFAULT_MODAL_APP,
  DEFAULT_MODAL_CPU,
  DEFAULT_MODAL_IMAGE,
  DEFAULT_MODAL_MEMORY_MIB,
  DEFAULT_MODAL_TIMEOUT_SECONDS,
  executeModalAgent,
  syncWorkspace,
  type ModalClientLike,
  type ModalExecParams,
  type ModalProcessLike,
  type ModalReadStreamLike,
  type ModalSandboxCreateParams,
  type ModalSandboxLike,
  type ModalWriteStreamLike,
} from "../src/modal.ts";
import { quoteCommand } from "../src/shell.ts";

test("builds a printable Modal sandbox summary command", () => {
  const summary = buildModalRunSummary({
    appName: "headless-dev",
    command: { command: "codex", args: ["exec", "--json", "-"], stdinText: "hello" },
    cpu: 4,
    image: "custom/headless:modal",
    imageSecret: "ghcr",
    memoryMiB: 8192,
    modalSecrets: ["openai"],
    timeoutSeconds: 900,
    workDir: "/repo",
  });

  assert.equal(
    quoteCommand(summary),
    "printf %s hello | modal-sandbox run --app headless-dev --image custom/headless:modal --cpu 4 --memory 8192 --timeout 900 --work-dir /repo --image-secret ghcr --secret openai -- codex exec --json -",
  );
});

test("collects Modal env from curated, command, explicit, and HOME entries", () => {
  assert.deepEqual(
    collectModalEnv(
      { OPENAI_API_KEY: "sk-test", EXTRA_TOKEN: "extra", HOME: "/home/rob" },
      { CURSOR_API_KEY: "cursor" },
      ["EXTRA_TOKEN", "INLINE_TOKEN=value"],
    ),
    {
      CURSOR_API_KEY: "cursor",
      EXTRA_TOKEN: "extra",
      HOME: "/home/node",
      INLINE_TOKEN: "value",
      OPENAI_API_KEY: "sk-test",
    },
  );
});

test("syncWorkspace applies remote changes and skips local conflicts", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-modal-sync-"));
  try {
    const baseline = join(dir, "baseline");
    const result = join(dir, "result");
    const work = join(dir, "work");
    mkdirSync(baseline);
    mkdirSync(result);
    mkdirSync(work);
    writeFileSync(join(baseline, "changed.txt"), "before");
    writeFileSync(join(baseline, "deleted.txt"), "delete");
    writeFileSync(join(baseline, "conflict.txt"), "base");
    writeFileSync(join(result, "changed.txt"), "after");
    writeFileSync(join(result, "created.txt"), "new");
    writeFileSync(join(result, "conflict.txt"), "remote");
    writeFileSync(join(work, "changed.txt"), "before");
    writeFileSync(join(work, "deleted.txt"), "delete");
    writeFileSync(join(work, "conflict.txt"), "local");

    const sync = syncWorkspace({ baselineDir: baseline, resultDir: result, workDir: work });

    assert.deepEqual(sync.changed.sort(), ["changed.txt", "created.txt", "deleted.txt"]);
    assert.deepEqual(sync.conflicts, ["conflict.txt"]);
    assert.equal(readFileSync(join(work, "changed.txt"), "utf8"), "after");
    assert.equal(readFileSync(join(work, "created.txt"), "utf8"), "new");
    assert.equal(readFileSync(join(work, "conflict.txt"), "utf8"), "local");
    assert.equal(existsSync(join(work, "deleted.txt")), false);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("syncWorkspace applies remote changes under generated directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-modal-sync-generated-"));
  try {
    const baseline = join(dir, "baseline");
    const result = join(dir, "result");
    const work = join(dir, "work");
    mkdirSync(join(baseline, "dist"), { recursive: true });
    mkdirSync(join(result, "dist"), { recursive: true });
    mkdirSync(join(work, "dist"), { recursive: true });
    writeFileSync(join(baseline, "dist", "bundle.js"), "before");
    writeFileSync(join(result, "dist", "bundle.js"), "after");
    writeFileSync(join(work, "dist", "bundle.js"), "before");

    const sync = syncWorkspace({ baselineDir: baseline, resultDir: result, workDir: work });

    assert.deepEqual(sync.changed, ["dist/bundle.js"]);
    assert.deepEqual(sync.conflicts, []);
    assert.equal(readFileSync(join(work, "dist", "bundle.js"), "utf8"), "after");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("executeModalAgent runs through a Modal client and syncs results back", async () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-modal-exec-"));
  try {
    const work = join(dir, "work");
    const remote = join(dir, "remote");
    mkdirSync(work);
    mkdirSync(remote);
    writeFileSync(join(work, "input.txt"), "local");
    const sandbox = new FakeSandbox(remote);
    const client = new FakeModalClient(sandbox);
    const stderr: string[] = [];

    const result = await executeModalAgent({
      agent: "codex",
      appName: "headless-test",
      command: { command: "codex", args: ["exec", "--json", "-"], stdinText: "prompt" },
      cpu: DEFAULT_MODAL_CPU,
      env: { HOME: join(dir, "home"), OPENAI_API_KEY: "sk-test" },
      image: DEFAULT_MODAL_IMAGE,
      imageSecret: "ghcr",
      includeGit: false,
      memoryMiB: DEFAULT_MODAL_MEMORY_MIB,
      modalEnv: ["EXTRA_TOKEN=value"],
      modalSecrets: ["provider-secret"],
      stderr: (text) => stderr.push(text),
      stdout: () => {},
      stdoutHandling: "capture",
      timeoutSeconds: DEFAULT_MODAL_TIMEOUT_SECONDS,
      workDir: work,
      clientFactory: async () => client,
    });

    assert.equal(result.code, 0);
    assert.match(result.stdout, /modal final/);
    assert.equal(readFileSync(join(work, "input.txt"), "utf8"), "remote");
    assert.equal(readFileSync(join(work, "created.txt"), "utf8"), "created");
    assert.equal(sandbox.terminated, true);
    assert.equal(client.closed, true);
    assert.equal(client.appName, "headless-test");
    assert.equal(client.image, DEFAULT_MODAL_IMAGE);
    assert.equal(client.imageSecretName, "ghcr");
    assert.equal(client.secretNames.join(","), "ghcr,provider-secret");
    assert.equal(sandbox.createParams?.cpu, DEFAULT_MODAL_CPU);
    assert.equal(sandbox.createParams?.env?.OPENAI_API_KEY, "sk-test");
    assert.equal(sandbox.createParams?.env?.EXTRA_TOKEN, "value");
    assert.deepEqual(sandbox.agentCommand, ["sh", "-lc", sandbox.agentCommand?.[2], "headless-agent", "codex", "exec", "--json", "-"]);
    assert.match(sandbox.agentCommand?.[2] ?? "", /runuser -u node/);
    assert.equal(sandbox.agentStdin, "prompt");
    assert.deepEqual(stderr, []);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

class FakeModalClient implements ModalClientLike {
  appName = "";
  closed = false;
  image = "";
  imageSecretName = "";
  secretNames: string[] = [];

  constructor(private sandbox: FakeSandbox) {}

  apps = {
    fromName: async (name: string, params?: { createIfMissing?: boolean }) => {
      this.appName = name;
      assert.equal(params?.createIfMissing, true);
      return { name };
    },
  };

  images = {
    fromRegistry: (image: string, secret?: unknown) => {
      this.image = image;
      this.imageSecretName = (secret as { name?: string } | undefined)?.name ?? "";
      return { image };
    },
  };

  secrets = {
    fromName: async (name: string) => {
      this.secretNames.push(name);
      return { name };
    },
  };

  sandboxes = {
    create: async (_app: unknown, _image: unknown, params?: ModalSandboxCreateParams) => {
      this.sandbox.createParams = params;
      return this.sandbox;
    },
  };

  close(): void {
    this.closed = true;
  }
}

class FakeSandbox implements ModalSandboxLike {
  agentCommand?: string[];
  agentStdin = "";
  createParams?: ModalSandboxCreateParams;
  terminated = false;

  constructor(private root: string) {}

  async exec(command: string[], params?: ModalExecParams): Promise<ModalProcessLike<string | Uint8Array>> {
    const process = new FakeProcess(command, params, this.root, this);
    return process;
  }

  async terminate(): Promise<void> {
    this.terminated = true;
  }
}

class FakeProcess implements ModalProcessLike<string | Uint8Array> {
  stdin = new FakeWriteStream();
  stdout = new FakeReadStream<string | Uint8Array>(() => this.done.then(() => this.stdoutValue));
  stderr = new FakeReadStream<string | Uint8Array>(() => this.done.then(() => this.stderrValue));
  private resolveDone!: () => void;
  private stdoutValue: string | Uint8Array = "";
  private stderrValue: string | Uint8Array = "";
  private done = new Promise<void>((resolve) => {
    this.resolveDone = resolve;
  });

  constructor(
    private command: string[],
    private params: ModalExecParams | undefined,
    private root: string,
    private sandbox: FakeSandbox,
  ) {}

  async wait(): Promise<number> {
    try {
      this.run();
      this.resolveDone();
      return 0;
    } catch (error) {
      this.stderrValue = `${(error as Error).message}\n`;
      this.resolveDone();
      return 1;
    }
  }

  private run(): void {
    if (this.command[0] === "mkdir") {
      mkdirSync(this.mapPath(this.command[2]), { recursive: true });
      return;
    }
    if (this.command[0] === "tar" && this.command[1] === "-xzf") {
      const target = this.mapPath(this.command[4]);
      mkdirSync(target, { recursive: true });
      const result = spawnSync("tar", ["-xzf", "-", "-C", target], { input: this.stdin.bytes });
      if (result.status !== 0) throw new Error(result.stderr.toString());
      return;
    }
    if (this.command[0] === "tar" && this.command[1] === "-czf") {
      const source = this.mapPath(this.command[4]);
      const result = spawnSync("tar", ["-czf", "-", "-C", source, "."], { encoding: "buffer" });
      if (result.status !== 0) throw new Error(result.stderr.toString());
      this.stdoutValue = result.stdout;
      return;
    }
    if (this.command[0] === "sh") {
      this.sandbox.agentCommand = this.command;
      this.sandbox.agentStdin = this.stdin.text;
      const workspace = this.mapPath("/workspace");
      writeFileSync(join(workspace, "input.txt"), "remote");
      writeFileSync(join(workspace, "created.txt"), "created");
      this.stdoutValue = JSON.stringify({ type: "agent_message", text: "modal final" });
      assert.equal(this.params?.env?.HOME, "/home/node");
      return;
    }
    throw new Error(`unexpected fake command: ${this.command.join(" ")}`);
  }

  private mapPath(path: string | undefined): string {
    if (path === "/workspace") return join(this.root, "workspace");
    if (path === "/tmp/headless-host-home") return join(this.root, "host-home");
    throw new Error(`unexpected path: ${path}`);
  }
}

class FakeWriteStream implements ModalWriteStreamLike<string | Uint8Array> {
  bytes = new Uint8Array();
  text = "";

  async writeBytes(bytes: Uint8Array): Promise<void> {
    this.bytes = bytes;
  }

  async writeText(text: string): Promise<void> {
    this.text = text;
  }

  async close(): Promise<void> {}
}

class FakeReadStream<R extends string | Uint8Array> implements ModalReadStreamLike<R> {
  constructor(private read: () => Promise<R>) {}

  async readText(): Promise<string> {
    const value = await this.read();
    return typeof value === "string" ? value : new TextDecoder().decode(value);
  }

  async readBytes(): Promise<Uint8Array> {
    const value = await this.read();
    return typeof value === "string" ? new TextEncoder().encode(value) : value;
  }
}
