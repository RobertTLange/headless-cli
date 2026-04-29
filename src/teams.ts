import { isAgentName } from "./agents.js";
import { isRole, type Role } from "./roles.js";
import type { AgentName } from "./types.js";

export interface ParsedTeamSpec {
  agent?: AgentName;
  role: Role;
  count: number;
}

export interface TeamNodeSpec {
  agent: AgentName;
  role: Role;
  nodeId: string;
  planned: true;
}

export function parseTeamSpec(value: string): ParsedTeamSpec {
  const match = /^(?:(?<agent>[A-Za-z0-9_-]+)\/)?(?<role>[A-Za-z0-9_-]+)(?:=(?<count>[0-9]+))?$/.exec(value);
  if (!match?.groups) {
    throw new Error(`invalid team spec: ${value}`);
  }
  const agent = match.groups.agent;
  if (agent !== undefined && !isAgentName(agent)) {
    throw new Error(`unsupported team agent: ${agent}`);
  }
  const role = match.groups.role;
  if (!isRole(role)) {
    throw new Error(`unsupported team role: ${role}`);
  }
  const count = match.groups.count === undefined ? 1 : Number.parseInt(match.groups.count, 10);
  if (!Number.isFinite(count) || count <= 0) {
    throw new Error(`team count must be positive: ${value}`);
  }
  return { agent, role, count };
}

export function expandTeamSpecs(orchestratorAgent: AgentName, values: string[]): TeamNodeSpec[] {
  const parsed = values.map(parseTeamSpec);
  const roleAgents = new Map<Role, Set<AgentName>>();
  for (const spec of parsed) {
    const agent = spec.agent ?? orchestratorAgent;
    const agents = roleAgents.get(spec.role) ?? new Set<AgentName>();
    agents.add(agent);
    roleAgents.set(spec.role, agents);
  }

  const seenByRoleAgent = new Map<string, number>();
  const result: TeamNodeSpec[] = [];
  for (const spec of parsed) {
    const agent = spec.agent ?? orchestratorAgent;
    const mixedAgentRole = (roleAgents.get(spec.role)?.size ?? 0) > 1;
    const key = `${spec.role}/${agent}`;
    const start = seenByRoleAgent.get(key) ?? 0;
    for (let index = 1; index <= spec.count; index += 1) {
      const ordinal = start + index;
      result.push({
        agent,
        role: spec.role,
        nodeId: generatedNodeName(spec.role, agent, spec.count, ordinal, mixedAgentRole),
        planned: true,
      });
    }
    seenByRoleAgent.set(key, start + spec.count);
  }
  return result;
}

function generatedNodeName(
  role: Role,
  agent: AgentName,
  countInSpec: number,
  ordinal: number,
  mixedAgentRole: boolean,
): string {
  const agentPart = mixedAgentRole ? `-${agent}` : "";
  const needsOrdinal = countInSpec > 1 || ordinal > 1;
  return needsOrdinal ? `${role}${agentPart}-${ordinal}` : `${role}${agentPart}`;
}
