// 서버 함수(alarm-suggest · alarm-commit)의 요청 만들기 · 응답 읽기 — 순수 함수만 (시험: __tests__/request.test.ts)
// 요청은 서버의 H05 초안 모양 하나: appointment_id(기존 약속) 또는 appointment{…}(새 약속) + participant{…} + 루트 kinds · enabled · manual_times · levels
//   (commit만 title · replace_existing · edits). 모양은 supabase/README.md "서버 함수", 서버 쪽은 supabase/functions/_shared/requests.ts
// 서버가 안 읽는 칸을 보내면 거절(VALIDATION_FAILED)하므로 README의 이름 그대로만 보냄
import type { RingPackage } from '@capstone/alarm-core';

import { parseDbTime } from '@/lib/dbTime';
import { minutesBetween } from '@/lib/format';
import type { Weekday } from '@/lib/weekday';

import { validDestRadius } from './destinationPick';
import { TRAVEL_SOURCE_LABEL } from './map';
import { toPoint } from './places';
import { repeatLabel, repeatToRrule } from './repeat';
import type { TravelProblem } from './travelConfirm';
import {
  MANUAL_SOURCE,
  ORIGIN_HOME,
  RING_KINDS,
  type AlarmEdits,
  type AlarmIntensity,
  type AlarmKind,
  type AlarmPreview,
  type AlarmSettingsDraft,
  type AlarmTime,
  type Appointment,
  type AppointmentDetail,
  type AppointmentDraft,
  type CommitEditScreen,
  type Estimate,
  type IntensityAxis,
  type JoinChoice,
  type Level,
  type RingKind,
} from './types';

export type Body = Record<string, unknown>;

// ---------------------------------------------------------------------------
// 서버 응답 모양 (필요한 칸만)
// ---------------------------------------------------------------------------

export type TravelSourceCode = 'API' | 'CACHED' | 'ESTIMATE' | 'MANUAL';

export type SuggestionAlarm = {
  alarm_type: AlarmKind;
  scheduled_at: string | null;
  auto_scheduled_at: string | null;
  is_enabled: boolean;
};

export type Suggestion = {
  appointment_at: string;
  arrive_at: string | null;
  alarms: SuggestionAlarm[];
  check: { ok: boolean; reason?: string; message?: string };
  travel: {
    minutes: number | null;
    source: TravelSourceCode | null;
    manual_required: boolean;
    needs_confirmation: boolean;
    note: string | null;
    auto_minutes: number | null;
  };
  prepare: {
    minutes: number;
    auto_minutes: number;
    common_p80: number;
    correction: number;
    sample_count: number;
    prior: number;
    weight: number;
    residual_p80: number;
    before_prepare_minutes: number;
    recent?: number[]; // 내 기상~출발 기록 최근 5개, 최신순 (서버 학습 기초 b부터. 옛 서버 응답에는 없음)
  };
  intensity: {
    level: AlarmIntensity;
    auto_level: Level;
    late_point: number;
    axes: Record<IntensityAxis, { level: Level; manual: boolean }>;
  };
  with_wake: boolean;
  same_day_wake: boolean;
};

export type CommitAlarm = {
  alarm_id: string;
  alarm_type: AlarmKind | 'ROUTINE';
  scheduled_at: string;
  is_enabled: boolean;
  intensity: AlarmIntensity;
  voice_tone: 'CALM' | 'NEUTRAL' | 'DIRECT';
  sound_key: string | null;
  vibration: string | null; // 직접 고른 진동만 값, 자동이면 null (강도를 따름)
  time_source: 'AUTO' | 'MANUAL';
  intensity_source: 'AUTO' | 'MANUAL';
  recurrence_rule: string | null;
};

export type CommitResponse = {
  appointment_id?: string;
  participant_id?: string;
  alarm_id?: string; // 일정 없는 알람
  alarms: CommitAlarm[];
  ring_packages: RingPackage[];
  canceled_alarm_ids: string[];
};

// ---------------------------------------------------------------------------
// 요청 만들기
// ---------------------------------------------------------------------------

const iso = (d: Date) => d.toISOString();

