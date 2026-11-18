// 반복 다음 회차 만들기 — alarm-roll의 본문 (상세설계서 5장 5.3 #17 · 7장 7.1.5, 설계 메모 L1_PR3_설계메모.md 2 · 3 · 4절)
//   반복 약속 · 일정 없는 반복 알람은 앞으로 14일치 회차(약속 시각 ∈ (지금, 지금 + 14일))를 회차마다 새 행으로 미리 만들고, 지난 회차 행은 기록으로 남김 (D4 A).
//   루틴은 회차 행을 따로 만들지 않고 같은 알람 행의 시각만 다음 발생으로 옮김.
// 두 길 — 같은 코드를 쓰고 읽는 클라이언트와 한도만 다름 (Deno.serve 없이 모듈로 빼서 가짜 DB로 시험함, roll.test.ts)
//   본인 길(own)  앱이 syncNow · 반복 일정 저장 직후 부름. 읽기는 부른 사람의 RLS 클라이언트, 쓰기는 service_role(alarm-commit과 같음). 길찾기 최대 4회차, 응답에 폰에 걸 꾸러미
//   배치 길(batch) pg_cron이 5분마다. service_role이라 RLS를 안 타므로 모든 읽기 · 쓰기를 사용자(creator_id · user_id)로 직접 좁힘. roll_due_series에서 일이 있는 묶음 50개 · 길찾기 20번 · 40초 안
// 회차 하나를 쓰는 건 DB 함수 roll_insert_occurrence(약속 · 참여 · 알람 · 준비물 한 트랜잭션, 이미 있으면 null) → 같은 요청을 두 번 보내도 같은 결과.
//   일정 없는 알람은 alarms upsert(ignoreDuplicates), 루틴은 update … eq(alarm_id) eq(scheduled_at, 옛 시각)(먼저 옮긴 쪽만)
// 하루 경계는 profiles.timezone(없으면 Asia/Seoul) 0시. 한국 · Android만이라 앱 기기 시간대(R02 계획 줄)와 같다고 봄 (10/29 헤드)
import {
  RING_KINDS,
  addDaysToKey,
  nextOccurrences,
  nextRoutineAt,
  parseRecurrence,
  type LatLng,
  type Occurrence,
  type RingKind,
  type Transport,
} from './calc/index.ts';
import { diffAlarms, resolveEnabled, type AlarmWrite } from './commit-core.ts';
import { dbFail, must } from './db.ts';
import { pickBaseRow, type ExceptionKind } from './edit.ts';
import { HttpError } from './errors.ts';
import { KakaoError } from './kakao.ts';
import {
  ALARM_COLUMNS,
  SERIES_APPOINTMENT_COLUMNS,
  loadAlarms,
  loadLateCount,
  loadParticipant,
  loadPrepareStats,
  loadProfile,
  loadSameDayWake,
  loadSeriesAppointment,
  loadSeriesAppointments,
  loadTravelSamples,
  type SeriesAppointmentRow,
} from './plan.ts';
import { computePlan, resolveBasics, withoutFriendTimes, type AlarmRow, type ParticipantRow, type Plan, type PlanDraft, type PlanInputs, type ProfileRow } from './plan-core.ts';
import type { Reader } from './read.ts';
import { buildRingPackages, subtitleFor, type RingPackage } from './ring-package.ts';
import { resolveAutoTravel, type ResolvedTravel, type TravelChoice } from './route.ts';
import type { Db } from './supabase.ts';
import { localDateKey, localDayRange, localMinuteOfDay, safeTimeZone, zonedTime } from './tz.ts';

// ---------------------------------------------------------------------------
// 한도 · 상수
// ---------------------------------------------------------------------------

export type PendingReason = 'ROUTE_RETRY' | 'DAILY_BUDGET' | 'ALARM_CAP' | 'RUN_LIMIT';

// 길찾기 실패 뒤 다시 해 보는 간격 (실패 1번째 → 1시간 뒤, 2번째 → 3시간, 3번째부터 → 6시간)
export const RETRY_HOURS = [1, 3, 6] as const;
// 첫 알람이 이 시간 안으로 다가왔는데도 길찾기가 안 되면 내 실측 중앙값(CACHED) → 직선 근사(ESTIMATE)로 만듦 (7장 7.1.2 폴백 순서)
export const FALLBACK_BEFORE_FIRST_ALARM_HOURS = 12;
// 사용자 한 명이 하루(내 시간대)에 roll로 쓰는 길찾기 수 — 작성자 판단. 전체 합계 한도는 kakao_calls 로그(L8 하루 집계)로 보고 정함
export const DAILY_LOOKUP_BUDGET = 300;
// 앞으로 켜진 알람이 이만큼이면 더 안 만듦 (폰 예약 앱당 500개 · reconcile 읽기 상한 500줄 아래) — 작성자 판단
export const UPCOMING_ALARM_CAP = 400;

export type RollLimits = {
  lookups: number; // 이번 실행에서 부를 수 있는 길찾기 수
  series: number; // 이번 실행에서 다룰 "일이 있는" 묶음 수 (할 일 없는 묶음은 안 셈)
  fetch: number; // roll_due_series에서 읽어 올 후보 수 (일이 있는 묶음 수보다 넉넉히)
  ms: number | null; // 이 시간이 지나면 남은 회차는 다음 실행으로 (null = 제한 없음)
  dailyLookups: number; // 사용자 한 명의 하루 길찾기 몫 (DAILY_LOOKUP_BUDGET)
  alarmCap: number; // 앞으로 켜진 알람 상한 (UPCOMING_ALARM_CAP)
};

export const ROLL_LIMITS: Record<'own' | 'batch', RollLimits> = {
  own: { lookups: 4, series: Number.POSITIVE_INFINITY, fetch: 0, ms: null, dailyLookups: DAILY_LOOKUP_BUDGET, alarmCap: UPCOMING_ALARM_CAP },
  // 후보를 50개보다 많이 읽는 이유: roll_due_series는 "마지막 회차가 +14일 안"인 묶음을 모두 돌려줘서, 이번에 만들 회차가 없는 주간 묶음도 5분마다 후보에 듦.
  // 그런 빈 묶음이 앞줄을 채워도 일이 있는 묶음이 밀리지 않게 넉넉히 읽고, 빈 묶음은 기준 회차 한 줄만 읽고 넘김 (50 한도에 안 셈)
  batch: { lookups: 20, series: 50, fetch: 200, ms: 40_000, dailyLookups: DAILY_LOOKUP_BUDGET, alarmCap: UPCOMING_ALARM_CAP },
};

export type TravelLookup = (args: { origin: LatLng; destination: LatLng; transport: Transport }) => Promise<{ minutes: number; partial: boolean }>;

export type RollDeps = {
  path: 'own' | 'batch';
  now: Date;
  read: Db; // 읽기 클라이언트 — own: 부른 사람의 RLS, batch: service_role
  write: Db; // service_role (쓰기 · roll_attempts · DB 함수)
  lookup?: TravelLookup; // 카카오 길찾기 1번. 키가 없으면 안 줌 → 길찾기가 늘 안 되는 것으로 침(AUTH와 같음)
  limits?: Partial<RollLimits>;
  clock?: () => number; // 실행 시간 재기 (ms) — 시험이 바꿔 끼움
  log?: (line: string) => void; // 실행마다 한 줄 (JSON) — L8이 하루 집계에 씀
  warn?: (line: string) => void; // 묶음 하나를 건너뛴 일 (JSON, 이유 글자만)
};

