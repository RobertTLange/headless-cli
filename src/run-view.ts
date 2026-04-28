import type { RunEvent, RunNode, RunRecord } from "./runs.js";

export function renderRunList(runs: RunRecord[]): string {
  if (runs.length === 0) {
    return "No headless runs\n";
  }
  const rows = runs.map((run) => {
    const nodes = Object.values(run.nodes);
    const busy = nodes.filter((node) => node.status === "busy").length;
    const mode = nodes[0]?.coordination ?? "unknown";
    return `${run.runId}\t${mode}\t${nodes.length} nodes\t${busy} busy\t${run.updatedAt}`;
  });
  return `${["RUN\tMODE\tNODES\tBUSY\tUPDATED", ...rows].join("\n")}\n`;
}

export function renderRunView(run: RunRecord): string {
  const nodes = Object.values(run.nodes).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const mode = nodes.find((node) => node.nodeId === "orchestrator")?.coordination ?? nodes[0]?.coordination ?? "unknown";
  const lines = [`${run.runId}  ${mode}  ${nodes.length} nodes`, "", "Graph"];
  lines.push(...renderGraph(nodes));
  const extraEdges = dependencyEdges(nodes).filter(([from, to]) => from !== "orchestrator" && to !== "orchestrator");
  if (extraEdges.length > 0) {
    lines.push("", "Extra edges");
    lines.push(...extraEdges.map(([from, to]) => `${from} -> ${to}`));
  }
  const messages = run.events.filter((event) => event.type === "message_sent").slice(-8);
  if (messages.length > 0) {
    lines.push("", "Recent messages");
    lines.push(...messages.map(renderMessage));
  }
  lines.push("", "Commands");
  for (const node of nodes) {
    lines.push(`message ${node.nodeId}: headless run message ${run.runId} ${node.nodeId} --prompt "..."`);
    if (node.tmuxSessionName) {
      lines.push(`attach ${node.nodeId}:  tmux attach-session -t ${node.tmuxSessionName}`);
    }
    if (node.logs) {
      lines.push(`logs ${node.nodeId}:    tail -f ${node.logs.stdout}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderGraph(nodes: RunNode[]): string[] {
  if (nodes.length === 0) {
    return ["(empty)"];
  }
  const root = nodes.find((node) => node.nodeId === "orchestrator") ?? nodes[0];
  const children = nodes.filter((node) => node.nodeId !== root.nodeId);
  return [renderNode(root), ...children.map((node, index) => `${index === children.length - 1 ? "`-" : "|-"} ${renderNode(node)}`)];
}

function renderNode(node: RunNode): string {
  const depends = node.dependsOn.length > 0 ? ` depends: ${node.dependsOn.join(",")}` : "";
  const last = node.lastMessage ? ` last: ${truncate(node.lastMessage, 80)}` : "";
  const planned = node.unplanned ? " unplanned" : "";
  return `${node.nodeId} [${node.status}]${depends}${planned}${last}`;
}

function renderMessage(event: RunEvent): string {
  return `${event.nodeId ?? "cli"} -> ${event.targetNodeId ?? "unknown"}  ${truncate(event.message ?? "", 100)}`;
}

function dependencyEdges(nodes: RunNode[]): Array<[string, string]> {
  const edges: Array<[string, string]> = [];
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      edges.push([dependency, node.nodeId]);
    }
  }
  return edges;
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}
