// 알람 계획 만들기 — DB에서 읽어 온 값(PlanInputs)과 요청 초안(PlanDraft)을 합쳐 calc/로 계산 (순수 · node --test)
//   alarm-suggest(미리 보기)와 alarm-commit(저장)이 같은 계산을 씀 → 보여 준 시각 = 저장되는 시각
// 합치는 규칙:
//   · 약속 시각 · 장소 · 중요도는 기존 약속(appointment_id)이 있으면 DB 값 (D41: 이 함수는 일정 제목 · 시각 · 장소를 고치지 않음)
//   · 출발지 · 이동 수단 · 여유는 요청 → 내 참여 조건(저장된 값) → 프로필 기본값(집 · 기본 이동 수단 · 기본 여유) 순
//   · 직접 고른 알람 시각 · 강도: 요청에 칸이 있으면 그 칸이 전부(없는 종류 · null = 자동), 칸이 없으면 저장된 직접 값(MANUAL)을 그대로
//   · 만들 알람 종류(kinds): 요청에 있으면 그것, 없으면 지금 있는 종류 그대로(없으면 계산된 전부) — 부분 알람 일정을 다시 저장해도 안 늘어남
import {
  DEFAULT_BEFORE_PREPARE_MINUTES,
  DEFAULT_COMMON_P80,
  PREPARE_RECORD_MAX,
  PREPARE_RECORD_MIN,
  alarmChain,
  autoLevel,
  checkAlarms,
  departureAt,
  levelOfIntensity,
  levelOfSoundKey,
  levelOfVoiceTone,
  predictPrepare,
  resolveIntensity,
  RING_KINDS,
  type AlarmIntensity,
  type ChainAlarm,
  type CheckResult,
  type Importance,
  type IntensityAxis,
  type IntensityOverrides,
  type Level,
  type PrepareBasis,
  type ResolvedIntensity,
  type RingKind,
  type SameDayWake,
  type Transport,
} from './calc/index.ts';
import { resolveEnabled } from './commit-core.ts';
import type { AlarmFields, ParticipantFields, PlaceInput } from './draft.ts';
import type { ResolvedTravel, Warning } from './route.ts';

// ---- DB에서 읽은 행 (필요한 칸만) ----

export type ProfileRow = {
  timezone: string;
  default_buffer_minutes: number;
  default_transport: Transport;
  home_name: string | null;
  home_lat: number | null;
  home_lng: number | null;
  default_prepare_minutes?: number | null; // 온보딩에서 답한 "일어나서 나가기까지" — 기상~출발 첫 값 (학습 루프 기초 1절 ①). 없으면 null
};

export type AppointmentRow = {
  appointment_id: string;
  creator_id: string;
  group_id: string | null;
  title: string;
  appointment_at: string;
  dest_name: string;
  dest_lat: number | null;
  dest_lng: number | null;
  importance: Importance;
  recurrence_rule: string | null;
};

export type ParticipantRow = {
  participant_id: string;
  appointment_id: string;
  user_id: string;
  origin_name: string | null;
  origin_lat: number | null;
  origin_lng: number | null;
  transport_type: Transport;
  est_travel_minutes: number | null;
  travel_source: 'API' | 'CACHED' | 'MANUAL';
  prepare_minutes: number;
  buffer_minutes: number;
};

export type AlarmRow = {
  alarm_id: string;
  participant_id: string | null;
  user_id: string;
  alarm_type: 'WAKE' | 'PREPARE' | 'DEPARTURE' | 'ARRIVE' | 'ROUTINE';
  scheduled_at: string;
  intensity: AlarmIntensity;
  voice_tone: 'CALM' | 'NEUTRAL' | 'DIRECT';
  sound_key: string | null;
  is_enabled: boolean;
  snooze_limit: number;
  time_source: 'AUTO' | 'MANUAL';
  intensity_source: 'AUTO' | 'MANUAL';
  recurrence_rule: string | null;
};

export type PlanDraft = ParticipantFields &
  AlarmFields & {
    appointmentId?: string;
    at?: Date; // 새 약속의 시각 (기존 약속이면 DB 값)
    destination?: PlaceInput; // 새 약속의 장소
    importance?: Importance;
    travelMinutes?: number; // 정해진 이동시간 — 직접 입력하거나 앱이 확인 시트에서 보여 준 값
    travelSource?: 'API' | 'MANUAL';
    prepareMinutes?: number; // 정해진 준비 시간(기상 ~ 출발)
  };

