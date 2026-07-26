import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { forceKillWindowsProcessTree, windowsTaskkillPath, type TaskkillLauncher } from "../src/process-tree.ts";

class FakeTaskkill extends EventEmitter {
  readonly signals: Array<NodeJS.Signals | number | undefined> = [];
  unrefCalled = false;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(signal);
    return true;
  }

  unref(): void {
    this.unrefCalled = true;
  }
}

test("Windows tree cleanup launches trusted taskkill with numeric arguments", () => {
  const taskkill = new FakeTaskkill();
  let invocation: { command: string; args: string[] } | undefined;
  const launch: TaskkillLauncher = (command, args) => {
    invocation = { command, args };
    return taskkill;
  };
  const childSignals: Array<NodeJS.Signals | number | undefined> = [];

  forceKillWindowsProcessTree(
    {
      pid: 1234,
      kill: (signal) => {
        childSignals.push(signal);
        return true;
      },
    },
    100,
    launch,
  );
  taskkill.emit("close", 0);

  assert.deepEqual(invocation, {
    command: "C:\\Windows\\System32\\taskkill.exe",
    args: ["/pid", "1234", "/T", "/F"],
  });
  assert.equal(taskkill.unrefCalled, true);
  assert.deepEqual(childSignals, []);
});

test("Windows tree cleanup resolves taskkill from a non-default system root", () => {
  assert.equal(windowsTaskkillPath("D:\\WinNT"), "D:\\WinNT\\System32\\taskkill.exe");
});

test("Windows tree cleanup bounds a hung taskkill and falls back to the direct child", async () => {
  const taskkill = new FakeTaskkill();
  const childSignals: Array<NodeJS.Signals | number | undefined> = [];

  forceKillWindowsProcessTree(
    {
      pid: 1234,
      kill: (signal) => {
        childSignals.push(signal);
        return true;
      },
    },
    1,
    () => taskkill,
  );
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(taskkill.signals, ["SIGKILL"]);
  assert.deepEqual(childSignals, ["SIGKILL"]);
});
