import type { Env } from "./types.js";

export const defaultForwardedEnvNames = [
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_DEFAULT_REGION",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CODEX_API_KEY",
  "CURSOR_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENROUTER_API_KEY",
  "PI_CODING_AGENT_API_KEY",
  "PI_CODING_AGENT_MODEL",
  "PI_CODING_AGENT_MODELS",
  "PI_CODING_AGENT_PROVIDER",
];

export interface ForwardedEnvEntry {
  name: string;
  value?: string;
  actualValue?: string;
}

export function collectForwardedEnvEntries(env: Env, commandEnv: Env | undefined, explicitEnv: string[]): ForwardedEnvEntry[] {
  const entries = new Map<string, ForwardedEnvEntry>();
  for (const name of defaultForwardedEnvNames) {
    if (env[name] !== undefined) {
      entries.set(name, { name, actualValue: env[name] });
    }
  }
  for (const [name, value] of Object.entries(commandEnv ?? {})) {
    if (value !== undefined) {
      entries.set(name, { name, value: `${name}=${value}`, actualValue: value });
    }
  }
  for (const item of explicitEnv) {
    const equals = item.indexOf("=");
    if (equals === -1) {
      entries.set(item, { name: item, actualValue: env[item] });
    } else {
      entries.set(item.slice(0, equals), {
        name: item.slice(0, equals),
        value: item,
        actualValue: item.slice(equals + 1),
      });
    }
  }
  return [...entries.values()];
}