// 서버가 받는 분 단위 범위 (supabase/functions/_shared/requests.ts · draft.ts) — 넘으면 저장이 통째로 VALIDATION_FAILED로 거절됨
//   서버가 직선거리로 어림한 이동시간은 상한이 없어(먼 거리 자차 약 800분) 확인 시트의 값이 600을 넘을 수 있으므로 보내는 쪽에서 범위 안으로 맞춤
const MAX_TRAVEL_MINUTES = 600;
const MAX_PREPARE_MINUTES = 600;
const MAX_BUFFER_MINUTES = 240;
const MAX_BEFORE_PREPARE_MINUTES = 240;
const within = (minutes: number, max: number) => Math.min(max, Math.max(0, Math.round(minutes)));

// 도착지 — 좌표가 있고 감지 반경(100~500 정수)을 골랐을 때만 radius_m을 실음 (칸이 없는 옛 서버·고르지 않은 일정에는 안 보냄)
function destinationBody(d: AppointmentDraft): Body {
  const point = toPoint(d.place, { lat: d.placeLat, lng: d.placeLng });
  const radius = validDestRadius(d.destRadiusM);
  return radius != null && point.lat != null && point.lng != null ? { ...point, radius_m: radius } : point;
}

// 새 일정 (H05) — 중요도는 늘 보냄 (서버 기본은 NORMAL(중요)이고 초안 기본은 LOW(보통)이라 안 보내면 값이 달라짐)
//   현재 위치를 고르면 그 좌표를 출발지로 보내고, 아니면 프로필에 저장된 집을 씀
export function newAppointmentBody(d: AppointmentDraft, at: Date): Body {
  const rule = repeatToRrule(d.repeat);
  return {
    appointment: {
      title: d.title.trim() || '새 일정',
      appointment_at: iso(at),
      destination: destinationBody(d),
      importance: d.importance,
      ...(rule ? { recurrence_rule: rule } : {}),
      ...(d.groupId ? { group_id: d.groupId } : {}), // 함께할 그룹 (친구 9장)
    },
    participant: { origin: d.originLocation ? { name: d.originName || '현재 위치', lat: d.originLocation.lat, lng: d.originLocation.lng } : { name: ORIGIN_HOME }, transport_type: d.transport },
    kinds: RING_KINDS.filter((kind) => d.alarms[kind]),
    ...(d.levels && Object.values(d.levels).some((level) => level != null) ? { levels: d.levels } : {}),
  };
}

// 공동 약속 [내 알람 만들기] (친구 9장) — 기존 약속 id + 내 집 · 고른 수단(+ 고친 준비 시간) + 기상 · 준비 · 출발. 서버가 내 참여 조건과 알람을 만듦
export function joinBody(appointmentId: string, choice: JoinChoice): Body {
  return {
    appointment_id: appointmentId,
    participant: {
      origin: { name: ORIGIN_HOME },
      transport_type: choice.transport,
      ...(choice.prepareMinutes != null ? { prepare_minutes: within(choice.prepareMinutes, MAX_PREPARE_MINUTES) } : {}),
      ...(choice.travelMinutes != null ? { est_travel_minutes: within(choice.travelMinutes, MAX_TRAVEL_MINUTES), travel_source: 'MANUAL' } : {}),
    },
    kinds: [...RING_KINDS],
  };
}

// 직접 고른 알람 시각 전부 (이 칸이 있으면 서버는 이 칸이 전부라고 봄 — 없는 종류는 자동으로 되돌림)
export function manualTimesBody(times: AlarmEdits['times']): Partial<Record<RingKind, string>> {
  const out: Partial<Record<RingKind, string>> = {};
  for (const kind of RING_KINDS) {
    const at = times[kind];
    if (at) out[kind] = iso(at);
  }
  return out;
}