export type RollCreated = { series_id: string; occurrence_on: string; appointment_id: string | null; alarm_id?: string };
export type RollPending = { series_id: string; occurrence_on: string; reason: PendingReason };

// 응답 (설계 메모 4절) — 앱 applyCommit이 그대로 받는 alarm-commit 모양을 따름
export type RollResult = {
  created: RollCreated[];
  moved_alarm_ids: string[];
  pending: RollPending[];
  ring_packages: RingPackage[]; // 본인 길만 (이번에 만들거나 옮긴 켜진 알람). 배치 길은 빈 목록
  canceled_alarm_ids: string[]; // PR 3에선 늘 빈 목록 (지우는 일 없음), PR 4가 채움
  kakao_calls: number;
};

export function readRollRequest(r: Reader): { seriesId?: string } {
  const seriesId = r.uuid('series_id');
  return seriesId ? { seriesId } : {};
}

// ---------------------------------------------------------------------------
// 순수 계산
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// 길찾기가 실패한 횟수 → 다음 시도 시각
export function retryAt(now: Date, failures: number): Date {
  return new Date(now.getTime() + RETRY_HOURS[Math.min(Math.max(failures, 0), RETRY_HOURS.length - 1)] * HOUR_MS);
}

// 루틴 steps(JSON) → 단계마다 시작 시각 (0시부터 분, 자정을 넘으면 1440 이상). 순서는 단계 순서(= alarms.step_order − 1)
//   D29 임시 모양: routines에 시작 시각 칸이 없고 steps 모양이 정해지지 않아(D29 열림) 앱 mobile/src/features/routine/map.ts parseSteps · planRoutineAlarms와 같은 규칙으로 읽음.
//   order가 있으면 그 순서(없으면 들어 있는 순서), 첫 단계의 offset이 루틴 시작 시각(없으면 21:30), 단계가 걸리는 시간은 minutes → 다음 단계 offset과의 간격 → 5분,
//   다음 단계는 앞 단계 시각 + 걸리는 시간. D29가 정해져 모양이 바뀌면 여기와 map.ts를 같이 고침 (루틴 단계 시각을 읽는 곳은 이 함수 하나)
export const ROUTINE_DEFAULT_START_MINUTE = 21 * 60 + 30;
const ROUTINE_DEFAULT_STEP_MINUTES = 5;

export function routineStepStarts(steps: unknown): number[] | null {
  if (!Array.isArray(steps)) return null;
  const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const items = steps
    .map((raw, index) => ({ raw, index }))
    .filter((x): x is { raw: Record<string, unknown>; index: number } => typeof x.raw === 'object' && x.raw !== null && !Array.isArray(x.raw))
    .sort((a, b) => (finite(a.raw.order) && finite(b.raw.order) ? a.raw.order - b.raw.order : a.index - b.index))
    .map((x) => x.raw);
  if (!items.length) return null;
  let at = finite(items[0].offset) ? Math.round(items[0].offset) : ROUTINE_DEFAULT_START_MINUTE;
  return items.map((raw, i) => {
    const start = at;
    const next = items[i + 1]?.offset;
    const gap = finite(raw.offset) && finite(next) ? Math.round(next - raw.offset) : 0;
    at += finite(raw.minutes) && raw.minutes > 0 ? Math.round(raw.minutes) : gap > 0 ? gap : ROUTINE_DEFAULT_STEP_MINUTES;
    return start;
  });
}

// 기준 회차의 직접 고른 시각(MANUAL)을 새 회차 날짜의 같은 시:분으로 — 약속 날짜와 알람 날짜가 다른 알람(새벽 1시 약속의 전날 밤 기상)은 그 날 수 차이를 그대로 둠
export function shiftManualTimes(alarms: readonly AlarmRow[], baseAt: Date, occurrenceDate: string, timeZone: string): Partial<Record<RingKind, Date>> {
  const out: Partial<Record<RingKind, Date>> = {};
  const baseKey = localDateKey(baseAt, timeZone);
  for (const a of alarms) {
    if (a.time_source !== 'MANUAL' || !(RING_KINDS as readonly string[]).includes(a.alarm_type)) continue;
    const at = new Date(a.scheduled_at);
    const dayKey = localDateKey(at, timeZone);
    const offsetDays = Math.round((Date.parse(`${dayKey}T00:00:00Z`) - Date.parse(`${baseKey}T00:00:00Z`)) / DAY_MS);
    out[a.alarm_type as RingKind] = zonedTime(addDaysToKey(occurrenceDate, offsetDays), localMinuteOfDay(at, timeZone), timeZone);
  }
  return out;
}

// 기준 회차의 만든 알람 종류. 기준 회차가 그날 첫 일정이 아니어서 기상이 없던 것이지 사용자가 기상을 안 만든 게 아니라면, 새 회차가 그날 첫 일정일 때 기상을 더함
//   L6 안건후보: 기준 회차에 기상이 없을 때 기본안 = 기준 회차가 "그날 다른 기상에 밀려" 없던 거면 새 회차가 첫 일정일 때 기상을 만들고, 그 밖(사용자가 안 고름)이면 없는 채로 이어받음
export function inheritedKinds(alarms: readonly AlarmRow[], options: { withWake: boolean; baseHadEarlierWake: boolean }): RingKind[] {
  const kinds = RING_KINDS.filter((k) => alarms.some((a) => a.alarm_type === k));
  if (options.withWake && options.baseHadEarlierWake && kinds.length && !kinds.includes('WAKE')) return ['WAKE', ...kinds];
  return kinds;
}

// 기준 회차에서 끈 종류는 끈 채로 (H02에서 끈 것). 시각이 이미 지나서 꺼진 것은 사용자가 끈 게 아니라고 보고 켬 — resolveEnabled(commit-core.ts)와 같은 규칙
export function inheritedEnabled(alarms: readonly AlarmRow[], now: Date): Partial<Record<RingKind, boolean>> {
  const out: Partial<Record<RingKind, boolean>> = {};
  for (const a of alarms) {
    if ((RING_KINDS as readonly string[]).includes(a.alarm_type)) {
      out[a.alarm_type as RingKind] = resolveEnabled({ checkedEnabled: true, old: a, now });
    }
  }
  return out;
}

// 반복 다음 회차의 자동 준비시간이 직전 회차에서 움직일 수 있는 폭 (분) — D62 처음 2주 몫
export const PREPARE_DAILY_STEP_MAX = 10;

export type RollPlanCtx = {
  userId: string; // 만든 사람 — 본인 길은 검증한 로그인 사용자(requireUser), 배치는 roll_due_series가 준 사용자. 요청 본문에서 받지 않음
  now: Date;
  profile: ProfileRow;
  timeZone: string;
  stats: PlanInputs['stats'];
  lateCount4w: number;
};

