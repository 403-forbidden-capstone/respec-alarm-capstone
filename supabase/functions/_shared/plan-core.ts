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
  AXES_PICKER_ENABLED,
  alarmChain,
  autoLevel,
  checkAlarms,
  departureAt,
  isEveningWake,
  levelOfVibration,
  levelOfSoundKey,
  levelOfVoiceTone,
  personalPrepareOf,
  predictPrepare,
  recentPrepareOf,
  resolveIntensity,
  RING_KINDS,
  type AlarmIntensity,
  type AlarmVibration,
  type ChainAlarm,
  type CheckResult,
  type Importance,
  type IntensityAxis,
  type IntensityOverrides,
  type Level,
  type PrepareBasis,
  type PurePrepCandidate,
  type PrepareStats,
  type ResolvedIntensity,
  type RingKind,
  type SameDayWake,
  type Transport,
  wakeMarginOf,
  wakeSensitivityOf,
} from './calc/index.ts';
import { resolveEnabled } from './commit-core.ts';
import { safeTimeZone } from './tz.ts';
import type { AlarmFields, ParticipantFields, PlaceInput } from './draft.ts';
import type { ResolvedTravel, Warning } from './route.ts';
import type { MlPrediction } from './prepare-ml.ts';

// ---- DB에서 읽은 행 (필요한 칸만) ----

export type ProfileRow = {
  timezone: string;
  default_buffer_minutes: number;
  default_transport: Transport;
  home_name: string | null;
  home_lat: number | null;
  home_lng: number | null;
  default_prepare_minutes?: number | null; // 온보딩에서 답한 "일어나서 나가기까지" — 기상~출발 첫 값 (학습 루프 기초 1절 ①). 없으면 null
  default_outing_prep_minutes?: number | null; // explicitly supplied pure prepare-start -> departure
  default_outing_prep_updated_at?: string | null; // server-owned timestamp of latest pure preference edit
  ml_profile_consented_at?: string | null; // consent for behavioral personalization/history use
  wake_sensitivity?: string | null; // 온보딩 잠귀 'LIGHT' | 'NORMAL' | 'HEAVY' (D69) — 무거움이면 강도 자동 값이 강. 없으면 보통
  preferred_voice_tone?: string | null; // 설정에서 고른 기본 말소리 CALM · NEUTRAL · DIRECT — 비면 자동(강도 단계). 일정에서 직접 고른 말소리가 이김
  wake_margin?: string | null; // 온보딩 깨우는 여유 'TIGHT' | 'NORMAL' | 'LOOSE' (D63) — 기록의 0.7 · 0.8 · 0.9 분위수. 없으면 보통
};

export type AppointmentRow = {
  appointment_id: string;
  creator_id: string | null; // 공동 약속은 만든 사람이 탈퇴하면 비어 있을 수 있음 (친구 9장)
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
  prepare_value_source?: 'LEGACY' | 'AUTO' | 'MANUAL';
  buffer_minutes: number;
  prepare_advance_minutes?: number | null; // 받아들인 준비 알람 당김 분 (#484 · 안건 D111) — 계산이 준비 알람을 그만큼 앞당김. 없으면 0
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
  vibration: AlarmVibration | null; // 진동 축을 직접 고른 값. NULL = 강도(intensity)를 따름
  is_enabled: boolean;
  snooze_limit: number;
  time_source: 'AUTO' | 'MANUAL';
  intensity_source: 'AUTO' | 'MANUAL';
  recurrence_rule: string | null;
  original_scheduled_at?: string | null; // 친구 제안을 적용한 알람이면 처음 시각 (친구 10장 — 주인이 직접 고치거나 새로 계산하면 비워짐)
  original_time_source?: 'AUTO' | 'MANUAL' | null; // 그때의 time_source (원래대로 돌아오면 복원)
};

