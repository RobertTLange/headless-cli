import type { RunEvent, RunNode, RunRecord } from "./runs.js";
import type { RunStatus } from "./roles.js";
import { cell, renderTable, type TableCell, type TableColor } from "./table.js";

export function renderRunList(runs: RunRecord[]): string {
  if (runs.length === 0) {
    return "No headless runs\n";
  }
  const now = Date.now();
  return renderTable({
    columns: ["RUN", "MODE", "NODES", "ACTIVE", "STATUS", "UPDATED", "AGE"],
    rows: runs.map((run) => {
      const nodes = Object.values(run.nodes);
      const active = nodes.filter((node) => node.status === "busy" || node.status === "starting").length;
      const mode = nodes[0]?.coordination ?? "unknown";
      const summary = statusSummary(nodes);
      return [
        run.runId,
        mode,
        `${nodes.length} nodes`,
        cell(`${active} active`, active > 0 ? "yellow" : "dim"),
        cell(summary, statusSummaryColor(summary)),
        run.updatedAt,
        formatAge(run.updatedAt, now),
      ];
    }),
  });
}

export function renderRunView(run: RunRecord): string {
  const nodes = Object.values(run.nodes).sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const mode = nodes.find((node) => node.nodeId === "orchestrator")?.coordination ?? nodes[0]?.coordination ?? "unknown";
  const now = Date.now();
  const summary = statusSummary(nodes);
  const lines = [
    "Summary",
    renderTable({
      columns: ["Field", "Value"],
      rows: [
        ["Run", run.runId],
        ["Mode", mode],
        ["Nodes", `${nodes.length} nodes`],
        ["Status", cell(summary, statusSummaryColor(summary))],
        ["Created", run.createdAt],
        ["Updated", run.updatedAt],
        ["Age", formatAge(run.createdAt, now)],
        ["Updated age", `${formatAge(run.updatedAt, now)} ago`],
      ],
    }).trimEnd(),
    "",
    "Graph",
    renderTable({
      columns: ["Node"],
      rows: renderGraph(nodes, now).map((line) => [cell(line, graphLineColor(line))]),
    }).trimEnd(),
  ];
  const extraEdges = dependencyEdges(nodes).filter(([from, to]) => from !== "orchestrator" && to !== "orchestrator");
  if (extraEdges.length > 0) {
    lines.push("", "Extra edges");
    lines.push(
      renderTable({
        columns: ["From", "To"],
        rows: extraEdges,
      }).trimEnd(),
    );
  }
  if (nodes.length > 0) {
    lines.push("", "Node details");
    lines.push(
      renderTable({
        columns: ["NODE", "ROLE", "AGENT", "STATUS", "UPDATED", "AGE", "LAST"],
        rows: renderNodeRows(nodes, now),
      }).trimEnd(),
    );
  }
  const messages = run.events.filter((event) => event.type === "message_sent").slice(-8);
  if (messages.length > 0) {
    lines.push("", "Recent messages");
    lines.push(
      renderTable({
        columns: ["TIME", "FROM", "TO", "MESSAGE"],
        rows: messages.map(renderMessageRow),
      }).trimEnd(),
    );
  }
  lines.push("", "Commands");
  lines.push(
    renderTable({
      columns: ["NODE", "COMMAND"],
      rows: commandRows(run.runId, nodes),
    }).trimEnd(),
  );
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

function renderNodeRows(nodes: RunNode[], now: number): Array<Array<string | TableCell>> {
  return nodes.map((node) => [
    node.nodeId,
    node.role,
    node.agent,
    cell(node.status, statusColor(node.status)),
    node.updatedAt,
    formatAge(node.updatedAt, now),
    truncate(oneLine(node.lastMessage ?? ""), 60) || "-",
  ]);
}

function renderMessageRow(event: RunEvent): string[] {
  return [
    event.createdAt,
    event.nodeId ?? "cli",
    event.targetNodeId ?? "unknown",
    truncate(event.message ?? "", 100),
  ];
}

function commandRows(runId: string, nodes: RunNode[]): string[][] {
  const rows: string[][] = [];
  for (const node of nodes) {
    rows.push([node.nodeId, `headless run message ${runId} ${node.nodeId} --prompt "..."`]);
    if (node.tmuxSessionName) {
      rows.push([node.nodeId, `tmux attach-session -t ${node.tmuxSessionName}`]);
    }
    if (node.logs) {
      rows.push([node.nodeId, `tail -f ${node.logs.stdout}`]);
    }
  }
  return rows;
}

function graphLineColor(line: string): TableColor | undefined {
  for (const status of ["failed", "busy", "starting", "done", "idle", "planned", "unknown"] as const) {
    if (line.includes(`[${status} `)) {
      return statusColor(status);
    }
  }
  return undefined;
}

function statusColor(status: RunStatus): TableColor | undefined {
  switch (status) {
    case "done":
      return "green";
    case "busy":
    case "starting":
      return "yellow";
    case "failed":
    case "unknown":
      return "red";
    case "idle":
      return "cyan";
    case "planned":
      return "dim";
  }
}

function statusSummaryColor(summary: string): TableColor | undefined {
  if (summary.includes("failed") || summary.includes("unknown")) return "red";
  if (summary.includes("busy") || summary.includes("starting")) return "yellow";
  if (summary.includes("done")) return "green";
  if (summary.includes("idle")) return "cyan";
  if (summary.includes("planned")) return "dim";
  return undefined;
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