// 기준 회차 = 묶음에서 occurrence_on이 가장 늦은 행 (약속 + 내 참여 조건 + 그 알람 + 준비물 제목)
export type RollBase = {
  appointment: SeriesAppointmentRow;
  participant: ParticipantRow;
  alarms: AlarmRow[];
  items: string[];
};

export type PlannedOccurrence =
  | {
      ok: true;
      plan: Plan;
      inputs: PlanInputs;
      alarms: AlarmWrite[]; // roll_insert_occurrence의 p_alarms
      payload: { appointment: Record<string, unknown>; participant: Record<string, unknown>; items: { title: string; due_date: string }[] };
    }
  | { ok: false; reason: 'DEPARTURE_PASSED' | 'ORDER'; plan: Plan };

// 이동시간 → 계산에 넘기는 모양 (buildPlan이 길찾기 값을 쓸 때와 같음)
export const resolvedTravelOf = (chosen: TravelChoice): ResolvedTravel => ({ chosen, auto: chosen, warnings: [] });

// 새 회차 하나의 계획 — 설계 메모 2절 이어받기 표대로. 계산은 alarm-commit · alarm-suggest가 쓰는 computePlan · diffAlarms 그대로 (따로 규칙을 만들지 않음)
//   이어받음: 만들 종류 · 끈 종류 · 직접 강도(단계 그대로) · 직접 시각(같은 시:분) · 출발지 · 이동 수단 · 여유 · 직접 이동시간(travel에 MANUAL로 넘어옴) · 준비물 · 제목 · 장소 · 중요도 · 메모 · 반경 · 규칙
//   새로 구함: 이동시간(API) · 준비시간(첫 값 + 개인 보정, D56-3 A — 단 기준 회차 준비값 ±10분 안에서만, D62 처음 2주 몫) · 그날 첫 일정(회차 날짜 기준 hasEarlierWake)
//   resolved.travel = 이 회차에 쓸 이동시간, sameDayWake = 이 회차 날짜에 약속 시각이 더 앞선 켜진 기상이 있나, baseHadEarlierWake = 기준 회차가 그랬나(inheritedKinds)
export function planOccurrence(
  ctx: RollPlanCtx,
  base: RollBase,
  occ: Occurrence,
  resolved: { travel: TravelChoice; sameDayWake: boolean; baseHadEarlierWake?: boolean },
): PlannedOccurrence {
  const { now, profile, timeZone } = ctx;
  const { appointment, participant } = base;
  // 기준 회차에 친구가 제안해 주인이 적용한 시각이 있어도 새 회차에는 이어받지 않음 — 친구가 바꾸기 전 모습(시각 · time_source)에서 이어받음 (한 번의 제안이 반복 전체에 퍼지지 않게)
  const alarms = withoutFriendTimes(base.alarms);
  const num = (v: number | string | null) => (v == null ? undefined : Number(v));
  const destLat = num(appointment.dest_lat);
  const destLng = num(appointment.dest_lng);

  const draftOf = (manualTimes: Partial<Record<RingKind, Date>>): PlanDraft => ({
    at: occ.at,
    destination: { name: appointment.dest_name, ...(destLat != null && destLng != null ? { lat: destLat, lng: destLng } : {}) },
    importance: appointment.importance,
    kinds: inheritedKinds(alarms, { withWake: !resolved.sameDayWake, baseHadEarlierWake: resolved.baseHadEarlierWake === true }),
    manualTimes,
  });
  // D62 처음 2주 몫: 하루에 움직이는 폭 상한 — 새 회차의 자동 준비시간은 직전(기준) 회차의 준비값 ±10분 안에서만 (학습 루프 기초 1절 ④)
  //   기준 회차에 기상 알람이 있어서 준비값이 "기상~출발"일 때만 비교함 — 기상 없는 회차(공통 15분)와 섞어 비교하면 15 ↔ 60처럼 엉뚱하게 당겨지므로.
  //   L6 안건후보: 기준 회차에 기상 행이 없는 묶음의 상한 기본안 = 상한을 걸지 않음 (기준이 기상 없는 회차인지 알 수 없음)
  const prepareBound = alarms.some((a) => a.alarm_type === 'WAKE') ? { around: Number(participant.prepare_minutes), within: PREPARE_DAILY_STEP_MAX } : undefined;
  const planWith = (manualTimes: Partial<Record<RingKind, Date>>) => {
    const inputs: PlanInputs = {
      now,
      draft: draftOf(manualTimes),
      profile,
      participant, // 출발지 · 이동 수단 · 여유를 이 참여 조건에서 이어받음 (resolveBasics)
      existingAlarms: alarms, // 직접 강도 · 준비 전 활동 간격을 기준 회차 알람에서 읽음 (resolveOverrides · inferBeforePrepare)
      stats: ctx.stats,
      lateCount4w: ctx.lateCount4w,
      sameDayWake: resolved.sameDayWake,
      ...(prepareBound && Number.isFinite(prepareBound.around) ? { prepareBound } : {}),
    };
    return { inputs, plan: computePlan(inputs, resolvedTravelOf(resolved.travel), 'save') };
  };

  const manual = shiftManualTimes(alarms, new Date(appointment.appointment_at), occ.date, timeZone);
  let { inputs, plan } = planWith(manual);
  // L6 안건후보: 직접 시각이 새 회차에서 순서가 어긋날 때 기본안 = 이동시간이 달라져 직접 고른 기상이 출발보다 늦어지는 식이면, 직접 시각을 버리고 자동 시각으로 만듦
  if (!plan.check.ok && plan.check.reason === 'ORDER' && Object.keys(manual).length) ({ inputs, plan } = planWith({}));
  if (!plan.check.ok) return { ok: false, reason: plan.check.reason, plan };

  const writes = diffAlarms(plan, [], { now, enabled: inheritedEnabled(alarms, now), replaceExisting: false }).insert;
  const { basics } = plan;
  return {
    ok: true,
    plan,
    inputs,
    alarms: writes,
    payload: {
      appointment: {
        creator_id: ctx.userId, // roll_insert_occurrence는 security definer라 이 값을 그대로 믿음 — 읽어 온 행이 아니라 검증된 사용자에서
        group_id: null, // 공동 약속은 반복이어도 첫 회차만 — 개인 약속만 회차를 만듦
        series_id: appointment.series_id,
        occurrence_on: occ.date,
        title: appointment.title,
        appointment_at: occ.at.toISOString(),
        dest_name: appointment.dest_name,
        dest_lat: appointment.dest_lat,
        dest_lng: appointment.dest_lng,
        dest_radius_m: appointment.dest_radius_m,
        importance: basics.importance,
        recurrence_rule: appointment.recurrence_rule,
        memo: appointment.memo,
      },
      participant: {
        origin_name: basics.origin.name,
        origin_lat: basics.origin.lat ?? null,
        origin_lng: basics.origin.lng ?? null,
        transport_type: basics.transport,
        est_travel_minutes: plan.travelMinutes,
        travel_source: resolved.travel.source,
        prepare_minutes: plan.prepare.minutes,
        buffer_minutes: basics.bufferMinutes,
      },
      items: base.items.map((title) => ({ title, due_date: occ.date })),
    },
  };
}

// 이 회차의 첫 알람 시각 — 알람이 없는 회차(kinds = [])는 출발 시각
export const firstAlarmAt = (plan: Plan): Date => (plan.chain.length ? new Date(Math.min(...plan.chain.map((a) => a.at.getTime()))) : plan.departure);