// 기존 약속 (H03) — 화면이 보여 준 값이 서버 계산과 어긋나 알람이 슬쩍 움직이지 않게 저장돼 있던 값은 그대로 이어 보냄
//   · 이동시간: 직접 입력(MANUAL)한 값만 그 값으로 보내고, 그 밖에는 안 보내서 서버가 새로 구함 (서버는 직접 입력으로 저장된 것은 스스로 이어받음)
//     저장된 길찾기(API) 값은 다시 보내지 않음 — 카카오 응답은 저장 · 재사용 불허(D5)라 서버가 매번 새로 구하는 것이 규칙 (supabase/README.md alarm-commit, 서버 plan.ts)
//   · 준비 시간: AUTO로 저장된 일정은 오래된 숫자 스냅샷을 보내지 않고 서버가 다시 계산함.\n//     수동(MANUAL)·기존(LEGACY) 시간은 직접 고른 값 또는 저장된 시간을 계속 이어 보냄.
//   · 준비 전 활동: 기상 · 준비 알람이 둘 다 있으면 지금 간격 (서버가 직접 고른 시각이 있는 약속에서 기본 20분으로 다시 읽지 않게)
export function existingBody(saved: AppointmentDetail, edits: AlarmEdits): Body {
  const travel = edits.travelMinutes != null ? { est_travel_minutes: within(edits.travelMinutes, MAX_TRAVEL_MINUTES), travel_source: 'MANUAL' } : {};
  return {
    appointment_id: saved.id,
    participant: {
      origin: toPoint(edits.origin),
      transport_type: edits.transport,
      buffer_minutes: within(edits.bufferMinutes, MAX_BUFFER_MINUTES),
      ...travel,
      // H03 existing AUTO values are old persisted estimates, NOT a current
      // H05 preview snapshot. Recompute on commit without a stale equality check.
      // The saved participant's AUTO provenance remains unchanged on UPDATE.
      ...(edits.prepareMinutes == null && saved.prepareValueSource === 'AUTO'
        ? {}
        : { prepare_minutes: within(edits.prepareMinutes ?? saved.predictedPrepMinutes, MAX_PREPARE_MINUTES) }),
      // Legacy rows must not silently become AUTO; MANUAL stays manual.
      ...(edits.prepareMinutes != null || saved.prepareValueSource === 'MANUAL'
        ? { prepare_value_source: 'MANUAL' }
        : {}),
      ...(saved.beforePrepMinutes > 0 ? { before_prepare_minutes: within(saved.beforePrepMinutes, MAX_BEFORE_PREPARE_MINUTES) } : {}),
    },
    manual_times: manualTimesBody(edits.times),
  };
}

// H03 저장 — 미리 보기 요청 + 종류별 켜기 · 강도(null = 자동) + 고친 값 기록
export function settingsCommitBody(base: Body, draft: AlarmSettingsDraft, edits: readonly EditPayload[]): Body {
  const enabled: Partial<Record<RingKind, boolean>> = {};
  for (const kind of RING_KINDS) {
    const on = draft.kinds[kind];
    if (on != null) enabled[kind] = on;
  }
  return {
    ...base,
    enabled,
    levels: { sound: draft.levels.sound, voice: draft.levels.voice, vibration: draft.levels.vibration },
    edits,
    ...(draft.linkWakeAlarmId ? { link_wake_alarm_id: draft.linkWakeAlarmId } : {}),
  };
}

// 일정 없는 알람 (D46 · Q10) — 만들기는 시각 필수, 고치기는 alarm_id만 있으면 시각 없이 { levels } · { is_enabled }도 됨
export type StandaloneInput = {
  alarmId?: string;
  at?: Date;
  repeat?: readonly Weekday[]; // [] = 반복 없음, 없으면 그대로
  level?: Level | null; // 강도 한 단계 (세 칸에 같이), null = 자동, 없으면 그대로
  enabled?: boolean;
};

