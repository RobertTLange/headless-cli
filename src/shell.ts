import type { BuiltCommand } from "./types.js";

const safeShellToken = /^[A-Za-z0-9_./:=@%+-]+$/;

export function quoteArg(value: string): string {
  if (value === "") {
    return "''";
  }
  if (safeShellToken.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function quoteCommand(command: BuiltCommand): string {
  const parts = [command.command, ...command.args].map(quoteArg);
  if (command.stdinText !== undefined) {
    return ["printf", "%s", quoteArg(command.stdinText), "|", ...parts].join(" ");
  }
  if (command.stdinFile) {
    parts.push("<", quoteArg(command.stdinFile));
  }
  return parts.join(" ");
}
