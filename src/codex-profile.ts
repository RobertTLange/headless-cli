import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";

import type { Env } from "./types.js";

const maxProfileBytes = 1024 * 1024;
const maxCatalogBytes = 16 * 1024 * 1024;
const catalogAssignment = /^(\s*model_catalog_json\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')(\s*(?:#.*)?)$/m;

export interface CodexProfileFiles {
  catalog?: { content: string; path: string };
  content: string;
  path: string;
}

export interface CodexProfileSeedFile {
  content: string;
  relPath: string;
}

export function validateCodexProfileName(profile: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]{0,255}$/.test(profile)) {
    throw new Error(
      "invalid Codex profile; use 1-256 ASCII letters, numbers, dashes, or underscores, without a leading dash",
    );
  }
  return profile;
}

export interface CodexBaseFile extends CodexProfileSeedFile {
  path: string;
}

export function codexHomePath(env: Env): string {
  return resolve(env.CODEX_HOME || join(requiredHome(env), ".codex"));
}

export function readCodexBaseFiles(env: Env): CodexBaseFile[] {
  const codexHome = codexHomePath(env);
  return [
    readOptionalCodexFile(join(codexHome, "auth.json"), ".codex/auth.json", maxCatalogBytes),
    readOptionalCodexFile(join(codexHome, "config.toml"), ".codex/config.toml", maxProfileBytes),
  ].filter((file): file is CodexBaseFile => file !== undefined);
}

export function readCodexProfileFiles(env: Env, profile: string): CodexProfileFiles {
  validateCodexProfileName(profile);
  const codexHome = codexHomePath(env);
  const profilePath = resolve(codexHome, `${profile}.config.toml`);
  const content = readBoundedRegularFile(profilePath, maxProfileBytes, "Codex profile");
  const assignment = catalogAssignment.exec(content);
  if (!assignment) {
    return { content, path: profilePath };
  }

  const configuredPath = parseTomlString(assignment[2] as string);
  const catalogPath = isAbsolute(configuredPath)
    ? resolve(configuredPath)
    : resolve(codexHome, configuredPath);
  return {
    catalog: {
      content: readBoundedRegularFile(catalogPath, maxCatalogBytes, "Codex model catalog"),
      path: catalogPath,
    },
    content,
    path: profilePath,
  };
}

export function codexProfileSeedFiles(
  env: Env,
  profile: string,
  remoteCodexHome: string,
): CodexProfileSeedFile[] {
  const files = readCodexProfileFiles(env, profile);
  const profileRelPath = `.codex/${profile}.config.toml`;
  if (!files.catalog) {
    return [{ content: files.content, relPath: profileRelPath }];
  }

  const catalogName = basename(files.catalog.path);
  const assignment = catalogAssignment.exec(files.content);
  if (!assignment || assignment.index === undefined) {
    throw new Error("Codex profile catalog assignment could not be rewritten");
  }
  const replacement = `${assignment[1]}${JSON.stringify(join(remoteCodexHome, catalogName))}${assignment[3]}`;
  const profileContent =
    files.content.slice(0, assignment.index) + replacement + files.content.slice(assignment.index + assignment[0].length);
  return [
    { content: profileContent, relPath: profileRelPath },
    { content: files.catalog.content, relPath: `.codex/${catalogName}` },
  ];
}

function requiredHome(env: Env): string {
  if (!env.HOME) {
    throw new Error("HOME or CODEX_HOME is required to load a Codex profile");
  }
  return env.HOME;
}

function parseTomlString(value: string): string {
  if (value.startsWith("'")) {
    return value.slice(1, -1);
  }
  try {
    return JSON.parse(value) as string;
  } catch {
    throw new Error("Codex profile model_catalog_json must be a quoted path");
  }
}

function readBoundedRegularFile(path: string, maxBytes: number, label: string): string {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile() || stats.size > maxBytes) {
      throw new Error(`${label} must be a bounded regular file: ${path}`);
    }
    return readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function readOptionalCodexFile(path: string, relPath: string, maxBytes: number): CodexBaseFile | undefined {
  try {
    return {
      content: readBoundedRegularFile(path, maxBytes, "Codex configuration"),
      path,
      relPath,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