// ---------------------------------------------------------------------------
// 읽기 도우미 (모두 사용자로 좁힘)
// ---------------------------------------------------------------------------

type StandaloneRow = AlarmRow & { series_id: string; occurrence_on: string };
type RoutineRow = { routine_id: string; title: string; repeat_days: string; steps: unknown; is_active: boolean };
type AttemptRow = { series_id: string; occurrence_on: string; tries: number; next_try_at: string; skipped: boolean };

const STANDALONE_COLUMNS = `${ALARM_COLUMNS}, series_id, occurrence_on`;
const ROUTINE_COLUMNS = 'routine_id, title, repeat_days, steps, is_active';

export type RollTask = { user_id: string; series_id: string; kind: 'APPOINTMENT' | 'STANDALONE' | 'ROUTINE'; template_id: string };
type Task = RollTask & { appointment?: SeriesAppointmentRow; standalone?: StandaloneRow; routine?: RoutineRow };

// 묶음마다 가장 늦은 행 (occurrence_on이 같으면 먼저 읽은 것) — 목록은 occurrence_on 내림차순으로 읽어 옴
function newestPerSeries<T extends { series_id: string }>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.series_id) ? false : (seen.add(r.series_id), true)));
}

// 묶음마다 기준 회차 (edit.ts pickBaseRow) — 예외 아닌 행이 우선, 예외뿐이면 이번만 고친 행, 지운 행은 기준이 아님
function baseRowsPerSeries<T extends { series_id: string; occurrence_on: string; appointment_at: string; appointment_id: string; exception_kind?: ExceptionKind | null }>(rows: readonly T[]): T[] {
  const bySeries = new Map<string, T[]>();
  for (const r of rows) bySeries.set(r.series_id, [...(bySeries.get(r.series_id) ?? []), r]);
  return [...bySeries.values()].flatMap((list) => {
    const base = pickBaseRow(list);
    return base ? [base] : [];
  });
}

const attemptKey = (seriesId: string, date: string) => `${seriesId}|${date}`;

// 사람 하나에 대해 이번 실행 동안 들고 있는 값 — 처음 쓸 때 읽음
class UserState {
  private cached = new Map<string, Promise<unknown>>();
  private upcoming: number | null = null;
  private lookupsToday: number | null = null;
  private run: RollRun;
  readonly userId: string;

  constructor(run: RollRun, userId: string) {
    this.run = run;
    this.userId = userId;
  }

  private memo<T>(key: string, load: () => Promise<T>): Promise<T> {
    let hit = this.cached.get(key) as Promise<T> | undefined;
    if (!hit) {
      hit = load();
      this.cached.set(key, hit);
      hit.catch(() => this.cached.delete(key)); // 실패는 기억하지 않음
    }
    return hit;
  }

  profile() {
    return this.memo('profile', () => loadProfile(this.run.deps.read, this.userId));
  }
  async timeZone() {
    return safeTimeZone((await this.profile()).timezone);
  }
  async planCtx(): Promise<RollPlanCtx> {
    const { read, now } = this.run.deps;
    const [profile, stats, lateCount4w] = await Promise.all([
      this.profile(),
      this.memo('stats', () => loadPrepareStats(read, this.userId)),
      this.memo('late', () => loadLateCount(read, this.userId, now)),
    ]);
    return { userId: this.userId, now, profile, timeZone: safeTimeZone(profile.timezone), stats, lateCount4w };
  }
  samples() {
    return this.memo('samples', () => loadTravelSamples(this.run.deps.read, this.userId));
  }

  // 재시도 기록 (roll_attempts, service 전용이라 write로 읽음) — 어제 이후 날짜만
  attempts() {
    return this.memo('attempts', async () => {
      const since = addDaysToKey(localDateKey(this.run.deps.now, await this.timeZone()), -1);
      const rows = must<AttemptRow[]>(
        'roll_attempts',
        await this.run.deps.write.from('roll_attempts').select('series_id, occurrence_on, tries, next_try_at, skipped').eq('user_id', this.userId).gte('occurrence_on', since),
      );
      return new Map(rows.map((r) => [attemptKey(r.series_id, r.occurrence_on), r]));
    });
  }

  // 이미 있는 회차 날짜(occurrence_on) — 어제 이후, 묶음별로. 사람 하나에 한 번 읽음 (묶음마다 읽지 않게 — 만들 게 없는 묶음이 쿼리를 더 쓰지 않음)
  seriesDates(kind: 'APPOINTMENT' | 'STANDALONE') {
    return this.memo(`dates:${kind}`, async () => {
      const { read, now } = this.run.deps;
      const since = addDaysToKey(localDateKey(now, await this.timeZone()), -1);
      const rows = must<{ series_id: string; occurrence_on: string }[]>(
        'series dates',
        kind === 'APPOINTMENT'
          ? await read.from('appointments').select('series_id, occurrence_on').eq('creator_id', this.userId).gte('occurrence_on', since)
          : await read.from('alarms').select('series_id, occurrence_on').eq('user_id', this.userId).not('series_id', 'is', null).gte('occurrence_on', since),
      );
      const byseries = new Map<string, Set<string>>();
      for (const r of rows) byseries.set(r.series_id, (byseries.get(r.series_id) ?? new Set()).add(r.occurrence_on));
      return byseries;
    });
  }

  // 앞으로 켜진 알람 수 (상한 확인용). 이번 실행에서 만든 만큼 늘려 감
  async upcomingAlarms(): Promise<number> {
    if (this.upcoming == null) {
      const { count, error } = await this.run.deps.read
        .from('alarms')
        .select('alarm_id', { count: 'exact', head: true })
        .eq('user_id', this.userId)
        .eq('is_enabled', true)
        .gte('scheduled_at', this.run.deps.now.toISOString());
      if (error) dbFail('upcoming alarms', error);
      this.upcoming = count ?? 0;
    }
    return this.upcoming;
  }
  addUpcoming(n: number) {
    if (this.upcoming != null) this.upcoming += n;
  }

