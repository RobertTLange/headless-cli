import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import { readStoredSession } from "../src/sessions.ts";
import { readRun, registerNode, updateNodeStatus } from "../src/runs.ts";

type Json = Record<string, any>;

function assistant(stopReason: string, text: string, input: number, cached: number): Json {
  return {
    role: "assistant", provider: "openai-codex", model: "gpt-5.6-sol", stopReason,
    content: [{ type: "text", text }],
    usage: { input, output: stopReason === "toolUse" ? 2 : 0, cacheRead: cached,
      cacheWrite: 0, cost: { input: 0.04, output: 0.01, cacheRead: 0.005, cacheWrite: 0, total: 0.055 } },
  };
}

// Sanitized shape of run 79706: artifact work, empty native stop, then agent_settled.
function completedTrace(final = assistant("stop", "", 4, 6)): Json[] {
  const tool = assistant("toolUse", "", 10, 3);
  tool.content = [{ type: "toolCall", id: "write-design", name: "bash", arguments: { command: "write design" } }];
  return [
    { type: "agent_start" },
    { type: "message_end", message: tool },
    { type: "tool_execution_start", toolCallId: "write-design", toolName: "bash" },
    { type: "tool_execution_end", toolCallId: "write-design", toolName: "bash", isError: false,
      result: { content: [{ type: "text", text: "shape checks ok" }] } },
    { type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "" } },
    { type: "message_end", message: final },
    { type: "turn_end", message: final },
    { type: "agent_end", messages: [tool, final] },
    { type: "agent_settled" },
  ];
}

function fixture(records = completedTrace(), exitCode = 0, rawTail = "") {
  const home = mkdtempSync(join(tmpdir(), "pi-completion-cli-"));
  const nativeSession = join(home, "native-session.jsonl");
  const executable = `#!${process.execPath}\n` +
    `const fs = require('node:fs');\n` +
    `fs.appendFileSync(${JSON.stringify(join(home, "calls"))}, JSON.stringify(process.argv.slice(2)) + '\\n');\n` +
    `const records = [{type:'session',sessionId:${JSON.stringify(nativeSession)}}, ...${JSON.stringify(records)}];\n` +
    `fs.writeFileSync(${JSON.stringify(nativeSession)}, records.map(JSON.stringify).join('\\n')+'\\n');\n` +
    `for (const record of records) console.log(JSON.stringify(record));\n` +
    `process.stdout.write(${JSON.stringify(rawTail)});\nprocess.exitCode=${exitCode};\n`;
  for (const binary of ["pi", "docker"]) writeFileSync(join(home, binary), executable, { mode: 0o755 });
  const env = { HOME: home, PATH: `${home}:${process.env.PATH}`, HEADLESS_MODELS_DEV_CACHE: "" };
  return {
    home, nativeSession, env,
    async run(flags: string[]) {
      const output: string[] = [], errors: string[] = [];
      const code = await runCli(["pi", "--model", "openai-codex/gpt-5.6-sol", "--prompt", "write design", ...flags], {
        env, stdout: (text) => output.push(text), stderr: (text) => errors.push(text),
      });
      return { code, stdout: output.join(""), stderr: errors.join("") };
    },
    cleanup() { rmSync(home, { recursive: true, force: true }); },
  };
}

function jsonRows(output: string): Json[] {
  return output.split("\n").flatMap((line) => {
    try { return [JSON.parse(line) as Json]; } catch { return []; }
  });
}

function assertUsage(usage: Json): void {
  assert.equal(usage.inputTokens, 14);
  assert.equal(usage.cacheReadTokens, 9);
  assert.equal(usage.outputTokens, 2);
  assert.equal(usage.totalTokens, 25);
  assert.ok(Math.abs(usage.cost.total - 0.11) < 1e-12);
}

test("Pi empty successful native completion succeeds without invented plain prose", async () => {
  const f = fixture();
  try {
    const result = await f.run([]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), "");
    assert.doesNotMatch(result.stderr, /could not extract final message/);
  } finally { f.cleanup(); }
});

for (const flags of [["--usage"], ["--debug", "--usage"], ["--json", "--usage"]]) {
  test(`Pi empty success retains usage exactly once with ${flags.join(" ")}`, async () => {
    const f = fixture();
    try {
      const result = await f.run(flags);
      assert.equal(result.code, 0, result.stderr);
      const reports = jsonRows(result.stdout).filter((row) => Object.keys(row).length === 1 && row.usage);
      assert.equal(reports.length, 1);
      assertUsage(reports[0].usage);
      if (flags.includes("--json") || flags.includes("--debug")) {
        assert.ok(jsonRows(result.stdout).some((row) => row.type === "agent_settled"));
      }
    } finally { f.cleanup(); }
  });
}