// 친구가 제안해 주인이 적용한 알람(original_scheduled_at 있음)을 친구가 바꾸기 전 모습(시각 · time_source)으로 되돌린 목록.
//   약속의 시각 · 장소가 바뀌거나 반복 새 회차를 만들 때 새 계산 · 직접 고른 값 옮기기의 입력으로 씀 — D67: 친구 값은 새 계산이 이기고
//   (그 알람은 원래 자동이었으면 자동으로 계산되고), 주인이 직접 고른 값이었으면 그 값을 이어받음. DB에 쓰는 비교(diffAlarms)에는 실제 행을 그대로 넘김
export function withoutFriendTimes(alarms: readonly AlarmRow[]): AlarmRow[] {
  return alarms.map((a) =>
    a.original_scheduled_at == null
      ? a
      : { ...a, scheduled_at: a.original_scheduled_at, time_source: a.original_time_source ?? 'AUTO', original_scheduled_at: null, original_time_source: null },
  );
}

export type PlanDraft = ParticipantFields &
  AlarmFields & {
    appointmentId?: string;
    groupId?: string; // new shared appointment; pure-prep pilot excludes group until shared edit parity verified
    at?: Date; // 새 약속의 시각 (기존 약속이면 DB 값)
    destination?: PlaceInput; // 새 약속의 장소
    importance?: Importance;
    travelMinutes?: number; // 정해진 이동시간 — 직접 입력하거나 앱이 확인 시트에서 보여 준 값
    travelSource?: 'API' | 'MANUAL';
    prepareMinutes?: number; // EXPLICIT legacy manual override (wake -> departure)
    autoPrepareSnapshotMinutes?: number; // auto preview value; compare at commit, NEVER feed back as manual override
    prepareValueSource?: 'AUTO' | 'MANUAL'; // optional explicit provenance; absent means legacy unknown
  };

export type PlanInputs = {
  now: Date;
  draft: PlanDraft;
  profile: ProfileRow;
  appointment?: AppointmentRow;
  participant?: ParticipantRow;
  existingAlarms: AlarmRow[];
  stats: PrepareStats; // 내 기상~출발 기록 최근 30건 중 10~240분 (plan.ts loadPrepareStats, 이미 기상~출발이라 준비 전 활동을 더하지 않음). values가 있어야 깨우는 여유(0.7 · 0.9)를 반영
  lateCount4w: number;
  sameDayWake: boolean;
  mlPrediction?: MlPrediction; // 검증된 프로필일 때만 Edge가 조회. 없으면 기존 P80 계산 유지
  purePrepCandidate?: PurePrepCandidate; // opt-in only; pure prep start -> departure, NEVER wake -> departure
  // 반복 다음 회차용 — 자동 준비시간이 이 값에서 `within`분 넘게 벗어나면 그 범위로 (D62 처음 2주 몫). 직접 고른 준비시간(draft.prepareMinutes)은 건드리지 않음
  prepareBound?: { around: number; within: number };
  // 저장된 알람(existingAlarms)을 계산할 때의 당김 분 — 준비 전 활동을 되찾을 때 씀. 당김을 바꾸며 다시 계산할 때(제안 적용, 다음 PR)만 옛 값을 넘김. 없으면 participant의 지금 값
  existingAdvanceMinutes?: number;
};

