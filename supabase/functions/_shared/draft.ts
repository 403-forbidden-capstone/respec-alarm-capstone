// 알람 초안 읽기 — alarm-suggest(5.4.1)와 alarm-commit(5.4.2)이 같은 칸을 같은 이름으로 읽음
//   · 출발 · 이동 · 여유 칸 (readParticipantFields): origin · transport_type · buffer_minutes · before_prepare_minutes · with_wake
//   · 알람 칸 (readAlarmFields): kinds · enabled · manual_times · levels
// 시각은 ISO 8601 + 오프셋, 값 이름은 DB와 같음. 순수 TS — node --test로 시험 (draft.test.ts)
import type { Importance, IntensityAxis, Level, RingKind, Transport } from './calc/types.ts';
import { INTENSITY_AXES, RING_KINDS } from './calc/types.ts';
import type { Reader } from './read.ts';

export const TRANSPORTS = ['WALK', 'TRANSIT', 'BUS', 'SUBWAY', 'CAR'] as const satisfies readonly Transport[];
export const IMPORTANCES = ['LOW', 'NORMAL', 'HIGH'] as const satisfies readonly Importance[];

// 일정 반복 규칙 (D44) — appointments.recurrence_rule · alarms.recurrence_rule. RFC 5545 RRULE의 FREQ로 시작하는 글자만
export const RRULE_PATTERN = /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+-]+)*$/;

export type PlaceInput = { name?: string; lat?: number; lng?: number };

export type ParticipantFields = {
  origin?: PlaceInput;
  transport?: Transport;
  bufferMinutes?: number;
  beforePrepareMinutes?: number;
  withWake?: boolean;
};

export type AlarmFields = {
  kinds?: RingKind[]; // 없음 = 지금 있는 종류 그대로(없으면 계산된 전부), [] = 알람 없는 일정
  enabled?: Partial<Record<RingKind, boolean>>; // 종류별 켜기 · 끄기 (없으면 지금 상태 유지)
  // 직접 고른 알람 시각. 이 칸 전체가 없으면 저장된 직접 값을 그대로 둠, 있으면 이 칸이 전부 (없는 종류 · null = 자동으로 되돌림)
  manualTimes?: Partial<Record<RingKind, Date | null>>;
  // 직접 고른 강도 단계(0 약 · 1 중 · 2 강). 이 칸 전체가 없으면 저장된 직접 값을 그대로 둠, null = 자동
  levels?: Partial<Record<IntensityAxis, Level | null>>;
};

export function readPlace(parent: Reader, key: string, opts: { required?: boolean; nameRequired?: boolean } = {}): PlaceInput | undefined {
  const r = parent.object(key, { required: opts.required });
  if (!r) return undefined;
  const name = r.string('name', { max: 200, required: opts.nameRequired });
  const lat = r.number('lat', { min: -90, max: 90 });
  const lng = r.number('lng', { min: -180, max: 180 });
  if ((lat == null) !== (lng == null)) r.problemAt(lat == null ? 'lat' : 'lng', 'lat · lng는 같이 있어야 해요');
  return { ...(name ? { name } : {}), ...(lat != null && lng != null ? { lat, lng } : {}) };
}

export function readParticipantFields(r: Reader): ParticipantFields {
  const origin = readPlace(r, 'origin');
  const transport = r.oneOf('transport_type', TRANSPORTS);
  const bufferMinutes = r.int('buffer_minutes', { min: 0, max: 240 });
  const beforePrepareMinutes = r.int('before_prepare_minutes', { min: 0, max: 240 });
  const withWake = r.bool('with_wake');
  return {
    ...(origin ? { origin } : {}),
    ...(transport ? { transport } : {}),
    ...(bufferMinutes != null ? { bufferMinutes } : {}),
    ...(beforePrepareMinutes != null ? { beforePrepareMinutes } : {}),
    ...(withWake != null ? { withWake } : {}),
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