  // 오늘(내 시간대 하루) roll이 쓴 길찾기 수. 셈 방법: 오늘 roll이 만든 회차(만든 때가 오늘이고 묶음 번호가 자기 id가 아닌 약속) + 길찾기를 쓰고도 못 만든 날짜(오늘 고쳐진 재시도 기록 중 tries ≥ 1).
  //   · 한 줄(재시도 기록)이 하루에 여러 번 실패해도 한 번으로 셈 — 한도는 어림 상한이라 이 정도 오차는 둠
  //   · 지난 실행들의 호출 수를 따로 저장하는 곳이 없어서(마이그레이션 없이) DB에 남은 흔적으로 셈. 폴백으로 만든 회차도 만든 회차로 셈(그 회차도 길찾기를 한 번 썼음)
  //   L6 안건후보: 하루 몫 범위 기본안 = 사용자별 (배치가 사용자로 좁혀 읽는 규칙을 지키려고). 전체 합계 한도는 kakao_calls 로그로 L8이 보고 정함
  async lookupsUsed(): Promise<number> {
    if (this.lookupsToday == null) {
      const { read, write, now } = this.run.deps;
      const { start, end } = localDayRange(now, await this.timeZone());
      const made = must<{ appointment_id: string; series_id: string }[]>(
        'roll created today',
        await read
          .from('appointments')
          .select('appointment_id, series_id')
          .eq('creator_id', this.userId)
          .gte('created_at', start.toISOString())
          .lt('created_at', end.toISOString())
          .not('recurrence_rule', 'is', null),
      ).filter((a) => a.series_id !== a.appointment_id).length;
      const { count, error } = await write
        .from('roll_attempts')
        .select('series_id', { count: 'exact', head: true })
        .eq('user_id', this.userId)
        .gte('updated_at', start.toISOString())
        .gt('tries', 0);
      if (error) dbFail('roll attempts today', error);
      this.lookupsToday = made + (count ?? 0);
    }
    return this.lookupsToday;
  }
  addLookup() {
    if (this.lookupsToday != null) this.lookupsToday += 1;
  }
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------

type Item = {
  task: Task;
  occ: Occurrence;
  requested: boolean; // 요청의 series_id인 묶음 (본인 길)
  appointment?: SeriesAppointmentRow;
  standalone?: StandaloneRow;
  lookedUp?: boolean; // 이 회차에 길찾기를 이미 부름 (처리 중 던지면 재시도 기록을 남기려고)
  settled?: boolean; // 결과가 DB에 남음 (재시도 기록을 올렸거나 회차를 만듦) — 이후에 던져도 다시 기록하지 않음
};

// 길찾기 값을 못 정했을 때 — 다음에 어떻게 할지
//   RETRY 재시도 기록을 올려 1 · 3 · 6시간 뒤, NEXT_DAY 내 시간대 다음 날 0시 뒤, NONE 기록 없이 다음 실행에서
type Failure = { name: string; mode: 'RETRY' | 'NEXT_DAY' | 'NONE'; reason: PendingReason; spent: boolean };

class RollRun {
  readonly result: RollResult = { created: [], moved_alarm_ids: [], pending: [], ring_packages: [], canceled_alarm_ids: [], kakao_calls: 0 };
  readonly limits: RollLimits;
  private users = new Map<string, UserState>();
  private bases = new Map<string, Promise<RollBase | null>>();
  private stoppedBy: 'RATE_LIMIT' | 'AUTH' | null = null; // 이번 실행의 길찾기를 멈춘 이유
  private startedAt: number;
  private seenPending = new Set<string>();
  readonly deps: RollDeps;
  private scope: { userId?: string; seriesId?: string };

  constructor(deps: RollDeps, scope: { userId?: string; seriesId?: string }) {
    this.deps = deps;
    this.scope = scope;
    this.limits = { ...ROLL_LIMITS[deps.path], ...deps.limits };
    this.startedAt = (deps.clock ?? Date.now)();
  }

  user(userId: string): UserState {
    let u = this.users.get(userId);
    if (!u) this.users.set(userId, (u = new UserState(this, userId)));
    return u;
  }

  private timeUp(): boolean {
    return this.limits.ms != null && (this.deps.clock ?? Date.now)() - this.startedAt > this.limits.ms;
  }

  // 묶음 하나가 실패해도 다음 묶음으로 — 이유 글자만 남김 (사용자 · 일정 내용 없이)
  private reasonOf(e: unknown): string {
    return e instanceof RangeError ? 'INVALID_VALUE' : e instanceof HttpError ? e.code : 'ERROR';
  }

  private skipped(where: string, e: unknown) {
    const reason = this.reasonOf(e);
    (this.deps.warn ?? console.warn)(JSON.stringify({ fn: 'alarm-roll', event: 'series_skipped', where, reason }));
  }

  private pend(seriesId: string, date: string, reason: PendingReason) {
    const key = `${seriesId}|${date}`;
    if (this.seenPending.has(key)) return;
    this.seenPending.add(key);
    this.result.pending.push({ series_id: seriesId, occurrence_on: date, reason });
  }

  // ---- 할 일 목록 ----

  private async dueTasks(): Promise<Task[]> {
    const { read, write, now } = this.deps;
    if (this.deps.path === 'batch') {
      const rows = must<RollTask[]>('roll_due_series', await write.rpc('roll_due_series', { p_now: now.toISOString(), p_limit: this.limits.fetch }));
      // 사람별로 기준 회차를 한 번에 읽음 (묶음마다 한 번씩 읽지 않게)
      const tasks: Task[] = rows.map((r) => ({ ...r }));
      const byUser = new Map<string, Task[]>();
      for (const t of tasks) if (t.kind === 'APPOINTMENT') byUser.set(t.user_id, [...(byUser.get(t.user_id) ?? []), t]);
      for (const [userId, list] of byUser) {
        try {
          const found = new Map((await loadSeriesAppointments(read, userId, list.map((t) => t.template_id))).map((a) => [a.appointment_id, a]));
          for (const t of list) t.appointment = found.get(t.template_id);
        } catch (e) {
          this.skipped('templates', e); // 이 사람 것만 건너뜀 (appointment가 비면 collect가 하나씩 다시 읽어 봄)
        }
      }
      return tasks;
    }

    // 본인 길 — 내 묶음을 RLS 클라이언트로 직접 읽음 (roll_due_series는 service_role 전용이고 모든 사람의 줄을 줌)
    const userId = this.scope.userId as string;
    // 기준 회차는 예외(이번만 고친 · 지운 회차, exception_kind)가 아닌 행 중 가장 늦은 것 — 이번만 고친 값이 다음 회차들로 번지지 않게 (edit.ts pickBaseRow = DB 함수 roll_due_series와 같은 규칙)
    const appointments = baseRowsPerSeries(
      must<(SeriesAppointmentRow & { exception_kind: ExceptionKind | null })[]>(
        'appointments',
        await read
          .from('appointments')
          .select(`${SERIES_APPOINTMENT_COLUMNS}, exception_kind`)
          .eq('creator_id', userId)
          .not('recurrence_rule', 'is', null)
          .order('occurrence_on', { ascending: false })
          .limit(500),
      ),
    ).map((a): Task => ({ user_id: userId, series_id: a.series_id, kind: 'APPOINTMENT', template_id: a.appointment_id, appointment: a }));
    const standalones = newestPerSeries(
      must<StandaloneRow[]>(
        'alarms',
        await read
          .from('alarms')
          .select(STANDALONE_COLUMNS)
          .eq('user_id', userId)
          .not('series_id', 'is', null)
          .not('recurrence_rule', 'is', null)
          .order('occurrence_on', { ascending: false })
          .limit(500),
      ),
    ).map((a): Task => ({ user_id: userId, series_id: a.series_id, kind: 'STANDALONE', template_id: a.alarm_id, standalone: a }));
    const routines = must<RoutineRow[]>('routines', await read.from('routines').select(ROUTINE_COLUMNS).eq('user_id', userId).eq('is_active', true)).map(
      (r): Task => ({ user_id: userId, series_id: r.routine_id, kind: 'ROUTINE', template_id: r.routine_id, routine: r }),
    );
    return [...appointments, ...standalones, ...routines];
  }

  // ---- 한 묶음에서 만들 회차 모으기 (루틴은 바로 옮김) ----