// 기상~출발 첫 값 — 온보딩 값이 있으면 그것, 없으면(null · 프로필 없음 · 범위 밖) 목업의 50
//   L6 안건후보: 첫 값 범위 기본안 = 5~300분만 믿음 (온보딩 · 설정 입력 화면 범위와 같음. 기록 범위 10~240(D107 기본안 A)과는 따로 — 첫 값은 사용자가 직접 답한 값이라 짧게 답한 것도 인정. DB 제약은 0~600)
const FIRST_PREPARE_MIN = 5;
const FIRST_PREPARE_MAX = 300;
export function firstPrepareMinutes(profile: Pick<ProfileRow, 'default_prepare_minutes'>): number {
  const v = profile.default_prepare_minutes;
  return v != null && Number.isFinite(Number(v)) && Number(v) >= FIRST_PREPARE_MIN && Number(v) <= FIRST_PREPARE_MAX ? Math.round(Number(v)) : DEFAULT_COMMON_P80.withWake;
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
    importance: appointment?.importance ?? draft.importance ?? 'LOW', // 새 일정 기본은 약(LOW) — 요청에 없으면 requests.ts가 제목으로 자동
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

// voiceAuto = 말소리를 직접 안 골랐을 때 값 (설정의 기본 말소리, 없으면 auto)
export function resolveOverrides(draft: PlanDraft['levels'], existing: readonly AlarmRow[], auto: Level, axesEnabled: boolean = AXES_PICKER_ENABLED, voiceAuto: Level = auto): IntensityOverrides {
  if (!axesEnabled) return {}; // 축별 선택을 끄면 요청 · 저장된 축 값 모두 계산에서 무시(값은 지우지 않음) — calc/intensity.ts
  if (draft) return draft;
  const stored = existing.find((a) => a.alarm_type === 'WAKE' && a.intensity_source === 'MANUAL') ?? existing.find((a) => a.intensity_source === 'MANUAL');
  if (!stored) return {};
  // 저장돼 있는 값이 자동 값과 같으면 직접 고른 칸으로 보지 않음 (자동 값이 바뀌면 같이 바뀌도록)
  const pick = (level: Level | null, base: Level = auto) => (level != null && level !== base ? level : null);
  return {
    sound: pick(levelOfSoundKey(stored.sound_key)),
    voice: pick(levelOfVoiceTone(stored.voice_tone), voiceAuto),
    vibration: pick(levelOfVibration(stored.vibration)),
  };
}

// 준비 알람이 자동으로 잡힌 약속이면 준비 − 기상 간격을 "준비 전 활동"으로 읽음 (서버가 다시 계산해도 30분 같은 값이 안 바뀌게)
//   기상을 직접 옮겼어도 자동 준비 알람은 (옮긴) 기상 + 준비 전 활동이라 간격은 그대로 준비 전 활동 (calc/chain.ts) — 기상이 MANUAL인 건 따지지 않음
//   준비를 직접 옮겼으면 간격이 준비 전 활동이 아니므로 읽지 않음
// 저장된 알람에서 준비 전 활동을 되찾음 (따로 저장하지 않음). advance · prepareMinutes = 그 알람을 계산할 때의 당김 분 · 준비 시간(참여 조건 칸)
//   당김이 없으면 간격(준비 알람 − 기상) 그대로
//   당김이 있으면(안건 D111 · B안 — 준비 전 활동을 저장하지 않고 되찾음) 간격 = 준비 전 활동 − min(당김, 준비 전 활동)
//     간격 > 0: 당김이 준비 전 활동보다 작았음 → 간격 + 당김
//     간격 = 0: 당김이 준비 전 활동을 다 쓰고 기상도 (당김 − 준비 전 활동)만큼 당겨짐 → 기상이 자동값(출발 − 준비 시간)에서 당겨진 분을 빼서 되찾음
//       출발 알람이 없거나 기상 · 출발을 직접 골랐으면 당겨진 분을 알 수 없어 간격 + 당김 (몇 분 틀어질 수 있음 — PR 한계)
export function inferBeforePrepare(existing: readonly AlarmRow[], advance = 0, prepareMinutes?: number | null): number | undefined {
  const wake = existing.find((a) => a.alarm_type === 'WAKE');
  const prepare = existing.find((a) => a.alarm_type === 'PREPARE');
  if (!wake || !prepare || prepare.time_source === 'MANUAL') return undefined;
  const gap = Math.round((Date.parse(prepare.scheduled_at) - Date.parse(wake.scheduled_at)) / 60_000);
  if (!(advance > 0)) return gap > 0 && gap <= 240 ? gap : undefined;
  let wakeShift = 0;
  const depart = existing.find((a) => a.alarm_type === 'DEPARTURE');
  if (gap === 0 && depart && depart.time_source !== 'MANUAL' && wake.time_source !== 'MANUAL' && prepareMinutes != null) {
    wakeShift = Math.max(0, Math.round((Date.parse(depart.scheduled_at) - Number(prepareMinutes) * 60_000 - Date.parse(wake.scheduled_at)) / 60_000));
  }
  const base = gap + advance - wakeShift;
  return base > 0 && base <= 240 ? base : undefined;
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
  prepareTarget: 'WAKE_TO_DEPART' | 'PREPARE_START_TO_DEPART';
  recentPrepare: number[]; // H03 "최근 5번" — 최신순 최대 5개(분). 그날 두 번째 일정(기록을 안 씀)은 빈 목록
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

  // 받아들인 준비 알람 당김 (#484 · 안건 D111) — 계획의 준비 시간 · 준비 전 활동은 원래 값 그대로 두고 알람 사슬만 당김(calc/chain.ts)
  const advance = Math.max(0, Number(i.participant?.prepare_advance_minutes ?? 0) || 0);
  const existingAdvance = Math.max(0, Number(i.existingAdvanceMinutes ?? advance) || 0);
  const derive = (withWake: boolean) => {
    const beforePrepareMinutes =
      i.draft.beforePrepareMinutes ?? (withWake ? inferBeforePrepare(i.existingAlarms, existingAdvance, i.participant?.prepare_minutes) ?? DEFAULT_BEFORE_PREPARE_MINUTES : 0);

    // 기록(stats.p80)은 이미 "기상 ~ 출발"이라 그대로 씀 — 예전에는 준비 전 활동 20분을 또 더해서 기록이 쌓일수록 알람이 일찍 당겨졌음 (학습 루프 기초 2절 1)
    // 개인 보정은 그날 첫 일정(기상 알람 있음)에만 — 두 번째 일정(기상 없음, 공통 15분)에 기상~출발 기록을 붙이면 준비가 부풀어서 15분 그대로 (2절 2, 기록 수와 상관없음)
    //   두 번째 일정은 기록 수도 0으로 넘김 → 출처 DEFAULT · 보정 0. 화면 문구는 sameDayWake일 때 기록 줄을 안 보임
    // 깨우는 여유(wake_margin)는 내 기록의 0.7 · 0.8 · 0.9 분위수 — 보통이 예전 P80 고정과 같음. 매우 중요 일정은 한 단계 위(빠듯 → 보통 → 넉넉, calc/prepare.ts marginForImportance). 직접 고른 준비 시간이 있으면 그 값이 먼저
    // 첫 값(공통)은 온보딩 "일어나서 나가기까지" (2절 3). 반복 다음 회차는 prepareBound로 직전 회차 ±10분 안에서만 움직임 (1절 ④)
    // Persisted manual legacy time must be an actual calculation override,
    // not merely a gate that blocks the new model. This preserves it in
    // roll/edit/wake-replan where the request draft has no prepare_minutes.
    const storedManual = i.draft.prepareMinutes == null &&
      i.draft.prepareValueSource !== 'AUTO' &&
      i.participant?.prepare_value_source === 'MANUAL'
      ? i.participant.prepare_minutes
      : undefined;
    const fallback = predictPrepare({
      commonP80: withWake ? firstPrepareMinutes(i.profile) : DEFAULT_COMMON_P80.sameDay,
      personalP80: withWake ? personalPrepareOf(i.stats, wakeMarginOf(i.profile.wake_margin), basics.importance) : null,
      sampleCount: withWake ? i.stats.sampleCount : 0,
      override: i.draft.prepareMinutes ?? storedManual,
    });
    // C1/W4가 적용돼도 직접 지정한 준비시간과 그날 두 번째 일정(기상 없음)은 기존 규칙이 우선.
    // 기존 DTO 필드(commonP80/correction)는 화면 호환을 위해 유지. MODEL일 때 correction은
    // 기존 공통 기준 대비 모델값 차이이며 개인 P80 보정으로 해석하면 안 됨.
    const ml = withWake && i.draft.prepareMinutes == null && storedManual == null ? i.mlPrediction : undefined;
    const predicted: PrepareBasis = ml
      ? {
          ...fallback,
          minutes: ml.minutes,
          autoMinutes: ml.minutes,
          correction: ml.minutes - fallback.commonP80,
          residualP80: 0,
          weight: 0,
          source: 'MODEL',
          confidence: 'LOW', // 실제 서비스 대상에서 검증/보정 전: 높은 신뢰도를 주장하지 않음
          mlModel: ml.model,
        }
      : fallback;
    // New pure-preparation data has DIFFERENT units from the existing
    // whole morning window. Convert once, before the shared chain calculator.
    // Never mix with old C1/W4, or an explicit legacy manual override.
    const pure = i.purePrepCandidate;
    const usePure = pure != null && i.draft.prepareMinutes == null && !ml &&
      // Explicit legacy manual duration must survive edit/roll/restore
      // even if these code paths don't submit an override in the draft.
      !(i.participant?.prepare_value_source === 'MANUAL' && i.draft.prepareValueSource !== 'AUTO') &&
      manualTimes.WAKE == null && manualTimes.PREPARE == null;
    const activePure = usePure ? pure : null;
    const minutes = activePure != null
      ? Math.round(activePure.minutes + (withWake ? beforePrepareMinutes : 0))
      : null;
    const pureBasis: PrepareBasis = activePure != null && minutes != null
      ? {
          ...fallback,
          minutes,
          autoMinutes: minutes,
          correction: minutes - fallback.commonP80,
          residualP80: 0,
          weight: 0,
          sampleCount: activePure.sampleCount ?? 0,
          source: activePure.source === 'MANUAL' ? 'MANUAL'
            : activePure.source === 'MODEL' ? 'MODEL'
            : activePure.source === 'HISTORY' ? 'PERSONAL' : 'DEFAULT',
          confidence: 'LOW',
          ...(activePure.source === 'MODEL' && (activePure.model === 'prep_start_ratio_v2' || activePure.model === 'prep_start_ratio_v2_survey_pilot') ? { mlModel: activePure.model } : {}),
        }
      : predicted;
    // prepareBound is inherited from legacy wake->departure participant.prepare_minutes.
    // Applying it to a pure prep candidate would clamp values in incompatible units.
    // New-semantics per-occurrence bounds require their own persisted pure-prep basis.
    const prepare = i.prepareBound && withWake && activePure == null
      ? clampPrepareToBound(pureBasis, i.prepareBound)
      : pureBasis;
    return { beforePrepareMinutes, prepare, pureApplied: activePure != null };
  };

  const manualTimes = resolveManualTimes(i.draft.manualTimes, i.existingAlarms);
  const timeZone = safeTimeZone(i.profile.timezone);
  // 그날 첫 일정이면 기상 알람 — 단 계산된 기상이 그날 낮 12시 이후(저녁에만 일정이 있는 날)면 기상 없이 준비 · 출발(+ 도착)만 (B1 버그 후보 4, 헤드 10/30)
  //   먼저 기상 있는 계산으로 기상 시각을 구해 보고, 12:00 이후면 기상 없는 계산(준비 15분)으로 다시 함. 둘 다 순수 계산
  //   직접 정한 값은 존중: 요청의 with_wake · 직접 고른 기상 시각(manualTimes.WAKE)이 있으면 자동 규칙을 건너뜀
  //   L6 안건후보: 저녁 기상 자동 제외와 직접 지정 우선순위 기본안 = with_wake 직접 지정 · 직접 고른 기상 시각은 존중(12시 이후여도 기상 있음), 그 밖은 자동 규칙.
  //     kinds에 WAKE가 들어 있는 것만으로는 존중하지 않음 — 반복 · 일정 수정이 지금 있는 알람 종류를 kinds로 이어받아서 사용자가 고른 것인지 알 수 없고, kinds는 원래 거르기만 할 뿐 기상을 만들지 못함(그날 두 번째 일정과 같음)
  //   #624: 자동으로는 기상이 없는 일정(그날 앞 일정에 기상 · 12시 이후 기상)에 기상 시각을 직접 고르면(addedWake) 기상은 고른 시각에 따로 울리고,
  //     준비 · 출발은 기상 없는 계산 그대로 — 일정 시각이 바뀌면 준비 · 출발은 다시 계산되고 기상만 고른 시각에 남음 (준비가 기상을 따라 아침으로 끌려가지 않게)
  let withWake = i.draft.withWake ?? !i.sameDayWake;
  let derived = derive(withWake);
  if (i.draft.withWake == null && withWake) {
    const depart = departureAt({ at: basics.at, travelMinutes: chosen.minutes, bufferMinutes: basics.bufferMinutes, prepareMinutes: derived.prepare.minutes, beforePrepareMinutes: derived.beforePrepareMinutes, withWake: true, manualTimes: {} });
    if (isEveningWake(new Date(depart.getTime() - derived.prepare.minutes * 60_000), timeZone, basics.at)) {
      withWake = false;
      derived = derive(false);
    }
  }
  const { beforePrepareMinutes, prepare, pureApplied } = derived;

  // 잠귀(profiles.wake_sensitivity): 무거움(HEAVY)이면 강, 가벼움 · 보통은 기본 보통 (D69). 앱 map.ts toIntensity · realWrite setIntensity도 같은 값을 넘김
  const wakeSensitivity = wakeSensitivityOf(i.profile.wake_sensitivity);
  const auto = autoLevel(basics.importance, i.lateCount4w, wakeSensitivity);
  // 설정의 기본 말소리 — 이 일정에서 말소리를 직접 고르지 않았을 때만 씀 (이미 저장된 다른 일정 알람은 다시 계산할 때까지 그대로)
  const voiceDefault = levelOfVoiceTone(i.profile.preferred_voice_tone);
  const intensity = resolveIntensity(
    basics.importance,
    i.lateCount4w,
    resolveOverrides(i.draft.levels, i.existingAlarms, auto, AXES_PICKER_ENABLED, voiceDefault ?? auto),
    wakeSensitivity,
    voiceDefault,
  );

  // 기상이 없던 일정(지금 종류를 이어받음)에 기상 시각을 직접 고르면 기상 종류를 더함 — 종류는 거르기만 해서 안 더하면 고른 기상이 빠짐 (#624). [](알람 없는 일정)은 그대로
  const resolvedKinds = resolveKinds(i.draft.kinds, i.existingAlarms);
  const pickedWake = i.draft.withWake == null && !withWake && manualTimes.WAKE != null ? manualTimes.WAKE : null;
  const addedWake = pickedWake != null && (resolvedKinds == null || resolvedKinds.length > 0);
  const kinds: RingKind[] | undefined =
    addedWake && resolvedKinds && !resolvedKinds.includes('WAKE') ? ['WAKE', ...resolvedKinds] : resolvedKinds;
  const input = {
    at: basics.at,
    travelMinutes: chosen.minutes,
    bufferMinutes: basics.bufferMinutes,
    prepareMinutes: prepare.minutes,
    beforePrepareMinutes,
    withWake,
    manualTimes,
    // 준비 알람을 직접 고른 일정은 당기지 않음 (그 시각이 먼저, D42 C)
    prepareAdvanceMinutes: manualTimes.PREPARE ? 0 : advance,
  };
  // 따로 울리는 기상 — 늘 직접 고른 값(MANUAL)이라 auto를 둠(자동값 = 기상 없는 계산의 준비 알람 시각, 되돌리면 기상 없이 준비부터)
  const withAdded = (list: ChainAlarm[]): ChainAlarm[] => {
    if (!addedWake || pickedWake == null) return list;
    const first = list.find((x) => x.kind !== 'ARRIVE');
    return [{ kind: 'WAKE', at: pickedWake, auto: first?.auto ?? first?.at ?? pickedWake }, ...list];
  };
  const fullChain = withAdded(alarmChain(input));
  const chain = withAdded(alarmChain({ ...input, kinds }));
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
    prepareTarget: pureApplied ? 'PREPARE_START_TO_DEPART' : 'WAKE_TO_DEPART',
    // Legacy recent statistics are wake->departure, not pure prep; do not display them when using the new basis.
    recentPrepare: withWake && !pureApplied ? recentPrepareOf(i.stats) : [],
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

// Persist the new duration only when the planner actually USED a pure-prep
// candidate. A profile value or survey model should never be stamped onto a
// legacy/malformed alarm plan.
export type PurePrepPersistence = {
  outing_prep_minutes: number | null;
  outing_prep_source: 'PROFILE' | 'HISTORY' | 'MODEL' | 'MANUAL' | null;
  outing_prep_model: string | null;
};
export function purePrepPersistenceOf(
  plan: Plan,
  candidate: PlanInputs['purePrepCandidate'],
): PurePrepPersistence {
  const unavailable: PurePrepPersistence = {
    outing_prep_minutes: null,
    outing_prep_source: null,
    outing_prep_model: null,
  };
  if (plan.prepareTarget !== 'PREPARE_START_TO_DEPART' || !candidate) return unavailable;
  const minutes = plan.prepare.minutes - (plan.withWake ? plan.beforePrepareMinutes : 0);
  if (!Number.isFinite(minutes) || !Number.isInteger(minutes) || minutes < 5 || minutes > 240 ||
      minutes !== Math.round(candidate.minutes)) return unavailable;
  return {
    outing_prep_minutes: minutes,
    outing_prep_source: candidate.source,
    outing_prep_model: candidate.source === 'MODEL' ? candidate.model ?? null : null,
  };
}

// ---- 응답 모양 (alarm-suggest, 5.4.1 AlarmSuggestionDTO) ----

const iso = (d: Date | undefined | null) => (d ? d.toISOString() : null);
const KIND_AT = (chain: readonly ChainAlarm[], kind: ChainAlarm['kind']) => chain.find((x) => x.kind === kind)?.at;
const LEVEL_NAME = ['약', '중', '강'] as const;
const IMPORTANCE_NAME: Record<Importance, string> = { LOW: '평소', NORMAL: '중요', HIGH: '매우 중요' };

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
      // Legacy 'minutes' remains whole wake->departure to avoid breaking
      // mobile clients. New consumers MUST use pure_minutes when target=PURE.
      target: plan.prepareTarget,
      pure_minutes: plan.prepareTarget === 'PREPARE_START_TO_DEPART'
        ? Math.round(prepare.minutes - (plan.withWake ? plan.beforePrepareMinutes : 0)) : null,
      minutes: prepare.minutes,
      auto_minutes: prepare.autoMinutes,
      source: prepare.source,
      ...(prepare.mlModel ? { model: prepare.mlModel } : {}),
      common_p80: prepare.commonP80,
      correction: prepare.correction,
      sample_count: prepare.sampleCount,
      prior: prepare.prior,
      weight: prepare.weight,
      residual_p80: prepare.residualP80,
      before_prepare_minutes: plan.beforePrepareMinutes,
      recent: plan.recentPrepare, // 내 기상~출발 기록 최근 5개, 최신순 (0건이면 빈 배열)
    },
    intensity: {
      level: intensity.fields.intensity,
      voice_tone: intensity.fields.voiceTone,
      sound_key: intensity.fields.soundKey,
      vibration: intensity.fields.vibration, // 직접 고른 진동만 값, 자동이면 null (강도를 따름)
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
