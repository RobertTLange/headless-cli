import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
    assert.match(output, /^Agent\s+Status\s+Version\s+Binary/m);
    assert.match(output, /^codex\s+✓\s+1\.2\.3\s+codex$/m);
    assert.match(output, /^gemini\s+✓\s+0\.39\.1\s+gemini$/m);
    assert.match(output, /^opencode\s+✓\s+1\.4\.10\s+opencode$/m);
    assert.match(output, /^pi\s+✓\s+4\.5\.6\s+pi-agent$/m);
    assert.match(output, /^claude\s+✗\s+-\s+claude$/m);
    assert.match(output, /^cursor\s+✗\s+-\s+agent$/m);
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
    assert.match(stdout.join(""), /^cursor\s+✓\s+2026\.04\.17\s+cursor-agent$/m);
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
    assert.match(stdout.join(""), /^cursor\s+✓\s+unknown\s+cursor-agent$/m);
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
    assert.match(stdout.join(""), /^cursor\s+✓\s+9\.8\.7\s+cursor-agent$/m);
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
    assert.match(stdout.join(""), /^Docker\s+Status\s+Version\s+Default image$/m);
    assert.match(stdout.join(""), /^docker\s+✓\s+27\.1\.2\s+ghcr\.io\/RobertTLange\/headless:latest \(present\)$/m);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
