import assert from "node:assert/strict";
import test from "node:test";

import { renderTable } from "../src/table.ts";

test("table renderer omits ANSI escapes when color is disabled", () => {
  const output = renderTable(
    {
      columns: ["Status"],
      rows: [[{ text: "✓", color: "green" }]],
    },
    { color: false },
  );

  assert.doesNotMatch(output, /\x1b\[/);
  assert.match(output, /^\| ✓\s+\|$/m);
});

test("table renderer emits ANSI colors when explicitly enabled", () => {
  const output = renderTable(
    {
      columns: ["Status"],
      rows: [[{ text: "✓", color: "green" }]],
    },
    { color: true, env: {} },
  );

  assert.match(output, /\x1b\[32m✓\x1b\[0m/);
});

test("NO_COLOR disables table colors", () => {
  const output = renderTable(
    {
      columns: ["Status"],
      rows: [[{ text: "✗", color: "red" }]],
    },
    { color: true, env: { NO_COLOR: "1" } },
  );

  assert.doesNotMatch(output, /\x1b\[/);
  assert.match(output, /^\| ✗\s+\|$/m);
});

test("table renderer truncates long fields within configured width", () => {
  const output = renderTable(
    {
      columns: ["Name", "Value"],
      rows: [["short", "x".repeat(80)]],
    },
    { color: false, maxWidth: 40 },
  );

  for (const line of output.trimEnd().split("\n")) {
    assert.ok(line.length <= 40, `${line.length}: ${line}`);
  }
  assert.match(output, /\.\.\./);
});