for (const format of ["json", "ndjson"]) {
  test(`Pi SDK ${format} accepts empty final completion with exact usage`, async () => {
    const f = fixture();
    try {
      const result = await f.run(["--sdk-format", format, "--usage"]);
      assert.equal(result.code, 0, result.stderr);
      const rows = jsonRows(result.stdout);
      const terminal = rows.at(-1)!;
      assert.equal(terminal.type, "result");
      assert.equal(terminal.data.finalMessage, "");
      assertUsage(terminal.data.usage);
      assert.equal(rows.filter((row) => row.type === "result").length, 1);
    } finally { f.cleanup(); }
  });
}

for (const flags of [[], ["--json"], ["--sdk-format", "json"]]) {
  test(`Pi empty completion preserves native nonzero exit in ${flags.join(" ") || "plain"}`, async () => {
    const f = fixture(completedTrace(), 7);
    try { assert.equal((await f.run(flags)).code, 7); } finally { f.cleanup(); }
  });
}

for (const flags of [["--usage"], ["--json", "--usage"], ["--sdk-format", "json"]]) {
  test(`Pi native error after earlier prose cannot become success in ${flags.join(" ")}`, async () => {
    const previous = assistant("stop", "earlier progress", 10, 3);
    const failure = { ...assistant("error", "", 4, 6), errorMessage: "provider transport failed" };
    const records = [{ type: "message_end", message: previous },
      { type: "message_end", message: failure }, { type: "agent_end", messages: [previous, failure] },
      { type: "agent_settled" }];
    const f = fixture(records);
    try {
      const result = await f.run(flags);
      assert.equal(result.code, 1, result.stdout);
      if (!flags.includes("--sdk-format")) {
        const reports = jsonRows(result.stdout).filter((row) => Object.keys(row).length === 1 && row.usage);
        assert.equal(reports.length, 1);
        assert.equal(reports[0].usage.inputTokens, 14);
      }
    } finally { f.cleanup(); }
  });
}

test("Pi absent terminal empty trace still fails plain completion", async () => {
  const f = fixture([{ type: "agent_start" }]);
  try { assert.equal((await f.run([])).code, 1); } finally { f.cleanup(); }
});

function incompleteTraces(): { name: string; records: Json[]; rawTail: string }[] {
  const records = [
    { type: "message_end", message: assistant("stop", "earlier progress", 1, 0) },
    ...completedTrace(),
  ];
  return [
    { name: "new unfinished agent turn", records: [...records, { type: "agent_start" }], rawTail: "" },
    { name: "truncated native tail", records, rawTail: '{"type":"message_end","message":' },
  ];
}

for (const trace of incompleteTraces()) {
  for (const flags of [[], ["--json"], ["--sdk-format", "json"], ["--sdk-format", "ndjson"]]) {
    test(`Pi ${trace.name} cannot reuse earlier prose in ${flags.join(" ") || "plain"}`, async () => {
      const f = fixture(trace.records, 0, trace.rawTail);
      try {
        const result = await f.run(flags);
        assert.equal(result.code, 1, result.stdout);
        if (flags.includes("--sdk-format")) {
          assert.equal(jsonRows(result.stdout).filter((row) => row.type === "result").length, 0);
        }
      } finally { f.cleanup(); }
    });
  }

  test(`Pi ${trace.name} does not persist a named session`, async () => {
    const f = fixture(trace.records, 0, trace.rawTail);
    try {
      const result = await f.run(["--session", "incomplete-design"]);
      assert.equal(result.code, 1, result.stdout);
      assert.equal(readStoredSession(f.env, "pi", "incomplete-design"), undefined);
    } finally { f.cleanup(); }
  });
}

test("Pi native failure does not persist a named session", async () => {
  const failure = { ...assistant("error", "", 4, 6), errorMessage: "provider transport failed" };
  const f = fixture(completedTrace(failure));
  try {
    const result = await f.run(["--session", "failed-design"]);
    assert.equal(result.code, 1, result.stdout);
    assert.equal(readStoredSession(f.env, "pi", "failed-design"), undefined);
  } finally { f.cleanup(); }
});