  private async collect(task: Task): Promise<Item[]> {
    if (task.kind === 'ROUTINE') {
      await this.moveRoutine(task);
      return [];
    }
    const { read, now } = this.deps;
    const user = this.user(task.user_id);
    const requested = task.series_id === this.scope.seriesId;

    let rule: string | null | undefined;
    let baseAt: string;
    if (task.kind === 'APPOINTMENT') {
      task.appointment ??= (await loadSeriesAppointment(read, task.user_id, task.template_id)) ?? undefined;
      const a = task.appointment;
      if (!a || a.group_id != null) return []; // 공동 약속은 반복이어도 첫 회차만
      [rule, baseAt] = [a.recurrence_rule, a.appointment_at];
    } else {
      task.standalone ??=
        must<StandaloneRow | null>('alarms', await read.from('alarms').select(STANDALONE_COLUMNS).eq('alarm_id', task.template_id).eq('user_id', task.user_id).maybeSingle()) ?? undefined;
      const s = task.standalone;
      if (!s) return [];
      [rule, baseAt] = [s.recurrence_rule, s.scheduled_at];
    }
    // 규칙이 두 모양(FREQ=DAILY · FREQ=WEEKLY;BYDAY=…) 밖이면(옛 MONTHLY · INTERVAL …) 오류가 아니라 반복이 아닌 것으로 보고 조용히 건너뜀
    if (!parseRecurrence(rule)) return [];

    const tz = await user.timeZone();
    const today = localDateKey(now, tz);
    // 오늘부터 다시 구함 — 길찾기 실패로 중간 날짜가 비어 있어도 채우고, 이미 있는 날짜는 아래에서 뺌 (지난 날은 recur.ts가 안 줌)
    //   날짜의 기준은 기준 회차 약속 시각(appointment_at)의 날짜가 아니라 회차 날짜 칸(occurrence_on): 시각을 옮긴 행은 둘이 어긋나므로, 시각의 날짜에서 이어 세지 않고
    //   규칙 날짜를 오늘부터 구한 뒤 이미 있는 occurrence_on을 빼서 같은 날짜를 두 번 만들지(길찾기를 헛쓰지) 않음. 기준 회차에서는 시:분만 가져옴
    const found = nextOccurrences({ rule, baseAt: new Date(baseAt), now, timeZone: tz, afterDate: addDaysToKey(today, -1) });
    if (!found.length) return []; // 할 일 없는 묶음 — 여기서 끝 (기준 회차 한 줄만 읽었음)

    const have = (await user.seriesDates(task.kind)).get(task.series_id) ?? new Set<string>();
    const fresh = found.filter((o) => !have.has(o.date));
    if (!fresh.length) return []; // 만들 회차가 이미 다 있음 (재시도 기록은 볼 것도 없음)
    const attempts = await user.attempts();
    const blocked = (date: string) => {
      const a = attempts.get(attemptKey(task.series_id, date));
      return a != null && (a.skipped || Date.parse(a.next_try_at) > now.getTime()); // 건너뛴 날짜 · 재시도 기다리는 날짜
    };
    return fresh
      .filter((o) => !blocked(o.date))
      .map((occ) => ({ task, occ, requested, ...(task.kind === 'APPOINTMENT' ? { appointment: task.appointment } : { standalone: task.standalone }) }));
  }

  // ---- 루틴: 같은 행의 시각만 다음 발생으로 ----

  private async moveRoutine(task: Task) {
    const { read, write, now } = this.deps;
    const routine =
      task.routine ??
      must<RoutineRow | null>('routines', await read.from('routines').select(ROUTINE_COLUMNS).eq('routine_id', task.template_id).eq('user_id', task.user_id).maybeSingle()) ??
      undefined;
    if (!routine?.is_active) return;
    const tz = await this.user(task.user_id).timeZone();
    const starts = routineStepStarts(routine.steps);
    if (!starts) return;
    type Past = Pick<AlarmRow, 'alarm_id' | 'alarm_type' | 'scheduled_at' | 'intensity' | 'voice_tone' | 'sound_key' | 'vibration' | 'snooze_limit' | 'is_enabled'> & { step_order: number | null };
    const past = must<Past[]>(
      'routine alarms',
      await read
        .from('alarms')
        .select('alarm_id, step_order, alarm_type, scheduled_at, intensity, voice_tone, sound_key, vibration, snooze_limit, is_enabled')
        .eq('user_id', task.user_id)
        .eq('routine_id', routine.routine_id)
        .eq('is_enabled', true)
        .lt('scheduled_at', now.toISOString()),
    );
    const moved: (Past & { scheduled_at: string })[] = [];
    for (const alarm of past) {
      const start = alarm.step_order == null ? undefined : starts[alarm.step_order - 1];
      if (start == null) continue;
      const at = nextRoutineAt({ repeatDays: routine.repeat_days, stepOffsetMinutes: start, now, timeZone: tz });
      if (!at) continue;
      // 옛 시각이 아직 그대로일 때만 옮김 — 본인 길과 배치가 동시에 와도 먼저 옮긴 쪽만 (두 번째는 할 일 없음)
      const updated = must<{ alarm_id: string }[]>(
        'routine alarm move',
        await write
          .from('alarms')
          .update({ scheduled_at: at.toISOString(), last_calculated_at: now.toISOString() })
          .eq('alarm_id', alarm.alarm_id)
          .eq('user_id', task.user_id)
          .eq('scheduled_at', alarm.scheduled_at)
          .select('alarm_id'),
      );
      if (!updated.length) continue;
      this.result.moved_alarm_ids.push(alarm.alarm_id);
      moved.push({ ...alarm, scheduled_at: at.toISOString() });
    }
    if (this.deps.path === 'own' && moved.length) this.result.ring_packages.push(...buildRingPackages({ alarms: moved, title: routine.title }));
  }

  // ---- 기준 회차 읽기 (묶음마다 한 번) ----

  private baseOf(task: Task): Promise<RollBase | null> {
    const key = `${task.user_id}|${task.series_id}`;
    let hit = this.bases.get(key);
    if (!hit) {
      hit = this.loadBase(task);
      this.bases.set(key, hit);
    }
    return hit;
  }

  private async loadBase(task: Task): Promise<RollBase | null> {
    const { read } = this.deps;
    const appointment = task.appointment as SeriesAppointmentRow;
    const participant = await loadParticipant(read, appointment.appointment_id, task.user_id);
    if (!participant) return null; // 참여 조건이 없는 약속은 이어받을 게 없음
    const [alarms, items] = await Promise.all([
      loadAlarms(read, participant.participant_id, task.user_id),
      read
        .from('todos')
        .select('title')
        .eq('user_id', task.user_id)
        .eq('appointment_id', appointment.appointment_id)
        .eq('todo_type', 'ITEM')
        .order('created_at', { ascending: true })
        .then((r) => must<{ title: string }[]>('todos', r).map((t) => t.title)),
    ]);
    return { appointment, participant, alarms, items };
  }

  // ---- 재시도 기록 ----

