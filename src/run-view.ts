import type { RunEvent, RunNode, RunRecord } from "./runs.js";

export function renderRunList(runs: RunRecord[]): string {
  if (runs.length === 0) {
    return "No headless runs\n";
  }
  const now = Date.now();
  const rows = runs.map((run) => {
    const nodes = Object.values(run.nodes);
    const active = nodes.filter((node) => node.status === "busy" || node.status === "starting").length;
    const mode = nodes[0]?.coordination ?? "unknown";
    return `${run.runId}\t${mode}\t${nodes.length} nodes\t${active} active\t${run.updatedAt}\t${formatAge(run.updatedAt, now)}`;
  });
  return `${["RUN\tMODE\tNODES\tACTIVE\tUPDATED\tAGE", ...rows].join("\n")}\n`;
}

export function renderRunView(run: RunRecord): string {
  const nodes = Object.values(run.nodes).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const mode = nodes.find((node) => node.nodeId === "orchestrator")?.coordination ?? nodes[0]?.coordination ?? "unknown";
  const now = Date.now();
  const lines = [
    `${run.runId}  ${mode}  ${nodes.length} nodes  status: ${statusSummary(nodes)}`,
    `created: ${run.createdAt}  updated: ${run.updatedAt}  age: ${formatAge(run.createdAt, now)}  updated: ${formatAge(run.updatedAt, now)} ago`,
    "",
    "Graph",
  ];
  lines.push(...renderGraph(nodes, now));
  const extraEdges = dependencyEdges(nodes).filter(([from, to]) => from !== "orchestrator" && to !== "orchestrator");
  if (extraEdges.length > 0) {
    lines.push("", "Extra edges");
    lines.push(...extraEdges.map(([from, to]) => `${from} -> ${to}`));
  }
  if (nodes.length > 0) {
    lines.push("", "Node details");
    lines.push(...renderNodeTable(nodes, now));
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

function renderGraph(nodes: RunNode[], now: number): string[] {
  if (nodes.length === 0) {
    return ["(empty)"];
  }
  const root = nodes.find((node) => node.nodeId === "orchestrator") ?? nodes[0];
  const children = nodes.filter((node) => node.nodeId !== root.nodeId);
  return [
    renderNode(root, now),
    ...children.map((node, index) => `${index === children.length - 1 ? "`-" : "|-"} ${renderNode(node, now)}`),
  ];
}

function renderNode(node: RunNode, now: number): string {
  const depends = node.dependsOn.length > 0 ? ` depends: ${node.dependsOn.join(",")}` : "";
  const last = node.lastMessage ? ` last: ${truncate(node.lastMessage, 80)}` : "";
  const planned = node.unplanned ? " unplanned" : "";
  return `${node.nodeId} [${node.status} ${formatAge(node.updatedAt, now)} ago]${depends}${planned}${last}`;
}

function renderNodeTable(nodes: RunNode[], now: number): string[] {
  const rows = [
    ["NODE", "ROLE", "AGENT", "STATUS", "UPDATED", "AGE", "TURNS", "DURATION", "COST", "TOKENS", "LAST"],
    ...nodes.map((node) => [
      node.nodeId,
      node.role,
      node.agent,
      node.status,
      node.updatedAt,
      formatAge(node.updatedAt, now),
      formatNumber(node.metrics?.turns),
      formatDuration(node.metrics?.durationMs),
      formatCost(node.metrics?.totalCostUsd),
      formatCompactNumber(node.metrics?.totalTokens),
      truncate(oneLine(node.lastMessage ?? ""), 60) || "-",
    ]),
  ];
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => row[index]?.length ?? 0)));
  return rows.map((row) => row.map((value, index) => value.padEnd(widths[index] ?? 0)).join("  ").trimEnd());
}

function renderMessage(event: RunEvent): string {
  return `${event.createdAt}  ${event.nodeId ?? "cli"} -> ${event.targetNodeId ?? "unknown"}  ${truncate(event.message ?? "", 100)}`;
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
  const normalized = oneLine(value);
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function statusSummary(nodes: RunNode[]): string {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    counts.set(node.status, (counts.get(node.status) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
}

function formatAge(value: string, now: number): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "-";
  return formatDuration(Math.max(0, now - time));
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) return "-";
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${String(remainingSeconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${String(remainingMinutes).padStart(2, "0")}m`;
}

function formatNumber(value: number | undefined): string {
  return value === undefined ? "-" : String(value);
}

function formatCompactNumber(value: number | undefined): string {
  if (value === undefined) return "-";
  if (value >= 1_000_000) return `${trimTrailingZero(value / 1_000_000)}m`;
  if (value >= 1_000) return `${trimTrailingZero(value / 1_000)}k`;
  return String(value);
}

function formatCost(value: number | undefined): string {
  if (value === undefined) return "-";
  if (value === 0) return "$0";
  return `$${value < 0.01 ? value.toFixed(4) : value.toFixed(2)}`;
}

function trimTrailingZero(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "");
}
