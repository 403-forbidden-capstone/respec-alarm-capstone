// 시각 계산 — Date 위에서 분 단위만

export const MINUTE_MS = 60_000;

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * MINUTE_MS);
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / MINUTE_MS);
}

export function sameTime(a: Date | undefined | null, b: Date | undefined | null): boolean {
  return a != null && b != null && a.getTime() === b.getTime();
}