  private async record(userId: string, seriesId: string, date: string, how: { failure?: Failure; skipped?: string; spent: boolean }) {
    const { write, now } = this.deps;
    const user = this.user(userId);
    const attempts = await user.attempts();
    const key = attemptKey(seriesId, date);
    const prev = attempts.get(key);
    const failure = how.failure;
    const retrying = failure?.mode === 'RETRY';
    const tries = (prev?.tries ?? 0) + (retrying || how.spent ? 1 : 0); // 길찾기를 쓴(또는 재시도를 올린) 횟수
    const nextTryAt =
      failure?.mode === 'NEXT_DAY'
        ? localDayRange(now, await user.timeZone()).end // 내 시간대 다음 날 0시
        : retrying
          ? retryAt(now, prev?.tries ?? 0)
          : now;
    const row = {
      user_id: userId,
      series_id: seriesId,
      occurrence_on: date,
      tries,
      next_try_at: nextTryAt.toISOString(),
      last_error: (failure?.name ?? how.skipped ?? null)?.slice(0, 40) ?? null,
      skipped: how.skipped != null,
      updated_at: now.toISOString(),
    };
    must('roll_attempts', await write.from('roll_attempts').upsert(row, { onConflict: 'user_id,series_id,occurrence_on' }));
    attempts.set(key, { series_id: seriesId, occurrence_on: date, tries, next_try_at: row.next_try_at, skipped: row.skipped });
  }

  // 길찾기를 이미 썼는데 계산 · 저장이 던졌으면 재시도 기록을 남김 — 안 남기면 다음 5분 실행이 같은 회차로 길찾기를 또 부름.
  //   기존 1 · 3 · 6시간 규칙 그대로, 하루 몫에도 한 번 센 것으로 남음. last_error는 이름 글자만 (좌표 · 장소명 없음). 길찾기를 안 썼으면(순수 계산 오류) 아무것도 안 함
  private async retryAfterThrow(item: Item, e: unknown) {
    if (!item.lookedUp || item.settled) return;
    try {
      await this.record(item.task.user_id, item.task.series_id, item.occ.date, {
        failure: { name: this.reasonOf(e), mode: 'RETRY', reason: 'ROUTE_RETRY', spent: true },
        spent: true,
      });
    } catch (e2) {
      this.skipped('retry_record', e2);
    }
  }

  private async clearAttempt(userId: string, seriesId: string, date: string) {
    const attempts = await this.user(userId).attempts();
    if (!attempts.delete(attemptKey(seriesId, date))) return;
    must('roll_attempts', await this.deps.write.from('roll_attempts').delete().eq('user_id', userId).eq('series_id', seriesId).eq('occurrence_on', date));
  }

  // ---- 회차 하나 ----

  private async process(item: Item) {
    if (item.task.kind === 'APPOINTMENT') await this.processAppointment(item);
    else await this.processStandalone(item);
  }

  private async processStandalone(item: Item) {
    const { task, occ } = item;
    const s = item.standalone as StandaloneRow;
    const user = this.user(task.user_id);
    if ((await user.upcomingAlarms()) >= this.limits.alarmCap) return this.pend(task.series_id, occ.date, 'ALARM_CAP');
    const row = {
      user_id: task.user_id,
      participant_id: null,
      routine_id: null,
      series_id: task.series_id,
      occurrence_on: occ.date,
      alarm_type: 'WAKE',
      scheduled_at: occ.at.toISOString(),
      intensity: s.intensity,
      voice_tone: s.voice_tone,
      sound_key: s.sound_key,
      vibration: s.vibration, // 직접 고른 진동도 이어받음 (NULL이면 강도를 따름)
      is_enabled: s.is_enabled, // 꺼 둔 반복 알람은 새 회차도 꺼진 채 (켜는 순간 다음 회차가 이미 있게)
      snooze_limit: s.snooze_limit,
      time_source: s.time_source,
      intensity_source: s.intensity_source,
      recurrence_rule: s.recurrence_rule,
      last_calculated_at: this.deps.now.toISOString(),
    };
    // 같은 날짜가 이미 있으면 아무것도 안 하고 돌려주는 행도 없음 (ON CONFLICT DO NOTHING … RETURNING)
    const inserted = must<AlarmRow[]>(
      'alarms upsert',
      await this.deps.write.from('alarms').upsert(row, { onConflict: 'user_id,series_id,occurrence_on', ignoreDuplicates: true }).select(ALARM_COLUMNS),
    );
    if (!inserted.length) return;
    this.result.created.push({ series_id: task.series_id, occurrence_on: occ.date, appointment_id: null, alarm_id: inserted[0].alarm_id });
    if (inserted[0].is_enabled) user.addUpcoming(1);
    if (this.deps.path === 'own') {
      const tz = await user.timeZone();
      this.result.ring_packages.push(...buildRingPackages({ alarms: inserted, title: '알람', subtitle: subtitleFor(occ.at, null, tz) }));
    }
  }

  // 길찾기를 불러도 되는지 — 못 부르면 그 이유
  private async lookupGate(user: UserState): Promise<Failure | null> {
    if (!this.deps.lookup) return { name: 'AUTH', mode: 'NEXT_DAY', reason: 'ROUTE_RETRY', spent: false }; // 키가 없음
    if (this.stoppedBy) return { name: this.stoppedBy, mode: 'NEXT_DAY', reason: 'ROUTE_RETRY', spent: false };
    if (this.result.kakao_calls >= this.limits.lookups) return { name: 'RUN_LIMIT', mode: 'NONE', reason: 'RUN_LIMIT', spent: false };
    if ((await user.lookupsUsed()) >= this.limits.dailyLookups) return { name: 'DAILY_BUDGET', mode: 'NEXT_DAY', reason: 'DAILY_BUDGET', spent: false };
    return null;
  }

