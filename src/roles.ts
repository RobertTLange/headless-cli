import type { AllowMode, AgentName, ReasoningEffort } from "./types.js";
import type { RunNode, RunRecord } from "./runs.js";
import type { TeamNodeSpec } from "./teams.js";

export const roles = ["orchestrator", "explorer", "worker", "reviewer"] as const;
export const coordinationModes = ["session", "tmux", "oneshot"] as const;
export const runStatuses = ["planned", "starting", "busy", "idle", "done", "failed", "unknown"] as const;

export type Role = (typeof roles)[number];
export type CoordinationMode = (typeof coordinationModes)[number];
export type RunStatus = (typeof runStatuses)[number];

export interface RoleInvocation {
  agent: AgentName;
  role?: Role;
  coordination: CoordinationMode;
  runId?: string;
  nodeId?: string;
  dependsOn: string[];
  team: TeamNodeSpec[];
  allow?: AllowMode;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  workDir?: string;
  sessionAlias?: string;
  tmuxSessionName?: string;
}

export function isRole(value: string): value is Role {
  return roles.includes(value as Role);
}

export function isCoordinationMode(value: string): value is CoordinationMode {
  return coordinationModes.includes(value as CoordinationMode);
}

export function isRunStatus(value: string): value is RunStatus {
  return runStatuses.includes(value as RunStatus);
}

export function roleDefaultAllow(role: Role | undefined): AllowMode | undefined {
  if (role === "explorer" || role === "reviewer") {
    return "read-only";
  }
  return undefined;
}

export function nodeIdForRole(role: Role | undefined, explicitNode: string | undefined): string | undefined {
  return explicitNode ?? role;
}

export function composeRolePrompt(
  prompt: string,
  invocation: RoleInvocation,
  run: RunRecord | undefined,
): string {
  if (!invocation.role && !invocation.runId) {
    return prompt;
  }

  const parts = [
    roleInstructions(invocation.role, invocation.runId),
    invocation.runId ? runContext(invocation, run) : "",
    "User prompt:",
    prompt,
  ].filter(Boolean);
  return parts.join("\n\n");
}

function roleInstructions(role: Role | undefined, runId: string | undefined): string {
  if (!role) {
    return "";
  }
  const commandHelp = runId
    ? [
        "Coordination commands:",
        `- headless run message ${runId} <node> --prompt "..." sends a turn to that node using stored run metadata.`,
        "- Add --async to run session/oneshot nodes in the background; status becomes busy, logs are written, then status becomes idle or failed.",
        `- headless run view ${runId} shows roster, status, last messages, dependencies, and log/attach commands.`,
        `- headless run wait ${runId} waits until no nodes are busy or starting.`,
        "- Run headless --help for full command syntax.",
      ].join("\n")
    : "Run headless --help for full command syntax.";
  const finishCommand = runId
    ? [
        `When finished or blocked, send status with: headless run message ${runId} orchestrator --prompt "<status>"`,
        "Include findings, changed files, tests, and blockers as relevant.",
      ].join("\n")
    : "When finished or blocked, report concise status in your final response.";

  switch (role) {
    case "orchestrator":
      return [
        "Role: orchestrator.",
        "Coordinate the declared team at the beginning of the run and treat it as the coordination contract.",
        "After initial team creation, do not launch surprise agents unless the user explicitly asks.",
        "Use run message to assign work; use --async for parallel child work; ask children to report back explicitly.",
        commandHelp,
        runId
          ? `Before your final response, call headless run wait ${runId} if async children may still be running.`
          : "",
      ]
        .filter(Boolean)
        .join("\n");
    case "explorer":
      return [
        "Role: explorer.",
        "Stay read-only. Investigate and report concise findings.",
        "Treat incoming run messages as the next task turn. Keep status concise enough for run view lastMessage.",
        commandHelp,
        finishCommand,
      ].join("\n");
    case "worker":
      return [
        "Role: worker.",
        "Implement the assigned task. Keep changes scoped and run relevant verification.",
        "Treat incoming run messages as the next task turn. Keep status concise enough for run view lastMessage.",
        commandHelp,
        finishCommand,
      ].join("\n");
    case "reviewer":
      return [
        "Role: reviewer.",
        "Stay read-only. Review for bugs, regressions, security risks, and missing tests.",
        "Lead with findings and file references. Treat incoming run messages as the next review turn.",
        "Keep status concise enough for run view lastMessage.",
        commandHelp,
        finishCommand,
      ].join("\n");
  }
}

function runContext(invocation: RoleInvocation, run: RunRecord | undefined): string {
  const nodes = run ? Object.values(run.nodes).sort((left, right) => left.nodeId.localeCompare(right.nodeId)) : [];
  const currentNode = invocation.nodeId ?? nodeIdForRole(invocation.role, undefined) ?? "unknown";
  const lines = [
    "Headless run context:",
    `run: ${invocation.runId}`,
    `current node: ${currentNode}`,
    `current role: ${invocation.role ?? "unknown"}`,
    `coordination: ${invocation.coordination}`,
    "roster:",
    ...(nodes.length > 0 ? nodes.map(renderNodeContext) : ["- none registered yet"]),
  ];
  if (invocation.team.length > 0) {
    lines.push("declared team:");
    lines.push(...invocation.team.map((node) => `- ${node.nodeId}: ${node.agent}/${node.role}`));
  }
  lines.push("commands:");
  lines.push(`- view: headless run view ${invocation.runId}`);
  lines.push(`- wait: headless run wait ${invocation.runId}`);
  for (const node of nodes) {
    lines.push(`- message ${node.nodeId}: headless run message ${invocation.runId} ${node.nodeId} --prompt "..."`);
  }
  return lines.join("\n");
}

function renderNodeContext(node: RunNode): string {
  const depends = node.dependsOn.length > 0 ? ` depends=${node.dependsOn.join(",")}` : "";
  const last = node.lastMessage ? ` last=${JSON.stringify(truncate(node.lastMessage, 120))}` : "";
  const planned = node.unplanned ? " unplanned" : " planned";
  return `- ${node.nodeId}: ${node.agent}/${node.role} ${node.coordination} ${node.status}${depends}${planned}${last}`;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
