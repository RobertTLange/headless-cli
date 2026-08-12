import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { codexProfileSeedFiles, readCodexProfileFiles } from "../src/codex-profile.ts";

test("Codex profile seeds rewrite an absolute catalog into the remote home", () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-codex-profile-"));
  try {
    const codexHome = join(dir, "codex-home");
    const catalogPath = join(codexHome, "models.json");
    mkdirSync(codexHome);
    writeFileSync(join(codexHome, "work.config.toml"), `model_catalog_json = ${JSON.stringify(catalogPath)}\n`);
    writeFileSync(catalogPath, '{"models":[]}\n');

    assert.deepEqual(codexProfileSeedFiles({ CODEX_HOME: codexHome }, "work", "/remote/.codex"), [
      {
        content: 'model_catalog_json = "/remote/.codex/models.json"\n',
        relPath: ".codex/work.config.toml",
      },
      { content: '{"models":[]}\n', relPath: ".codex/models.json" },
    ]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("Codex profile seeds reject symlinked profile files", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "headless-codex-profile-"));
  try {
    const codexHome = join(dir, "codex-home");
    const externalProfile = join(dir, "external.config.toml");
    mkdirSync(codexHome);
    writeFileSync(externalProfile, 'model = "external"\n');
    symlinkSync(externalProfile, join(codexHome, "work.config.toml"));

    assert.throws(() => readCodexProfileFiles({ CODEX_HOME: codexHome }, "work"), /ELOOP/);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
