import { spawn } from "node:child_process";
import { win32 } from "node:path";

interface KillableProcess {
  pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
}

interface TaskkillProcess extends KillableProcess {
  once(event: "error", listener: (error: Error) => void): this;
  once(event: "close", listener: (code: number | null) => void): this;
  unref(): void;
}

export type TaskkillLauncher = (
  command: string,
  args: string[],
  options: { stdio: "ignore"; windowsHide: true },
) => TaskkillProcess;

const launchTaskkill: TaskkillLauncher = (command, args, options) => spawn(command, args, options);

export function windowsTaskkillPath(systemRoot = process.env.SystemRoot): string {
  const root = systemRoot && win32.isAbsolute(systemRoot) ? systemRoot : "C:\\Windows";
  return win32.join(root, "System32", "taskkill.exe");
}

export function forceKillWindowsProcessTree(
  child: KillableProcess,
  timeoutMs: number,
  launch: TaskkillLauncher = launchTaskkill,
  systemRoot = process.env.SystemRoot,
): void {
  if (!child.pid) {
    child.kill("SIGKILL");
    return;
  }

  const taskkill = launch(windowsTaskkillPath(systemRoot), ["/pid", String(child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  let finished = false;
  const finish = (fallback: boolean) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    if (fallback) child.kill("SIGKILL");
  };
  const timeout = setTimeout(() => {
    taskkill.kill("SIGKILL");
    finish(true);
  }, timeoutMs);
  timeout.unref();
  taskkill.once("error", () => finish(true));
  taskkill.once("close", (code) => finish(code !== 0));
  taskkill.unref();
}
