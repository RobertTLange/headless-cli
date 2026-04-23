import type { BuiltCommand } from "./types.js";

const safeShellToken = /^[A-Za-z0-9_./:=@%+-]+$/;
const shellSpecialChars = /([\\\s"'`$!&|;<>()[\]{}*?])/g;

export function quoteArg(value: string): string {
  if (value === "") {
    return "''";
  }
  if (safeShellToken.test(value)) {
    return value;
  }
  return value.replace(shellSpecialChars, "\\$1");
}

export function quoteCommand(command: BuiltCommand): string {
  const parts = [command.command, ...command.args].map(quoteArg);
  if (command.stdinFile) {
    parts.push("<", quoteArg(command.stdinFile));
  }
  return parts.join(" ");
}