export type PlanInputs = {
  now: Date;
  draft: PlanDraft;
  profile: ProfileRow;
  appointment?: AppointmentRow;
  participant?: ParticipantRow;
  existingAlarms: AlarmRow[];
  stats: { sampleCount: number; p80: number | null }; // 내 기상~출발 기록 최근 30건 중 10~300분 (plan.ts loadPrepareStats, 이미 기상~출발이라 준비 전 활동을 더하지 않음)
  lateCount4w: number;
  sameDayWake: boolean;
  // 반복 다음 회차용 — 자동 준비시간이 이 값에서 `within`분 넘게 벗어나면 그 범위로 (D62 처음 2주 몫). 직접 고른 준비시간(draft.prepareMinutes)은 건드리지 않음
  prepareBound?: { around: number; within: number };
};

// 기상~출발 첫 값 — 온보딩 값이 있으면 그것, 없으면(null · 프로필 없음 · 범위 밖) 목업의 50
//   L6 안건후보: 첫 값 범위 기본안 = 기록 범위와 같은 10~300분만 믿음 (DB 제약은 0~600, 온보딩 화면은 10~180)
export function firstPrepareMinutes(profile: Pick<ProfileRow, 'default_prepare_minutes'>): number {
  const v = profile.default_prepare_minutes;
  return v != null && Number.isFinite(Number(v)) && Number(v) >= PREPARE_RECORD_MIN && Number(v) <= PREPARE_RECORD_MAX ? Math.round(Number(v)) : DEFAULT_COMMON_P80.withWake;
}

// 자동 준비시간을 기준 값 ±within분 안으로 — 직접 고른 값(MANUAL)은 그대로. 설명용 칸(개인 보정)은 합이 맞게 같이 바꿈
export function clampPrepareToBound(prepare: PrepareBasis, bound: { around: number; within: number }): PrepareBasis {
  if (prepare.source === 'MANUAL') return prepare;
  const auto = Math.min(Math.max(prepare.autoMinutes, bound.around - bound.within), bound.around + bound.within);
  if (auto === prepare.autoMinutes) return prepare;
  return { ...prepare, autoMinutes: auto, minutes: auto, correction: auto - prepare.commonP80 };
}

const num = (v: number | string | null | undefined): number | undefined => (v == null ? undefined : Number(v));

// ---- 그날 첫 일정 판정에 쓰는 행 ----

// 내 참여 한 줄 = 약속 시각 + 그 참여의 기상 알람 (PostgREST 임베드: appointments!inner · alarms!inner). 일대다 · 다대일 임베드는 객체 또는 배열로 옴
export type SameDayWakeRow = {
  appointment_id: string;
  appointments: { appointment_at: string } | { appointment_at: string }[] | null;
  alarms: { is_enabled: boolean } | { is_enabled: boolean }[] | null;
};

const asList = <T>(v: T | T[] | null | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v]);

// 판정 함수(calc/wake.ts hasEarlierWake)에 넘길 모양으로. 약속 시각을 못 읽는 행은 건너뜀
export function sameDayWakesFromRows(rows: readonly SameDayWakeRow[]): SameDayWake[] {
  const out: SameDayWake[] = [];
  for (const r of rows) {
    const at = asList(r.appointments)[0]?.appointment_at;
    const appointmentAt = at ? new Date(at) : undefined;
    if (!appointmentAt || Number.isNaN(appointmentAt.getTime())) continue;
    for (const a of asList(r.alarms)) out.push({ appointmentId: r.appointment_id, appointmentAt, isEnabled: a.is_enabled });
  }
  return out;
}

// ---- 기본 값 합치기 ----

export type Basics = {
  at: Date;
  destination: { name: string; lat?: number; lng?: number };
  origin: { name: string; lat?: number; lng?: number };
  transport: Transport;
  bufferMinutes: number;
  importance: Importance;
};

