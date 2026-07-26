import { existsSync, lstatSync, opendirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const maxTranscriptBytes = 64 * 1024 * 1024;

export function assertSafeDockerAntigravityState(sessionRoot: string, root: string, brainRoot: string): void {
  assertSafeDockerFile(sessionRoot, join(root, "cache", "last_conversations.json"), 1024 * 1024);
  assertSafeDockerDirectory(sessionRoot, brainRoot);
  const directory = opendirSync(brainRoot);
  let entries = 0;
  try {
    let entry;
    while ((entry = directory.readSync()) !== null) {
      if (++entries > 100) throw new Error("unsafe Docker transcript state: too many Antigravity conversations");
      const conversationRoot = join(brainRoot, entry.name);
      const stats = lstatSync(conversationRoot);
      if (stats.isFile() && !stats.isSymbolicLink() && stats.size <= 1024 * 1024) continue;
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new Error(`unsafe Docker transcript state path: ${conversationRoot}`);
      }
      assertSafeDockerFile(
        sessionRoot,
        join(conversationRoot, ".system_generated", "logs", "transcript.jsonl"),
        maxTranscriptBytes,
      );
      assertSafeDockerFile(sessionRoot, join(conversationRoot, "transcript.jsonl"), maxTranscriptBytes);
    }
  } finally {
    directory.closeSync();
  }
}

export function assertSafeDockerTree(sessionRoot: string, treeRoot: string): void {
  if (!existsSync(treeRoot)) return;
  assertSafeDockerDirectory(sessionRoot, treeRoot);
  const stack = [treeRoot];
  let entries = 0;
  while (stack.length > 0) {
    const directoryPath = stack.pop() as string;
    const directory = opendirSync(directoryPath);
    try {
      let entry;
      while ((entry = directory.readSync()) !== null) {
        if (++entries > 10_000) throw new Error("unsafe Docker transcript state: too many entries");
        const path = join(directoryPath, entry.name);
        const stats = lstatSync(path);
        if (stats.isSymbolicLink()) throw new Error(`unsafe Docker transcript state path: ${path}`);
        if (stats.isDirectory()) {
          stack.push(path);
        } else if (!stats.isFile() || stats.size > maxTranscriptBytes) {
          throw new Error(`unsafe Docker transcript state path: ${path}`);
        }
      }
    } finally {
      directory.closeSync();
    }
  }
}

export function assertSafeDockerOpenCodeDatabase(sessionRoot: string, path: string): void {
  let databaseBytes = assertSafeDockerFile(sessionRoot, path, 256 * 1024 * 1024);
  const sidecars = [
    ["-wal", 256 * 1024 * 1024],
    ["-shm", 64 * 1024 * 1024],
    ["-journal", 256 * 1024 * 1024],
  ] as const;
  for (const [suffix, maxBytes] of sidecars) {
    databaseBytes += assertSafeDockerFile(sessionRoot, `${path}${suffix}`, maxBytes);
  }
  if (databaseBytes > 384 * 1024 * 1024) {
    throw new Error("unsafe Docker transcript state: OpenCode database files are too large");
  }
}

export function assertSafeDockerFile(sessionRoot: string, path: string, maxBytes: number): number {
  if (!existsSync(path)) return 0;
  assertSafeDockerPath(sessionRoot, path);
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) {
    throw new Error(`unsafe Docker transcript state path: ${path}`);
  }
  return stats.size;
}

function assertSafeDockerDirectory(sessionRoot: string, path: string): void {
  assertSafeDockerPath(sessionRoot, path);
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`unsafe Docker transcript state path: ${path}`);
  }
}

function assertSafeDockerPath(sessionRoot: string, path: string): void {
  const root = resolve(sessionRoot);
  const target = resolve(path);
  const relativePath = relative(root, target);
  if (
    relativePath === ".." ||
    relativePath.startsWith("../") ||
    relativePath.startsWith("..\\") ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`Docker transcript state escapes the durable home: ${path}`);
  }
  let current = root;
  for (const segment of relativePath.split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment);
    if (!existsSync(current)) return;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error(`unsafe Docker transcript state path: ${current}`);
    }
  }
}