for (const scenario of [
  { name: "empty success", records: completedTrace(), exitCode: 0, expectedCode: 0, rawTail: "" },
  { name: "native nonzero", records: completedTrace(), exitCode: 7, expectedCode: 7, rawTail: "" },
  { name: "native error", records: completedTrace(assistant("error", "", 4, 6)),
    exitCode: 0, expectedCode: 1, rawTail: "" },
  ...incompleteTraces().map((trace) => ({ ...trace, exitCode: 0, expectedCode: 1 })),
]) {
  test(`Pi orchestrator ${scenario.name} records the correct run completion`, async () => {
    const f = fixture(scenario.records, scenario.exitCode, scenario.rawTail);
    try {
      for (const status of ["idle", "planned"] as const) {
        registerNode(f.env, { runId: "design-run", nodeId: `${status}-worker`, role: "worker",
          agent: "pi", coordination: "oneshot", status });
      }
      const result = await f.run(["--run", "design-run", "--role", "orchestrator",
        "--coordination", "oneshot"]);
      assert.equal(result.code, scenario.expectedCode, result.stderr);
      const run = readRun(f.env, "design-run")!;
      assert.equal(run.nodes.orchestrator.status, scenario.expectedCode === 0 ? "done" : "failed");
      assert.equal(run.nodes["idle-worker"].status, scenario.expectedCode === 0 ? "done" : "idle");
      assert.equal(run.nodes["planned-worker"].status, "planned");
      if (scenario.expectedCode === 0) assert.equal(run.nodes.orchestrator.lastMessage, "");
    } finally { f.cleanup(); }
  });
}

for (const role of ["orchestrator", "worker"] as const) {
  test(`Pi reused ${role} clears prior prose after confirmed empty success`, async () => {
    const f = fixture();
    try {
      registerNode(f.env, { runId: "reused-run", nodeId: role, role, agent: "pi",
        coordination: "oneshot", status: "idle" });
      updateNodeStatus(f.env, "reused-run", role, "idle", "previous invocation answer");
      const result = await f.run(["--run", "reused-run", "--role", role, "--node", role,
        "--coordination", "oneshot"]);
      assert.equal(result.code, 0, result.stderr);
      const node = readRun(f.env, "reused-run")!.nodes[role];
      assert.equal(node.lastMessage, "");
      assert.equal(node.status, role === "orchestrator" ? "done" : "idle");
    } finally { f.cleanup(); }
  });
}

test("Pi empty completion works through Docker transport", async () => {
  const f = fixture();
  try {
    const result = await f.run(["--docker", "--usage"]);
    assert.equal(result.code, 0, result.stderr);
    const reports = jsonRows(result.stdout).filter((row) => Object.keys(row).length === 1 && row.usage);
    assert.equal(reports.length, 1);
    assertUsage(reports[0].usage);
  } finally { f.cleanup(); }
});

test("Pi empty completion persists its native session and resumes that session", async () => {
  const f = fixture();
  try {
    const first = await f.run(["--session", "design"]);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(readStoredSession(f.env, "pi", "design")?.nativeId, f.nativeSession);
    const second = await f.run(["--session", "design"]);
    assert.equal(second.code, 0, second.stderr);
    const calls = readFileSync(join(f.home, "calls"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.equal(calls[1][calls[1].indexOf("--session") + 1], f.nativeSession);
  } finally { f.cleanup(); }
});

for (const text of ["", "done"]) {
  for (const flags of [[], ["--sdk-format", "json"]]) {
    test(`Pi threshold compaction preserves ${JSON.stringify(text)} in ${flags.join(" ") || "plain"}`, async () => {
      const records = completedTrace(assistant("stop", text, 4, 6));
      records.splice(-1, 0,
        { type: "compaction_start", reason: "threshold" },
        { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false,
          result: { summary: "Compacted history", firstKeptEntryId: "entry", tokensBefore: 100000 } });
      const f = fixture(records);
      try {
        const result = await f.run([...flags, "--session", "compacted"]);
        assert.equal(result.code, 0, result.stderr || result.stdout);
        assert.equal(flags.length ? jsonRows(result.stdout).at(-1)!.data.finalMessage : result.stdout.trim(), text);
        assert.equal(readStoredSession(f.env, "pi", "compacted")?.nativeId, f.nativeSession);
      } finally { f.cleanup(); }
    });
  }
}

for (const text of ["", "done"]) {
  for (const flags of [[], ["--sdk-format", "json"]]) {
    test(`Pi cumulative terminal history preserves ${JSON.stringify(text)} in ${flags.join(" ") || "plain"}`, async () => {
      const final = assistant("stop", text, 4, 6);
      const records = completedTrace(final);
      records[records.length - 2].messages = [
        ...Array.from({ length: 5 }, () => ({ role: "toolResult",
          content: [{ type: "text", text: "x".repeat(1024 * 1024) }] })), final,
      ];
      const f = fixture(records);
      try {
        const result = await f.run([...flags, "--session", "large-history"]);
        assert.equal(result.code, 0, result.stderr || result.stdout);
        assert.equal(flags.length ? jsonRows(result.stdout).at(-1)!.data.finalMessage : result.stdout.trim(), text);
        assert.equal(readStoredSession(f.env, "pi", "large-history")?.nativeId, f.nativeSession);
      } finally { f.cleanup(); }
    });
  }
}