export function resolveBasics(i: Pick<PlanInputs, 'draft' | 'profile' | 'appointment' | 'participant'>): Basics {
  const { draft, profile, appointment, participant } = i;
  const at = appointment ? new Date(appointment.appointment_at) : draft.at;
  const destName = appointment ? appointment.dest_name : draft.destination?.name;
  if (!at || !destName) throw new Error('appointment_at · destination.name은 요청을 읽을 때 걸러져야 해요');
  const destLat = appointment ? num(appointment.dest_lat) : draft.destination?.lat;
  const destLng = appointment ? num(appointment.dest_lng) : draft.destination?.lng;

  const homeCandidate = { name: profile.home_name ?? '집', lat: num(profile.home_lat), lng: num(profile.home_lng), home: true };
  const storedCandidate =
    participant && (participant.origin_name || participant.origin_lat != null)
      ? { name: participant.origin_name ?? '', lat: num(participant.origin_lat), lng: num(participant.origin_lng), home: false }
      : undefined;
  // 요청에 출발지 이름만 있고 좌표가 없으면 (목업의 '집' 같은 글자), 이름이 같은 저장된 출발지 · 집의 좌표를 씀
  const origin = (() => {
    const asked = draft.origin;
    if (!asked) return storedCandidate ?? homeCandidate;
    if (asked.lat != null && asked.lng != null) return asked;
    const same = [storedCandidate, homeCandidate].find((c) => c && c.lat != null && (c.name === asked.name || (c.home && asked.name === '집')));
    return same ? { name: asked.name, lat: same.lat, lng: same.lng } : asked;
  })();

  return {
    at,
    destination: { name: destName, ...(destLat != null && destLng != null ? { lat: destLat, lng: destLng } : {}) },
    origin: { name: origin.name || '집', ...(origin.lat != null && origin.lng != null ? { lat: origin.lat, lng: origin.lng } : {}) },
    transport: draft.transport ?? participant?.transport_type ?? profile.default_transport,
    bufferMinutes: draft.bufferMinutes ?? participant?.buffer_minutes ?? profile.default_buffer_minutes,
    importance: appointment?.importance ?? draft.importance ?? 'NORMAL',
  };
}

// ---- 지금 있는 알람에서 읽는 값 ----

const ringRows = (rows: readonly AlarmRow[]) => rows.filter((a): a is AlarmRow & { alarm_type: RingKind } => (RING_KINDS as readonly string[]).includes(a.alarm_type));

export function resolveKinds(draftKinds: RingKind[] | undefined, existing: readonly AlarmRow[]): RingKind[] | undefined {
  if (draftKinds) return draftKinds;
  const kinds = ringRows(existing).map((a) => a.alarm_type);
  return kinds.length ? kinds : undefined;
}

export function resolveManualTimes(draft: PlanDraft['manualTimes'], existing: readonly AlarmRow[]): Partial<Record<RingKind, Date>> {
  const out: Partial<Record<RingKind, Date>> = {};
  if (draft) {
    for (const kind of RING_KINDS) {
      const picked = draft[kind];
      if (picked) out[kind] = picked;
    }
    return out;
  }
  for (const a of ringRows(existing)) if (a.time_source === 'MANUAL') out[a.alarm_type] = new Date(a.scheduled_at);
  return out;
}

export function resolveOverrides(draft: PlanDraft['levels'], existing: readonly AlarmRow[], auto: Level): IntensityOverrides {
  if (draft) return draft;
  const stored = existing.find((a) => a.alarm_type === 'WAKE' && a.intensity_source === 'MANUAL') ?? existing.find((a) => a.intensity_source === 'MANUAL');
  if (!stored) return {};
  // 저장돼 있는 값이 자동 값과 같으면 직접 고른 칸으로 보지 않음 (자동 값이 바뀌면 같이 바뀌도록)
  const pick = (level: Level | null) => (level != null && level !== auto ? level : null);
  return {
    sound: pick(levelOfSoundKey(stored.sound_key)),
    voice: pick(levelOfVoiceTone(stored.voice_tone)),
    vibration: pick(levelOfIntensity(stored.intensity)),
  };
}

