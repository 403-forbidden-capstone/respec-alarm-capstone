// ALG-01 알람 역산 — 앱 목업 계산(mobile/src/mocks/calc.ts alarmChain)을 그대로 옮김 (D56 열림 = 목업 규칙 유지)
//   출발 = 약속 − 여유 − 이동, 기상 = 출발 − 준비(기상~출발), 준비 알람 = 기상 + 준비 전 활동, 도착 목표 = 약속 − 여유
//   그날 첫 일정이 아니면(기상 알람 없음) 준비 알람만: 출발 − 준비
//   준비 알람 당김(prepareAdvanceMinutes, 안건 D111 1 · 2번): 준비 알람을 그만큼 앞당김 — 준비 전 활동에서 먼저 가져오고, 모자란 만큼만 기상도 앞당김
//     준비 전 활동을 다 써도 준비 알람은 남김(기상과 같은 시각) — 준비 시작 기록(#490)과 다음 제안의 대상이 그 알람이라서
//   kinds가 있으면 H05에서 고른 종류만 — 도착 목표는 울리는 알람이 하나라도 있을 때만, 하나도 없으면 빈 목록(알람 없는 일정)
//   manualTimes가 있으면 직접 고른 시각이 자동 계산보다 먼저. 직접 고른 알람은 auto에 자동 계산값을 남김
//     준비 알람의 자동값은 (직접 고른 시각을 포함한) 기상 시각 뒤 — 기상을 옮기면 준비도 같은 간격으로 따라옴
// 문서(7장 7.1.1)와 다른 점은 목업 쪽을 따름: 도착 알람 = 약속 − 여유 (7장은 약속 시각), 준비 시간 = 기상~출발 한 덩어리 (F1 → D56)
import { addMinutes, sameTime } from './time.ts';
import type { ChainAlarm, ChainInput, RingKind } from './types.ts';

export function departureAuto(input: ChainInput): Date {
  return addMinutes(input.at, -(input.bufferMinutes + input.travelMinutes));
}

export function alarmChain(input: ChainInput): ChainAlarm[] {
  const depart = departureAuto(input);
  const alarm = (kind: ChainAlarm['kind'], auto: Date): ChainAlarm => {
    const picked = kind === 'ARRIVE' ? undefined : input.manualTimes?.[kind]; // 도착 목표는 약속에 묶여 직접 고르지 않음
    return picked != null && !sameTime(picked, auto) ? { kind, at: picked, auto } : { kind, at: auto };
  };
  const list: ChainAlarm[] = [];
  const advance = Math.max(0, input.prepareAdvanceMinutes ?? 0);
  if (input.withWake) {
    const fromBefore = Math.min(advance, input.beforePrepareMinutes);
    const wake = alarm('WAKE', addMinutes(depart, -(input.prepareMinutes + advance - fromBefore)));
    list.push(wake);
    if (input.beforePrepareMinutes > 0) list.push(alarm('PREPARE', addMinutes(wake.at, input.beforePrepareMinutes - fromBefore)));
  } else {
    list.push(alarm('PREPARE', addMinutes(depart, -(input.prepareMinutes + advance))));
  }
  list.push(alarm('DEPARTURE', depart));
  list.push(alarm('ARRIVE', addMinutes(input.at, -input.bufferMinutes)));
  const kinds = input.kinds;
  if (!kinds) return list;
  const made = list.filter((x) => x.kind === 'ARRIVE' || (kinds as readonly string[]).includes(x.kind));
  return made.some((x) => x.kind !== 'ARRIVE') ? made : [];
}

// 출발 시각 (직접 고른 출발이 있으면 그것). DEPARTURE 알람을 만들지 않아도 단축 준비 안내(departAt) · 출발 지남 검사에 씀
export function departureAt(input: ChainInput): Date {
  const full = alarmChain({ ...input, kinds: undefined });
  const found = full.find((x) => x.kind === 'DEPARTURE');
  return found ? found.at : departureAuto(input);
}

// 직접 고른 시각만 모음 — 자동 계산값과 같으면 직접 고른 것이 아님
export function manualTimes(alarms: readonly ChainAlarm[]): Partial<Record<RingKind, Date>> {
  const times: Partial<Record<RingKind, Date>> = {};
  for (const x of alarms) if (x.kind !== 'ARRIVE' && x.auto) times[x.kind] = x.at;
  return times;
}