  private async processAppointment(item: Item) {
    const { task, occ } = item;
    const user = this.user(task.user_id);
    const { read, write, now } = this.deps;
    if ((await user.upcomingAlarms()) >= this.limits.alarmCap) return this.pend(task.series_id, occ.date, 'ALARM_CAP');
    const base = await this.baseOf(task);
    if (!base) return;
    const ctx = await user.planCtx();
    const sameDayWake = await loadSameDayWake(read, task.user_id, occ.at, ctx.timeZone); // 회차 날짜 기준 그날 첫 일정 판정
    const baseHadEarlierWake =
      !sameDayWake && base.alarms.length && !base.alarms.some((a) => a.alarm_type === 'WAKE')
        ? await loadSameDayWake(read, task.user_id, new Date(base.appointment.appointment_at), ctx.timeZone, base.appointment.appointment_id)
        : false;
    const planFor = (travel: TravelChoice) => planOccurrence(ctx, base, occ, { travel, sameDayWake, baseHadEarlierWake });

    // 이동시간 — 직접 입력(MANUAL)은 그 분 그대로(길찾기 없음), 아니면 회차마다 길찾기 1번
    let travel: TravelChoice | null = null;
    let failure: Failure | null = null;
    let lookedUp = false;
    const p = base.participant;
    if (p.travel_source === 'MANUAL' && p.est_travel_minutes != null) {
      travel = { minutes: p.est_travel_minutes, source: 'MANUAL', needsConfirmation: false, note: '직접 입력' };
    } else {
      const basics = resolveBasics({
        draft: { at: occ.at, destination: { name: base.appointment.dest_name, ...coordsOf(base.appointment.dest_lat, base.appointment.dest_lng) }, importance: base.appointment.importance },
        profile: ctx.profile,
        participant: p,
      });
      const origin = latLng(basics.origin);
      const destination = latLng(basics.destination);
      failure = !origin || !destination ? { name: 'NO_COORDS', mode: 'RETRY', reason: 'ROUTE_RETRY', spent: false } : await this.lookupGate(user);
      if (!failure && origin && destination) {
        lookedUp = true;
        item.lookedUp = true;
        this.result.kakao_calls += 1; // 실패한 호출도 한도를 씀 (회차마다 새로 부름 — 같은 실행 안 같은 경로라도 재사용 안 함, D5 A)
        user.addLookup();
        try {
          const r = await (this.deps.lookup as TravelLookup)({ origin, destination, transport: basics.transport });
          // 앞뒤 도보 구간이 빠진 결과(partial)는 API로 저장하지 않고 출처를 대략(ESTIMATE)으로 둠 — 7장 7.1.2 대체 순서와 같은 취급, 화면의 "대략적인 값이에요" 줄을 그대로 씀 (새 확인 단계 없음, 헤드 10/30)
          travel = r.partial
            ? { minutes: r.minutes, source: 'ESTIMATE', needsConfirmation: true, note: '대략적인 값이에요 · 확인이 필요해요' }
            : { minutes: r.minutes, source: 'API', needsConfirmation: false, note: '길찾기 기준' };
        } catch (e) {
          const kind = e instanceof KakaoError ? e.kind : 'HTTP';
          if (kind === 'RATE_LIMIT' || kind === 'AUTH') {
            this.stoppedBy = kind; // 이번 실행의 길찾기를 멈춤 — 다음 날 0시 뒤 다시
            failure = { name: kind, mode: 'NEXT_DAY', reason: 'ROUTE_RETRY', spent: true };
          } else {
            failure = { name: kind, mode: 'RETRY', reason: 'ROUTE_RETRY', spent: true }; // TIMEOUT · HTTP · NO_ROUTE · BAD_RESPONSE
          }
        }
      }

      // 길찾기를 못 정함: 첫 알람이 12시간 안이면 폴백(내 실측 중앙값 CACHED → 직선 근사 ESTIMATE)으로 지금 만들고, 아니면 미룸.
      //   묻는 알림 · 질문은 만들지 않음 (화면 "대략" 표시는 L5). 나중에 길찾기가 되어도 이 회차의 값을 API로 바꾸는 일은 여기서 안 함 —
      //   출발 전 다시 보기(route-watch, PR 10)의 몫
      if (!travel && failure && failure.mode !== 'NONE' && origin && destination) {
        const fallback = (await resolveAutoTravel({ origin, destination, transport: basics.transport }, { samples: () => user.samples() })).choice;
        if (fallback) {
          const provisional = planFor(fallback);
          if (firstAlarmAt(provisional.plan).getTime() - now.getTime() <= FALLBACK_BEFORE_FIRST_ALARM_HOURS * HOUR_MS) travel = fallback;
        }
      }
    }

    if (!travel) {
      const why = failure as Failure;
      if (why.mode !== 'NONE') await this.record(task.user_id, task.series_id, occ.date, { failure: why, spent: why.spent });
      item.settled = true;
      return this.pend(task.series_id, occ.date, why.reason);
    }

    const planned = planFor(travel);
    if (!planned.ok) {
      // 출발 시각까지 이미 지남(또는 순서가 어긋남) → 그 날짜는 건너뜀 (다시 안 만듦)
      await this.record(task.user_id, task.series_id, occ.date, { skipped: planned.reason, spent: lookedUp });
      item.settled = true;
      return;
    }

    const appointmentId = must<string | null>(
      'roll_insert_occurrence',
      await write.rpc('roll_insert_occurrence', { p_appointment: planned.payload.appointment, p_participant: planned.payload.participant, p_alarms: planned.alarms, p_items: planned.payload.items }),
    );
    item.settled = true; // 만들기 끝 (이후 던져도 회차는 이미 있음)
    await this.clearAttempt(task.user_id, task.series_id, occ.date);
    if (!appointmentId) return; // 다른 실행이 먼저 만듦 — 같은 결과
    this.result.created.push({ series_id: task.series_id, occurrence_on: occ.date, appointment_id: appointmentId });
    user.addUpcoming(planned.alarms.filter((a) => a.is_enabled).length);

    if (this.deps.path === 'own') {
      // 폰에 걸 꾸러미 — alarm-commit(commit.ts persistAppointment)과 같은 조립 함수(ring-package.ts buildRingPackages)로. 알림 글자가 더해져도 그 함수를 따라감
      const part = await loadParticipant(read, appointmentId, task.user_id);
      const alarms = part ? await loadAlarms(read, part.participant_id, task.user_id) : [];
      this.result.ring_packages.push(
        ...buildRingPackages({
          alarms,
          title: base.appointment.title,
          subtitle: subtitleFor(occ.at, planned.plan.basics.destination.name, ctx.timeZone),
          departAt: planned.plan.departure,
        }),
      );
    }
  }

  // ---- 전체 ----

  async execute(): Promise<RollResult> {
    const tasks = await this.dueTasks();
    const items: Item[] = [];
    let worked = 0;
    for (const task of tasks) {
      if (worked >= this.limits.series || this.timeUp()) break;
      try {
        const before = this.result.moved_alarm_ids.length;
        const found = await this.collect(task);
        items.push(...found);
        if (found.length || this.result.moved_alarm_ids.length > before) worked += 1;
      } catch (e) {
        this.skipped('collect', e);
      }
    }

    // 가까운 회차 먼저 (본인 길은 요청한 묶음 먼저). 48시간 안 회차는 가까워서 늘 앞에 옴
    items.sort((a, b) => Number(b.requested) - Number(a.requested) || a.occ.at.getTime() - b.occ.at.getTime());
    for (const item of items) {
      if (this.timeUp()) {
        this.pend(item.task.series_id, item.occ.date, 'RUN_LIMIT');
        continue;
      }
      try {
        await this.process(item);
      } catch (e) {
        this.skipped('process', e);
        await this.retryAfterThrow(item, e);
      }
    }

    this.result.ring_packages.sort((a, b) => a.atMillis - b.atMillis);
    (this.deps.log ?? console.log)(
      JSON.stringify({ fn: 'alarm-roll', path: this.deps.path, kakao_calls: this.result.kakao_calls, created: this.result.created.length, pending: this.result.pending.length }),
    );
    return this.result;
  }
}

const coordsOf = (lat: number | string | null, lng: number | string | null) => (lat != null && lng != null ? { lat: Number(lat), lng: Number(lng) } : {});
const latLng = (p: { lat?: number; lng?: number }): LatLng | undefined => (p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : undefined);

// scope.userId: 본인 길에서 부른 사람. scope.seriesId: 그 묶음 먼저 (본인 길)
export async function runRoll(deps: RollDeps, scope: { userId?: string; seriesId?: string } = {}): Promise<RollResult> {
  if (deps.path === 'own' && !scope.userId) throw new Error('본인 길은 userId가 필요해요');
  return new RollRun(deps, scope).execute();
}