// 준비 알람이 자동으로 잡힌 약속이면 준비 − 기상 간격을 "준비 전 활동"으로 읽음 (서버가 다시 계산해도 30분 같은 값이 안 바뀌게)
//   기상을 직접 옮겼어도 자동 준비 알람은 (옮긴) 기상 + 준비 전 활동이라 간격은 그대로 준비 전 활동 (calc/chain.ts) — 기상이 MANUAL인 건 따지지 않음
//   준비를 직접 옮겼으면 간격이 준비 전 활동이 아니므로 읽지 않음
export function inferBeforePrepare(existing: readonly AlarmRow[]): number | undefined {
  const wake = existing.find((a) => a.alarm_type === 'WAKE');
  const prepare = existing.find((a) => a.alarm_type === 'PREPARE');
  if (!wake || !prepare || prepare.time_source === 'MANUAL') return undefined;
  const minutes = Math.round((Date.parse(prepare.scheduled_at) - Date.parse(wake.scheduled_at)) / 60_000);
  return minutes > 0 && minutes <= 240 ? minutes : undefined;
}

// ---- 계획 ----

export type Plan = {
  basics: Basics;
  withWake: boolean;
  sameDayWake: boolean;
  beforePrepareMinutes: number;
  travel: ResolvedTravel;
  travelMinutes: number;
  prepare: PrepareBasis;
  intensity: ResolvedIntensity;
  kinds: RingKind[] | undefined; // 만든 종류 (undefined = 계산된 전부)
  manualTimes: Partial<Record<RingKind, Date>>;
  fullChain: ChainAlarm[]; // 종류를 거르기 전 (미리 보기 · 단축 준비 안내용)
  chain: ChainAlarm[]; // 만들 알람
  departure: Date;
  check: CheckResult;
  warnings: Warning[];
};

// 어느 쪽에서 부르는지 — preview = alarm-suggest(저장하지 않음), save = alarm-commit(저장). 계산은 같고 경고 문구만 다름
export type PlanMode = 'preview' | 'save';

const PAST_ALARM_MESSAGE: Record<PlanMode, string> = {
  preview: '이미 지난 알림은 저장할 때 꺼져요',
  save: '이미 지난 알림은 끄고 저장했어요',
};

// travel.chosen이 있는 경우만 부름 (없으면 부르는 쪽이 ROUTE_UNAVAILABLE)
export function computePlan(i: PlanInputs, travel: ResolvedTravel, mode: PlanMode = 'save'): Plan {
  const basics = resolveBasics(i);
  const chosen = travel.chosen;
  if (!chosen) throw new Error('이동시간 없이 계획을 만들 수 없어요');

  const withWake = i.draft.withWake ?? !i.sameDayWake;
  const beforePrepareMinutes = i.draft.beforePrepareMinutes ?? (withWake ? inferBeforePrepare(i.existingAlarms) ?? DEFAULT_BEFORE_PREPARE_MINUTES : 0);

  // 기록(stats.p80)은 이미 "기상 ~ 출발"이라 그대로 씀 — 예전에는 준비 전 활동 20분을 또 더해서 기록이 쌓일수록 알람이 일찍 당겨졌음 (학습 루프 기초 2절 1)
  // 개인 보정은 그날 첫 일정(기상 알람 있음)에만 — 두 번째 일정(기상 없음, 공통 15분)에 기상~출발 기록을 붙이면 준비가 부풀어서 15분 그대로 (2절 2, 기록 수와 상관없음)
  //   두 번째 일정은 기록 수도 0으로 넘김 → 출처 DEFAULT · 보정 0. 화면 문구는 sameDayWake일 때 기록 줄을 안 보임
  // 첫 값(공통)은 온보딩 "일어나서 나가기까지" (2절 3). 반복 다음 회차는 prepareBound로 직전 회차 ±10분 안에서만 움직임 (1절 ④)
  const predicted = predictPrepare({
    commonP80: withWake ? firstPrepareMinutes(i.profile) : DEFAULT_COMMON_P80.sameDay,
    personalP80: withWake ? i.stats.p80 : null,
    sampleCount: withWake ? i.stats.sampleCount : 0,
    override: i.draft.prepareMinutes,
  });
  const prepare = i.prepareBound && withWake ? clampPrepareToBound(predicted, i.prepareBound) : predicted;

  // 잠귀(profiles.wake_sensitivity) 칸은 아직 DB에 없어 안 넘김(NORMAL 취급) — L7 PR 3이 칸을 만들면 loadProfile에서 읽어 여기 · map.ts toIntensity · realWrite setIntensity에 같이 넘김
  const auto = autoLevel(basics.importance, i.lateCount4w);
  const intensity = resolveIntensity(basics.importance, i.lateCount4w, resolveOverrides(i.draft.levels, i.existingAlarms, auto));

  const kinds = resolveKinds(i.draft.kinds, i.existingAlarms);
  const manualTimes = resolveManualTimes(i.draft.manualTimes, i.existingAlarms);
  const input = {
    at: basics.at,
    travelMinutes: chosen.minutes,
    bufferMinutes: basics.bufferMinutes,
    prepareMinutes: prepare.minutes,
    beforePrepareMinutes,
    withWake,
    manualTimes,
  };
  const fullChain = alarmChain(input);
  const chain = alarmChain({ ...input, kinds });
  const departure = departureAt(input);
  const check = checkAlarms(chain, departure, i.now);

  const warnings = [...travel.warnings];
  if (check.ok) {
    for (const a of check.alarms) {
      if (a.disabledReason === 'PASSED') {
        warnings.push({ code: 'PAST_ALARM_DISABLED', message: PAST_ALARM_MESSAGE[mode], detail: a.kind });
      }
    }
  }

  return {
    basics,
    withWake,
    sameDayWake: i.sameDayWake,
    beforePrepareMinutes,
    travel,
    travelMinutes: chosen.minutes,
    prepare,
    intensity,
    kinds,
    manualTimes,
    fullChain,
    chain,
    departure,
    check,
    warnings,
  };
}