export function standaloneBody(input: StandaloneInput): Body {
  const rule = input.repeat ? repeatToRrule(input.repeat) : undefined;
  const levels =
    input.level === undefined
      ? undefined
      : { sound: input.level, voice: input.level, vibration: input.level };
  return {
    type: 'STANDALONE',
    alarm: {
      ...(input.alarmId ? { alarm_id: input.alarmId } : {}),
      ...(input.at ? { scheduled_at: iso(input.at) } : {}),
      ...(input.repeat ? { recurrence_rule: rule } : {}), // [] → null (반복 끔)
      ...(input.enabled != null ? { is_enabled: input.enabled } : {}),
      ...(levels ? { levels } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// 고친 값 기록 (user_edit_logs) — alarm-commit의 edits로 보냄 (저장이 성공해야 기록이 남음)
// ---------------------------------------------------------------------------

export type EditPayload = {
  screen: CommitEditScreen;
  field: string;
  alarm_type?: AlarmKind;
  auto_value: unknown;
  edited_value: unknown;
};

const jsonValue = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v === undefined ? null : v);

// 화면 UserEditLog(Date · undefined 섞임) → 서버 edits 한 줄. 날짜는 ISO 글자, 비면 null (edited_value null = 자동으로 되돌림)
export function toEditPayload(log: {
  screen: EditPayload['screen'];
  field: string;
  alarmType?: AlarmKind;
  autoValue: unknown;
  editedValue: unknown;
}): EditPayload {
  return {
    screen: log.screen,
    field: log.field,
    ...(log.alarmType ? { alarm_type: log.alarmType } : {}),
    auto_value: jsonValue(log.autoValue),
    edited_value: jsonValue(log.editedValue),
  };
}

// ---------------------------------------------------------------------------
// 응답 읽기
// ---------------------------------------------------------------------------

// 알람 한 줄 — 도착 목표는 늘 켜짐으로 보임 (map.toAlarmTime과 같은 규칙)
function toTime(a: { alarm_type: AlarmKind | 'ROUTINE'; scheduled_at: string | null; is_enabled: boolean }, id: string, auto?: string | null): AlarmTime | null {
  if (a.alarm_type === 'ROUTINE' || !a.scheduled_at) return null;
  return {
    id,
    kind: a.alarm_type,
    at: parseDbTime(a.scheduled_at),
    enabled: a.alarm_type === 'ARRIVE' || a.is_enabled,
    ...(auto ? { auto: parseDbTime(auto) } : {}),
  };
}

// 기상 · 준비 · 출발 · 도착 순 (서버 chain 순서 그대로지만 방어)
const ORDER: readonly AlarmKind[] = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE'];
const byKindOrder = (x: AlarmTime, y: AlarmTime) => ORDER.indexOf(x.kind) - ORDER.indexOf(y.kind);

// 알람 id를 아직 모르는 새 일정의 자리 id
export const draftAlarmId = (kind: AlarmKind) => `draft:${kind}`;

export function suggestionAlarms(s: Suggestion, idOf: (kind: AlarmKind) => string): AlarmTime[] {
  return s.alarms
    .flatMap((a) => {
      const time = toTime(a, idOf(a.alarm_type), a.auto_scheduled_at);
      return time ? [time] : [];
    })
    .sort(byKindOrder);
}

const travelLabel = (source: TravelSourceCode | null): string => (source ? TRAVEL_SOURCE_LABEL[source] : '');

// H03 미리 보기 — 서버가 직접 입력(MANUAL)이어도 자동 이동시간(travel.auto_minutes)을 같이 줌
//   이동시간을 구할 길이 없으면(좌표 없음 · 직접 입력 없음) 서버가 minutes null + manual_required를 줌 → 저장된 값을 그대로 보여 주고,
//   화면의 "예상 이동" 칸에 직접 입력하게 함 (그대로 저장하려 하면 alarm-commit이 이동시간을 직접 입력해 달라고 UserError로 알려 줌)
export function toPreview(s: Suggestion, saved: AppointmentDetail, edits: AlarmEdits): AlarmPreview {
  const idOf = (kind: AlarmKind) => saved.alarms.find((x) => x.kind === kind)?.id ?? `${saved.id}:${kind}`;
  const travelMinutes = s.travel.minutes ?? edits.travelMinutes ?? saved.travelMinutes;
  const problem = travelProblemOf(s);
  return {
    alarms: s.travel.manual_required && !s.alarms.length ? saved.alarms : suggestionAlarms(s, idOf),
    travelMinutes,
    travelSource: s.travel.manual_required ? saved.travelSource : travelLabel(s.travel.source),
    autoTravelMinutes: s.travel.auto_minutes ?? s.travel.minutes ?? saved.auto.travelMinutes,
    predictedPrepMinutes: s.prepare.minutes,
    autoPredictedPrepMinutes: saved.auto.predictedPrepMinutes,
    prepareSampleCount: s.prepare.sample_count,
    ...(s.prepare.recent ? { prepareRecent: s.prepare.recent } : {}),
    ...(problem ? { travelProblem: problem } : {}),
    withWake: s.with_wake,
  };
}

// 길찾기 값(API)이나 직접 입력(MANUAL)이 아니라 저장하면 확인이 필요하거나, 아예 이동시간을 못 구한 미리 보기 (travelConfirm.ts)
//   저장은 alarm-commit이 정함(길찾기가 다시 되면 확인 없이 저장될 수도 있음) — 여기는 H03 화면에 미리 알려 주는 용도
export function travelProblemOf(s: Pick<Suggestion, 'travel'>): TravelProblem | null {
  if (s.travel.manual_required) return 'MANUAL_REQUIRED';
  return s.travel.source === 'ESTIMATE' || s.travel.source === 'CACHED' ? s.travel.source : null;
}

// 새 일정 계산 결과 (H05 확인 시트). 아직 저장 전이라 일정 id · 알람 id는 자리 값
export function toEstimate(s: Suggestion, d: AppointmentDraft, at: Date, body: Body, seq: number): Estimate {
  const alarms = suggestionAlarms(s, draftAlarmId);
  const arrive = s.arrive_at ? parseDbTime(s.arrive_at) : null;
  const travelMinutes = s.travel.minutes ?? 0;
  const before = s.prepare.before_prepare_minutes;
  const rule = repeatToRrule(d.repeat);
  const appointment: Appointment = {
    id: `draft:${seq}`,
    title: d.title.trim() || '새 일정',
    at,
    place: d.place,
    origin: d.originLocation ? d.originName || '현재 위치' : ORIGIN_HOME,
    transport: d.transport,
    travelMinutes,
    travelSource: travelLabel(s.travel.source),
    bufferMinutes: arrive ? minutesBetween(arrive, at) : 0, // 서버가 프로필 기본 여유를 씀 — 도착 목표 = 약속 − 여유
    beforePrepMinutes: before,
    prepMinutes: Math.max(0, s.prepare.minutes - before),
    predictedPrepMinutes: s.prepare.minutes,
    importance: d.importance,
    repeatLabel: repeatLabel(d.repeat),
    recurrenceRule: rule,
    groupName: null,
    items: d.items
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
    withWake: s.with_wake,
    enabled: true,
    alarms,
    level: s.intensity.axes.sound.level,
  };
  return {
    appointment,
    commonP80: s.prepare.common_p80,
    correction: s.prepare.correction,
    sampleCount: s.prepare.sample_count,
    prior: s.prepare.prior,
    weight: s.prepare.weight,
    residualP80: s.prepare.residual_p80,
    sameDayWake: s.same_day_wake,
    latePoint: s.intensity.late_point,
    ...(d.levels ? { levels: d.levels } : {}),
    ...(s.travel.note ? { travelNote: s.travel.note } : {}),
    travelNeedsConfirm: s.travel.needs_confirmation,
    commit: { body, travelSource: s.travel.source ?? 'MANUAL' },
  };
}

// 확인 시트에서 고른 값 그대로 저장하는 요청 (H05) — 보여 준 이동시간 · 준비 시간 · 준비 전 활동 · 기상 여부를 그대로 박고, 직접 고른 시각을 보냄
//   이동시간은 길찾기(API)면 API로, 그 밖(실측 중앙값 CACHED · 근사 ESTIMATE · 직접 MANUAL)이면 사용자가 확인한 값으로 보고 MANUAL로 (서버는 API · MANUAL만 저장)
export function createCommitBody(estimate: Estimate, picked: AlarmEdits['times'], edits: readonly EditPayload[]): Body | null {
  const commit = estimate.commit;
  if (!commit) return null;
  const a = estimate.appointment;
  const base = commit.body as { appointment?: Body; participant?: Body };
  return {
    ...commit.body,
    appointment: { ...base.appointment, title: a.title },
    participant: {
      ...base.participant,
      buffer_minutes: within(a.bufferMinutes, MAX_BUFFER_MINUTES),
      est_travel_minutes: within(a.travelMinutes, MAX_TRAVEL_MINUTES),
      travel_source: commit.travelSource === 'API' ? 'API' : 'MANUAL',
      prepare_minutes: within(a.predictedPrepMinutes, MAX_PREPARE_MINUTES),
      // Automatic H05 preview is checked by server on commit, not a manual override.
      prepare_value_source: 'AUTO',
      before_prepare_minutes: within(a.beforePrepMinutes, MAX_BEFORE_PREPARE_MINUTES),
      with_wake: a.withWake,
    },
    manual_times: manualTimesBody(picked),
    edits,
  };
}

// 저장 결과 → 목록이 쓰는 일정. 알람 id는 서버가 만든 UUID로 바뀌고, 직접 고른 시각의 자동값은 확인 시트의 값을 이어 씀
export function toCreatedAppointment(res: CommitResponse, estimate: Estimate): Appointment {
  const a = estimate.appointment;
  const alarms = res.alarms
    .flatMap((row) => {
      const auto = a.alarms.find((x) => x.kind === row.alarm_type)?.auto;
      const time = toTime(row, row.alarm_id, auto ? auto.toISOString() : null);
      return time ? [time] : [];
    })
    .sort(byKindOrder);
  return {
    ...a,
    id: res.appointment_id ?? a.id,
    alarms,
    enabled: alarms.some((x) => x.kind !== 'ARRIVE' && x.enabled),
    travelSource: a.travelSource || MANUAL_SOURCE,
  };
}
