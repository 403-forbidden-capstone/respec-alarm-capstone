// 알람 초안 읽기 — alarm-suggest(5.4.1)와 alarm-commit(5.4.2)이 같은 칸을 같은 이름으로 읽음
//   · 출발 · 이동 · 여유 칸 (readParticipantFields): origin · transport_type · buffer_minutes · before_prepare_minutes · with_wake · activities
//   · 알람 칸 (readAlarmFields): kinds · enabled · manual_times · levels
// 시각은 ISO 8601 + 오프셋, 값 이름은 DB와 같음. 순수 TS — node --test로 시험 (draft.test.ts)
import type { DayActivity } from './calc/day.ts';
import type { Importance, IntensityAxis, Level, RingKind, Transport } from './calc/types.ts';
import { INTENSITY_AXES, RING_KINDS } from './calc/types.ts';
import { RRULE_PATTERN } from './calc/recur.ts';
import type { Reader } from './read.ts';

export const TRANSPORTS = ['WALK', 'TRANSIT', 'BUS', 'SUBWAY', 'CAR'] as const satisfies readonly Transport[];
export const IMPORTANCES = ['LOW', 'NORMAL', 'HIGH'] as const satisfies readonly Importance[];

// 일정 반복 규칙 (D44) — appointments.recurrence_rule · alarms.recurrence_rule. 두 모양만 받음: FREQ=DAILY · FREQ=WEEKLY;BYDAY=MO,… (앱이 만드는 모양, repeat.ts repeatToRrule).
// MONTHLY · INTERVAL · COUNT 같은 그 밖은 VALIDATION_FAILED — 앱 표시와 alarm-roll이 만드는 회차가 어긋나지 않게 (정의는 calc/recur.ts, 설계 메모 L1 PR 3 2절)
export { RRULE_PATTERN };

// radiusM: 목적지 감지 반경(m, 100~500) — 새 약속의 destination에만 읽음 (appointments.dest_radius_m, D68). 출발지에는 저장 칸이 없어 읽지 않음
export type PlaceInput = { name?: string; lat?: number; lng?: number; radiusM?: number };

export type ParticipantFields = {
  origin?: PlaceInput;
  transport?: Transport;
  bufferMinutes?: number;
  beforePrepareMinutes?: number;
  withWake?: boolean;
  // 기상 뒤 출발 전에 집에서 하는 할 일 (calc/day.ts) — 저장하지 않고 이번 계산에만 씀. 없으면 기존 계산 그대로
  activities?: DayActivity[];
};

// 할 일은 하루에 몇 개만 (AI 대화 · 화면에서 한 번에 말하는 정도)
export const MAX_ACTIVITIES = 5;

export type AlarmFields = {
  kinds?: RingKind[]; // 없음 = 지금 있는 종류 그대로(없으면 계산된 전부), [] = 알람 없는 일정
  enabled?: Partial<Record<RingKind, boolean>>; // 종류별 켜기 · 끄기 (없으면 지금 상태 유지)
  // 직접 고른 알람 시각. 이 칸 전체가 없으면 저장된 직접 값을 그대로 둠, 있으면 이 칸이 전부 (없는 종류 · null = 자동으로 되돌림)
  manualTimes?: Partial<Record<RingKind, Date | null>>;
  // 직접 고른 강도 단계(0 약 · 1 중 · 2 강). 이 칸 전체가 없으면 저장된 직접 값을 그대로 둠, null = 자동
  levels?: Partial<Record<IntensityAxis, Level | null>>;
};

export function readPlace(parent: Reader, key: string, opts: { required?: boolean; nameRequired?: boolean; radius?: boolean } = {}): PlaceInput | undefined {
  const r = parent.object(key, { required: opts.required });
  if (!r) return undefined;
  const name = r.string('name', { max: 200, required: opts.nameRequired });
  const lat = r.number('lat', { min: -90, max: 90 });
  const lng = r.number('lng', { min: -180, max: 180 });
  if ((lat == null) !== (lng == null)) r.problemAt(lat == null ? 'lat' : 'lng', 'lat · lng는 같이 있어야 해요');
  const radiusM = opts.radius ? r.int('radius_m', { min: 100, max: 500 }) : undefined;
  return { ...(name ? { name } : {}), ...(lat != null && lng != null ? { lat, lng } : {}), ...(radiusM != null ? { radiusM } : {}) };
}

export function readParticipantFields(r: Reader): ParticipantFields {
  const origin = readPlace(r, 'origin');
  const transport = r.oneOf('transport_type', TRANSPORTS);
  const bufferMinutes = r.int('buffer_minutes', { min: 0, max: 240 });
  const beforePrepareMinutes = r.int('before_prepare_minutes', { min: 0, max: 240 });
  const withWake = r.bool('with_wake');
  // activities[{ title?, start, end?, before_prepare? }] — end · before_prepare를 모르면 비워 보냄(계산이 NEEDS_INFO로 빠진 칸을 알려 줌)
  const activities = r.objects('activities', { max: MAX_ACTIVITIES })?.flatMap((a): DayActivity[] => {
    const title = a.string('title', { max: 100 });
    const start = a.date('start', { required: true });
    const end = a.date('end');
    const beforePrepare = a.bool('before_prepare');
    if (start && end && end.getTime() <= start.getTime()) a.problemAt('end', 'end는 start보다 뒤여야 해요');
    return start ? [{ ...(title ? { title } : {}), start, ...(end ? { end } : {}), ...(beforePrepare != null ? { beforePrepare } : {}) }] : [];
  });
  return {
    ...(origin ? { origin } : {}),
    ...(transport ? { transport } : {}),
    ...(bufferMinutes != null ? { bufferMinutes } : {}),
    ...(beforePrepareMinutes != null ? { beforePrepareMinutes } : {}),
    ...(withWake != null ? { withWake } : {}),
    ...(activities?.length ? { activities } : {}),
  };
}

export function readAlarmFields(r: Reader): AlarmFields {
  const out: AlarmFields = {};

  const kinds = r.stringList('kinds', RING_KINDS, { max: 3 });
  if (kinds) out.kinds = kinds;

  const enabled = r.object('enabled');
  if (enabled) {
    out.enabled = {};
    for (const kind of RING_KINDS) {
      const v = enabled.bool(kind);
      if (v != null) out.enabled[kind] = v;
    }
  }

  const times = r.object('manual_times');
  if (times) {
    out.manualTimes = {};
    for (const kind of RING_KINDS) {
      if (times.isNull(kind)) out.manualTimes[kind] = null;
      else {
        const at = times.date(kind);
        if (at) out.manualTimes[kind] = at;
      }
    }
  }

  const levels = r.object('levels');
  if (levels) {
    out.levels = {};
    for (const axis of INTENSITY_AXES) {
      if (levels.isNull(axis)) out.levels[axis] = null;
      else {
        const v = levels.int(axis, { min: 0, max: 2 });
        if (v != null) out.levels[axis] = v as Level;
      }
    }
  }
  return out;
}

export function readRecurrence(r: Reader, key = 'recurrence_rule'): string | null | undefined {
  if (r.isNull(key)) return null;
  return r.string(key, { max: 100, pattern: RRULE_PATTERN });
}