// ---- 응답 모양 (alarm-suggest, 5.4.1 AlarmSuggestionDTO) ----

const iso = (d: Date | undefined | null) => (d ? d.toISOString() : null);
const KIND_AT = (chain: readonly ChainAlarm[], kind: ChainAlarm['kind']) => chain.find((x) => x.kind === kind)?.at;
const LEVEL_NAME = ['약', '중', '강'] as const;
const IMPORTANCE_NAME: Record<Importance, string> = { LOW: '보통', NORMAL: '중요', HIGH: '매우 중요' };

// 이동시간을 구할 길이 없을 때의 미리 보기 — 오류 대신 "이동시간만 직접 입력해 주세요"를 알리는 200 응답 (7.1.2 마지막 단계)
//   이동시간에 안 걸리는 칸(준비 · 강도 · 그날 첫 일정 여부)은 그대로 채우고, 이동시간이 있어야 나오는 시각은 비움
//   check.reason = TRAVEL_REQUIRED. 앱은 travel.manual_required가 true면 입력 칸을 보이고 participant.est_travel_minutes(MANUAL)로 다시 부름
export function toTravelRequiredSuggestion(i: PlanInputs, travel: ResolvedTravel) {
  // 이동시간 없이는 시각을 못 구하므로 자리표시 값(0분)으로 계산해서 준비 · 강도 칸만 가져옴 — 시각 · 경고는 아래에서 비움
  const placeholder = computePlan(i, { chosen: { minutes: 0, source: 'MANUAL', needsConfirmation: true, note: '' }, auto: null, warnings: [] }, 'preview');
  return {
    ...toSuggestion(placeholder),
    wake_at: null,
    prepare_at: null,
    departure_at: null,
    arrive_at: null,
    alarms: [],
    check: { ok: false, reason: 'TRAVEL_REQUIRED', message: '이동시간을 구하지 못했어요. 직접 입력해 주세요' },
    travel: {
      minutes: null,
      source: null,
      manual_required: true,
      needs_confirmation: true,
      sample_count: null,
      note: '이동시간을 구하지 못했어요. 직접 입력해 주세요',
      auto_minutes: null,
      auto_source: null,
      corrected_by: null,
    },
    warnings: travel.warnings,
  };
}

