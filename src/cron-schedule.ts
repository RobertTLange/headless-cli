export type CronSchedule =
  | { kind: "every"; value: string; intervalMs: number }
  | { kind: "cron"; value: string };

export function parseCronSchedule(input: { every?: string; schedule?: string }): CronSchedule {
  if (input.every && input.schedule) {
    throw new Error("use either --every or --schedule");
  }
  if (input.every) {
    const match = /^([1-9][0-9]*)([smhd])$/.exec(input.every);
    if (!match) {
      throw new Error("--every must be a positive duration such as 30m, 6h, or 1d");
    }
    const count = Number.parseInt(match[1] ?? "0", 10);
    const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    return { kind: "every", value: input.every, intervalMs: count * (units[match[2] ?? ""] ?? 0) };
  }
  if (input.schedule) {
    parseCronFields(input.schedule);
    return { kind: "cron", value: input.schedule };
  }
  throw new Error("use either --every or --schedule");
}

export function nextCronRun(schedule: CronSchedule, after: Date): Date {
  if (schedule.kind === "every") {
    return new Date(after.getTime() + schedule.intervalMs);
  }
  const fields = parseCronFields(schedule.value);
  const candidate = new Date(after.getTime());
  candidate.setMilliseconds(0);
  candidate.setSeconds(0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  const deadline = after.getTime() + 366 * 5 * 24 * 60 * 60 * 1000;
  while (candidate.getTime() <= deadline) {
    if (cronFieldsMatch(fields, candidate)) {
      return candidate;
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  throw new Error(`could not resolve next run for schedule: ${schedule.value}`);
}

function parseCronFields(expression: string): number[][] {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("--schedule must be a five-field cron expression");
  }
  return [
    parseCronField(parts[0] ?? "", 0, 59, false),
    parseCronField(parts[1] ?? "", 0, 23, false),
    parseCronField(parts[2] ?? "", 1, 31, false),
    parseCronField(parts[3] ?? "", 1, 12, false),
    parseCronField(parts[4] ?? "", 0, 7, true),
  ];
}

function parseCronField(value: string, min: number, max: number, sundayAlias: boolean): number[] {
  const values = new Set<number>();
  for (const chunk of value.split(",")) {
    const [rangeRaw, stepRaw] = chunk.split("/");
    const step = stepRaw === undefined ? 1 : Number.parseInt(stepRaw, 10);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`invalid cron step: ${value}`);
    }
    const [start, end] = parseCronRange(rangeRaw ?? "", min, max);
    for (let current = start; current <= end; current += step) {
      values.add(sundayAlias && current === 7 ? 0 : current);
    }
  }
  if (values.size === 0) {
    throw new Error(`invalid cron field: ${value}`);
  }
  return [...values].sort((left, right) => left - right);
}

function parseCronRange(value: string, min: number, max: number): [number, number] {
  if (value === "*") {
    return [min, max];
  }
  if (value.includes("-")) {
    const [left, right] = value.split("-");
    const start = parseCronNumber(left ?? "", min, max);
    const end = parseCronNumber(right ?? "", min, max);
    if (start > end) {
      throw new Error(`invalid cron range: ${value}`);
    }
    return [start, end];
  }
  const single = parseCronNumber(value, min, max);
  return [single, single];
}

function parseCronNumber(value: string, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value || parsed < min || parsed > max) {
    throw new Error(`invalid cron value: ${value}`);
  }
  return parsed;
}

function cronFieldsMatch(fields: number[][], date: Date): boolean {
  const [minutes = [], hours = [], days = [], months = [], weekdays = []] = fields;
  const dayOfMonthWildcard = days.length === 31;
  const dayOfWeekWildcard = weekdays.length === 7;
  const dayOfMonthMatches = days.includes(date.getDate());
  const dayOfWeekMatches = weekdays.includes(date.getDay());
  const dayMatches =
    dayOfMonthWildcard || dayOfWeekWildcard
      ? dayOfMonthMatches && dayOfWeekMatches
      : dayOfMonthMatches || dayOfWeekMatches;
  return (
    minutes.includes(date.getMinutes()) &&
    hours.includes(date.getHours()) &&
    months.includes(date.getMonth() + 1) &&
    dayMatches
  );
}
