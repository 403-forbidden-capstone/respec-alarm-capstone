// 알람 시각을 직접 고르기 + 순서 확인 — 앱의 features/alarm/adjust.ts(D42 C · D43, 전체작업계획 8.1 F5 해석)를 그대로 옮김
//   · 직접 고른 시각은 "직접 고름"(auto에 자동값)으로 표시하고 자동 계산보다 먼저 씀. 자동값과 같아지면 다시 자동
//   · 기상을 옮기면 준비도 같은 간격으로 따라옴. 출발 · 도착 목표는 약속에 묶여 그대로
//   · 순서(기상 ≤ 준비 ≤ 출발 ≤ 도착 목표)가 뒤집히면 저장을 막음 (같은 시각은 허용, 만든 알람만 비교)
import { sameTime } from './time.ts';
import { KIND_LABEL, type AlarmKind, type ChainAlarm, type RingKind } from './types.ts';

const ORDER: readonly AlarmKind[] = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE'];

// 자동으로 계산했다면 이 시각 — 직접 고르지 않았으면 지금 시각
export const autoTime = (x: ChainAlarm): Date => x.auto ?? x.at;

// 직접 고른 시각인지
export const isManualTime = (x: ChainAlarm): boolean => x.auto != null;

// 시각을 바꾼 알람 — 자동 계산값과 같으면 직접 고른 것이 아님
function withTime(x: ChainAlarm, at: Date): ChainAlarm {
  const base = autoTime(x);
  if (sameTime(at, base)) return { kind: x.kind, at };
  return { kind: x.kind, at, auto: base };
}

// 자동 계산값까지 같이 옮김 — 기상을 옮기면 따라오는 준비 알람 (준비의 자동값도 기상 뒤로 계산하므로)
function shifted(x: ChainAlarm, ms: number): ChainAlarm {
  const move = (d: Date) => new Date(d.getTime() + ms);
  return x.auto ? { kind: x.kind, at: move(x.at), auto: move(x.auto) } : { kind: x.kind, at: move(x.at) };
}

// kind 알람을 to로 옮김. 기상이면 준비 알람도 같은 간격만큼 같이 옮김
export function moveAlarm(alarms: readonly ChainAlarm[], kind: RingKind, to: Date): ChainAlarm[] {
  const target = alarms.find((x) => x.kind === kind);
  if (!target) return [...alarms];
  const delta = to.getTime() - target.at.getTime();
  return alarms.map((x) => {
    if (x.kind === kind) return withTime(x, to);
    if (kind === 'WAKE' && x.kind === 'PREPARE') return shifted(x, delta);
    return x;
  });
}

// 직접 고른 시각을 자동 계산값으로 되돌림 (기상이면 따라온 준비도 함께 되돌아감)
export function resetAlarm(alarms: readonly ChainAlarm[], kind: RingKind): ChainAlarm[] {
  const target = alarms.find((x) => x.kind === kind);
  return target ? moveAlarm(alarms, kind, autoTime(target)) : [...alarms];
}

export type OrderError = {
  earlier: AlarmKind; // 앞이어야 하는 알람
  later: AlarmKind; // 뒤여야 하는데 앞서 버린 알람
  message: string; // 사용자에게 보일 짧은 이유
};

// 순서가 뒤집혔으면 어느 둘이 어긋났는지, 맞으면 null — 저장을 막을 때 씀
export function orderError(alarms: readonly ChainAlarm[]): OrderError | null {
  const sorted = ORDER.flatMap((kind) => alarms.filter((x) => x.kind === kind));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const next = sorted[i];
    if (next.at.getTime() >= prev.at.getTime()) continue;
    const message =
      next.kind === 'ARRIVE'
        ? `${KIND_LABEL[prev.kind]} 시각이 도착 목표보다 늦을 수 없어요`
        : `${KIND_LABEL[next.kind]} 시각이 ${KIND_LABEL[prev.kind]}보다 빠를 수 없어요`;
    return { earlier: prev.kind, later: next.kind, message };
  }
  return null;
}
