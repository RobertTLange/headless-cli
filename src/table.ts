import type { Env } from "./types.js";

export type TableColor = "green" | "red" | "yellow" | "cyan" | "magenta" | "dim";

export interface TableCell {
  text: string;
  color?: TableColor;
}

export interface TableInput {
  columns: string[];
  rows: Array<Array<string | TableCell>>;
}

export interface TableOptions {
  color?: boolean;
  env?: Env;
  maxWidth?: number;
  terminalWidth?: number;
}

const defaultMaxWidth = 100;
const ansiCodes: Record<TableColor, string> = {
  green: "32",
  red: "31",
  yellow: "33",
  cyan: "36",
  magenta: "35",
  dim: "2",
};

export function renderTable(input: TableInput, options: TableOptions = {}): string {
  if (input.columns.length === 0) {
    return "";
  }

  const columnCount = input.columns.length;
  const rows = [input.columns.map((text) => ({ text })), ...normalizeRows(input.rows, columnCount)];
  const widths = fitWidths(naturalWidths(rows, columnCount), resolvedMaxWidth(options));
  const border = renderBorder(widths);
  const separator = renderBorder(widths);
  const color = shouldUseColor(options);
  const lines = [
    border,
    renderRow(rows[0] ?? [], widths, false),
    separator,
    ...rows.slice(1).map((row) => renderRow(row, widths, color)),
    border,
  ];
  return `${lines.join("\n")}\n`;
}

export function cell(text: string, color?: TableColor): TableCell {
  return color ? { text, color } : { text };
}

function normalizeRows(rows: Array<Array<string | TableCell>>, columnCount: number): TableCell[][] {
  return rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => {
      const value = row[index];
      if (typeof value === "string") {
        return { text: oneLine(value) };
      }
      return { text: oneLine(value?.text ?? ""), color: value?.color };
    }),
  );
}

function naturalWidths(rows: TableCell[][], columnCount: number): number[] {
  return Array.from({ length: columnCount }, (_, index) =>
    Math.max(1, ...rows.map((row) => displayLength(row[index]?.text ?? ""))),
  );
}

function fitWidths(natural: number[], maxWidth: number): number[] {
  const widths = [...natural];
  const minimums = natural.map((width) => Math.min(width, 3));
  while (totalWidth(widths) > maxWidth) {
    let widestIndex = -1;
    for (const [index, width] of widths.entries()) {
      if (width <= (minimums[index] ?? 1)) {
        continue;
      }
      if (widestIndex === -1 || width > (widths[widestIndex] ?? 0)) {
        widestIndex = index;
      }
    }
    if (widestIndex === -1) {
      break;
    }
    widths[widestIndex] -= 1;
  }
  return widths;
}

function totalWidth(widths: number[]): number {
  return widths.reduce((sum, width) => sum + width, 0) + widths.length * 3 + 1;
}

function renderBorder(widths: number[]): string {
  return `+${widths.map((width) => "-".repeat(width + 2)).join("+")}+`;
}

function renderRow(row: TableCell[], widths: number[], color: boolean): string {
  const cells = widths.map((width, index) => {
    const source = row[index] ?? { text: "" };
    const text = truncate(source.text, width);
    const padding = " ".repeat(Math.max(0, width - displayLength(text)));
    return ` ${paint(text, source.color, color)}${padding} `;
  });
  return `|${cells.join("|")}|`;
}

function paint(text: string, color: TableColor | undefined, enabled: boolean): string {
  if (!enabled || !color) {
    return text;
  }
  return `\x1b[${ansiCodes[color]}m${text}\x1b[0m`;
}

function truncate(value: string, width: number): string {
  if (displayLength(value) <= width) {
    return value;
  }
  if (width <= 0) {
    return "";
  }
  if (width <= 3) {
    return value.slice(0, width);
  }
  return `${value.slice(0, width - 3)}...`;
}

function displayLength(value: string): number {
  return value.length;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function resolvedMaxWidth(options: TableOptions): number {
  if (options.maxWidth !== undefined) {
    return Math.max(10, Math.floor(options.maxWidth));
  }
  const terminalWidth = options.terminalWidth ?? process.stdout.columns;
  if (Number.isFinite(terminalWidth) && terminalWidth > 0) {
    return Math.max(10, Math.min(defaultMaxWidth, Math.floor(terminalWidth)));
  }
  return defaultMaxWidth;
}

function shouldUseColor(options: TableOptions): boolean {
  const env = options.env ?? process.env;
  if (env.NO_COLOR !== undefined) {
    return false;
  }
  if (options.color !== undefined) {
    return options.color;
  }
  return process.stdout.isTTY === true;
}
