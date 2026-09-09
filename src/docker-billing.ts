import { spawnSync } from "node:child_process";
import type { BuiltCommand, Env } from "./types.js";

export function buildDockerBillingVolumeInitCommand(volume: string, image: string): BuiltCommand {
  return {
    command: "docker",
    args: ["run", "--rm", "--user", "0", "--entrypoint", "sh",
      "--volume", `${volume}:/headless-home:rw`, image,
      "-c", "chmod 1777 /headless-home"],
  };
}

export function removeDockerBillingVolume(volume: string, env: Env): boolean {
  const result = spawnSync("docker", ["volume", "rm", volume], {
    env, stdio: "ignore", timeout: 10_000, windowsHide: true,
  });
  return !result.error && result.status === 0;
}