// 기본 강도는 보통(D69) — 매우 중요 · 늦잠 지각 · 잠귀가 있을 때만 "올림"이 문구에 붙음. 중요도 낮음이어도 약이라고 쓰지 않음
export function intensityReason(basics: Pick<Basics, 'importance'>, it: ResolvedIntensity): string {
  const upText = it.importancePoint ? ' (한 단계 올림)' : '';
  const lateText = it.latePoint ? ` + 최근 4주 늦잠 지각 ${it.lateCount}회` : '';
  const heavyText = it.heavySleeper ? ' + 잠귀가 무거움' : '';
  const base = `${IMPORTANCE_NAME[basics.importance]} 일정${upText}${lateText}${heavyText} → ${LEVEL_NAME[it.auto]}`;
  return it.manual ? `${base} (직접 고른 칸이 있어요)` : base;
}

// inputs를 주면 켜짐 여부도 저장과 같은 규칙으로 보여 줌 (요청의 enabled · 사용자가 끈 알람) — 안 주면 지난 알림 검사 결과만
export function toSuggestion(plan: Plan, inputs?: Pick<PlanInputs, 'existingAlarms' | 'draft' | 'now'>) {
  const { basics, travel, prepare, intensity } = plan;
  const checked = plan.check.ok ? plan.check.alarms : null;
  const rows = (checked ?? plan.chain.map((a) => ({ ...a, enabled: true, disabledReason: undefined }))).map((a) => ({
    ...a,
    enabled: inputs
      ? resolveEnabled({
          checkedEnabled: a.enabled,
          old: inputs.existingAlarms.find((x) => x.alarm_type === a.kind),
          requested: a.kind === 'ARRIVE' ? undefined : inputs.draft.enabled?.[a.kind],
          now: inputs.now,
        })
      : a.enabled,
  }));
  return {
    appointment_at: iso(basics.at),
    wake_at: iso(KIND_AT(plan.fullChain, 'WAKE')),
    prepare_at: iso(KIND_AT(plan.fullChain, 'PREPARE')),
    departure_at: iso(plan.departure),
    arrive_at: iso(KIND_AT(plan.fullChain, 'ARRIVE')),
    // 만들 알람(고른 종류) — 지난 알림은 is_enabled false로 (8.2.1). 저장은 이 목록과 같게 됨
    alarms: rows.map((a) => ({
      alarm_type: a.kind,
      scheduled_at: iso(a.at),
      auto_scheduled_at: iso(a.auto),
      time_source: a.auto ? 'MANUAL' : 'AUTO',
      is_enabled: a.enabled,
      disabled_reason: a.disabledReason ?? null,
    })),
    check: plan.check.ok
      ? { ok: true }
      : { ok: false, reason: plan.check.reason, message: plan.check.message }, // 저장하면 UNPROCESSABLE이 될 입력 (미리 보기는 막지 않고 알려 줌)
    travel: {
      minutes: plan.travelMinutes,
      source: travel.chosen?.source,
      manual_required: false,
      needs_confirmation: travel.chosen?.needsConfirmation ?? false,
      sample_count: travel.chosen?.sampleCount ?? null,
      note: travel.chosen?.note ?? null,
      auto_minutes: travel.auto?.minutes ?? null,
      auto_source: travel.auto?.source ?? null,
      corrected_by: null, // 7.3.1 개인 이동 보정은 아직 없음
    },
    prepare: {
      minutes: prepare.minutes,
      auto_minutes: prepare.autoMinutes,
      source: prepare.source,
      common_p80: prepare.commonP80,
      correction: prepare.correction,
      sample_count: prepare.sampleCount,
      prior: prepare.prior,
      weight: prepare.weight,
      residual_p80: prepare.residualP80,
      before_prepare_minutes: plan.beforePrepareMinutes,
    },
    intensity: {
      level: intensity.fields.intensity,
      voice_tone: intensity.fields.voiceTone,
      sound_key: intensity.fields.soundKey,
      source: intensity.manual ? 'MANUAL' : 'AUTO',
      reason: intensityReason(basics, intensity),
      auto_level: intensity.auto,
      importance_point: intensity.importancePoint,
      late_count: intensity.lateCount,
      late_point: intensity.latePoint,
      axes: Object.fromEntries((['sound', 'voice', 'vibration'] as IntensityAxis[]).map((a) => [a, intensity.axes[a]])),
    },
    with_wake: plan.withWake,
    same_day_wake: plan.sameDayWake,
    confidence: prepare.confidence,
    warnings: plan.warnings,
  };
}
