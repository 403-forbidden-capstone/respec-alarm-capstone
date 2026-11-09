// 알람 계획 만들기의 DB 쪽 — 읽기는 부른 사람의 RLS 클라이언트로 (남의 일정 · 기록은 애초에 안 보임)
// 읽어 온 값을 plan-core.ts의 순수 계산에 넘김. alarm-suggest(미리 보기)와 alarm-commit(저장)이 같이 씀
import { hasEarlierWake, PREPARE_RECORD_MAX, PREPARE_RECORD_MIN, PREPARE_WINDOW, prepareStatsOf } from './calc/index.ts';
import type { TravelSample } from './calc/travel.ts';
import { dbFail, must } from './db.ts';
import { HttpError } from './errors.ts';
import { getEnv } from './env.ts';
import { approvedMlProfile, buildMlRequest, mayUseMl, previousDateKey, requestMlPrediction, type VerifiedMlProfile, type MlPrediction } from './prepare-ml.ts';
import { kakaoTravelMinutes, type FetchLike } from './kakao.ts';
import {
  computePlan,
  resolveBasics,
  sameDayWakesFromRows,
  type AlarmRow,
  type AppointmentRow,
  type ParticipantRow,
  type Plan,
  type PlanDraft,
  type PlanInputs,
  type PlanMode,
  type ProfileRow,
  type SameDayWakeRow,
} from './plan-core.ts';
import { resolveTravel, type ResolvedTravel, type TravelDeps } from './route.ts';
import type { Db } from './supabase.ts';
import { localDayRange, safeTimeZone } from './tz.ts';

export type PlanContext = {
  userId: string;
  db: Db; // 부른 사람의 RLS 클라이언트
  now: Date;
  kakaoKey?: string; // KAKAO_REST_API_KEY. 없으면 길찾기 단계를 건너뜀 (F10)
  fetchImpl?: FetchLike;
};

const DEFAULT_PROFILE: ProfileRow = {
  timezone: 'Asia/Seoul',
  default_buffer_minutes: 10,
  default_transport: 'TRANSIT',
  home_name: null,
  home_lat: null,
  home_lng: null,
  default_prepare_minutes: null,
  wake_sensitivity: 'NORMAL',
  wake_margin: 'NORMAL',
};

export const ALARM_COLUMNS =
  'alarm_id, participant_id, user_id, alarm_type, scheduled_at, intensity, voice_tone, sound_key, vibration, is_enabled, snooze_limit, time_source, intensity_source, recurrence_rule, original_scheduled_at, original_time_source';

export async function loadProfile(db: Db, userId: string): Promise<ProfileRow> {
  const row = must<ProfileRow | null>(
    'profiles',
    await db.from('profiles').select('timezone, default_buffer_minutes, default_transport, home_name, home_lat, home_lng, default_prepare_minutes, wake_sensitivity, wake_margin').eq('user_id', userId).maybeSingle(),
  );
  return row ?? DEFAULT_PROFILE;
}

export async function loadAppointment(db: Db, appointmentId: string): Promise<AppointmentRow | null> {
  return must<AppointmentRow | null>(
    'appointments',
    await db
      .from('appointments')
      .select('appointment_id, creator_id, group_id, title, appointment_at, dest_name, dest_lat, dest_lng, importance, recurrence_rule')
      .eq('appointment_id', appointmentId)
      .maybeSingle(),
  );
}

// 반복 회차의 기준이 되는 약속 (alarm-roll) — 묶음 · 날짜 · 메모 · 장소 반경까지 읽고, 만든 사람(creator_id)으로 좁힘
//   loadAppointment는 id만으로 읽어서 RLS가 거르는 부른 사람 클라이언트 전용. alarm-roll 배치는 service_role이라 RLS를 안 타므로 여기서 직접 좁힘
export type SeriesAppointmentRow = AppointmentRow & { series_id: string; occurrence_on: string; memo: string | null; dest_radius_m: number | null };

export const SERIES_APPOINTMENT_COLUMNS =
  'appointment_id, creator_id, group_id, title, appointment_at, dest_name, dest_lat, dest_lng, importance, recurrence_rule, series_id, occurrence_on, memo, dest_radius_m';

export async function loadSeriesAppointment(db: Db, creatorId: string, appointmentId: string): Promise<SeriesAppointmentRow | null> {
  return must<SeriesAppointmentRow | null>(
    'appointments',
    await db.from('appointments').select(SERIES_APPOINTMENT_COLUMNS).eq('appointment_id', appointmentId).eq('creator_id', creatorId).maybeSingle(),
  );
}

// 한 사람의 약속 여러 개를 한 번에 (배치가 이번에 볼 묶음의 기준 회차를 사람별로 묶어 읽음)
export async function loadSeriesAppointments(db: Db, creatorId: string, appointmentIds: readonly string[]): Promise<SeriesAppointmentRow[]> {
  if (!appointmentIds.length) return [];
  return must<SeriesAppointmentRow[]>(
    'appointments',
    await db.from('appointments').select(SERIES_APPOINTMENT_COLUMNS).eq('creator_id', creatorId).in('appointment_id', [...appointmentIds]),
  );
}

export async function loadParticipant(db: Db, appointmentId: string, userId: string): Promise<ParticipantRow | null> {
  return must<ParticipantRow | null>(
    'appointment_participants',
    await db
      .from('appointment_participants')
      .select('participant_id, appointment_id, user_id, origin_name, origin_lat, origin_lng, transport_type, est_travel_minutes, travel_source, prepare_minutes, buffer_minutes')
      .eq('appointment_id', appointmentId)
      .eq('user_id', userId)
      .maybeSingle(),
  );
}

// userId를 주면 그 사람의 알람으로 한 번 더 좁힘 (service_role로 읽는 alarm-roll 배치가 남의 행에 닿지 않게)
export async function loadAlarms(db: Db, participantId: string, userId?: string): Promise<AlarmRow[]> {
  const query = db.from('alarms').select(ALARM_COLUMNS).eq('participant_id', participantId);
  return must<AlarmRow[]>('alarms', await (userId ? query.eq('user_id', userId) : query));
}

// 예상 준비시간 통계 — 내 기상~출발 기록(daily_records.actual_prepare_minutes) 중 10~240분인 최근 30건 (학습 루프 기초 ③)
//   예전에는 뷰 v_prepare_time_stats(전체 기간 · 거르기 없음)를 읽었음. 뷰와 마이그레이션은 그대로 두고 쓰지 않음
//   기록은 하루 한 줄(record_date)이라 날짜 최신순 = 출발 최신순. 부른 사람의 RLS 클라이언트라 내 기록만 보이지만, 친구 기록을 읽는 정책이 생겨도 내 줄만 오게 user_id로 좁힘
//   n(sampleCount)도 같은 30건 기준 — P80은 calc의 percentile (선형 보간, 뷰의 percentile_cont(0.8)과 같은 방식)
export async function loadPrepareStats(db: Db, userId: string): Promise<PlanInputs['stats']> {
  const rows = must<{ actual_prepare_minutes: number | string | null }[]>(
    'daily_records',
    await db
      .from('daily_records')
      .select('actual_prepare_minutes')
      .eq('user_id', userId)
      .gte('actual_prepare_minutes', PREPARE_RECORD_MIN)
      .lte('actual_prepare_minutes', PREPARE_RECORD_MAX)
      .order('record_date', { ascending: false })
      .limit(PREPARE_WINDOW),
  );
  return prepareStatsOf(rows.map((r) => r.actual_prepare_minutes));
}

// 최근 4주 지각 횟수 (is_late). 늦잠이 원인인 지각만 세는 late_cause 칸은 DB에 없어서 지각 전체로 셈 — 문서 보완 목록
export async function loadLateCount(db: Db, userId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 28 * 24 * 3_600_000).toISOString();
  const { count, error } = await db
    .from('appointment_participants')
    .select('participant_id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('is_late', true)
    .gte('arrived_at', since);
  if (error) dbFail('late count', error);
  return count ?? 0;
}

// 그날(내 시간대 0시 기준) 이 약속보다 약속 시각이 앞선 내 참여에 켜진 기상 알람이 있는지 — 있으면 이 약속은 기상 없이 준비부터
//   내 참여 → 그 약속의 시각 + 기상 알람을 한 번에 읽고(임베드 appointments!inner · alarms!inner), 그날 전체를 가져와서 앞뒤 판정은 calc/wake.ts에 맡김
//   (알람이 울리는 시각이 아니라 약속 시각으로 가림 — 10시 약속의 8시 기상이 있는 날 8:30 약속은 그날 첫 일정)
export async function loadSameDayWake(db: Db, userId: string, at: Date, timeZone: string, ownAppointmentId?: string): Promise<boolean> {
  const { start, end } = localDayRange(at, timeZone);
  const rows = must<SameDayWakeRow[]>(
    'same-day wake',
    await db
      .from('appointment_participants')
      .select('appointment_id, appointments!inner(appointment_at), alarms!inner(is_enabled)')
      .eq('user_id', userId)
      .eq('alarms.alarm_type', 'WAKE')
      .gte('appointments.appointment_at', start.toISOString())
      .lt('appointments.appointment_at', end.toISOString()),
  );
  return hasEarlierWake(at, sameDayWakesFromRows(rows), ownAppointmentId);
}

// 내 지난 이동 기록 (출발 · 도착이 모두 찍힌 것) — 같은 경로 실측 중앙값용. alarm-suggest · alarm-commit은 읽기만 하고(CACHED로 쓰지 않음, D5),
// alarm-roll은 회차 길찾기가 12시간 전까지 안 될 때 이 중앙값을 CACHED로 저장함
//   이동 분은 appointment_participants.actual_travel_minutes(L2가 채움)가 있으면 그 값, 없으면 도착 − 출발 (calc/travel.ts는 두 시각의 차를 쓰므로
//   실측 분이 있는 줄은 도착을 출발 + 그 분으로 바꿔 넘김). 출발 · 도착이 모두 찍힌 줄만 읽는 조건은 그대로
export async function loadTravelSamples(db: Db, userId: string): Promise<TravelSample[]> {
  type Row = {
    origin_lat: number | string | null;
    origin_lng: number | string | null;
    transport_type: TravelSample['transport'];
    departed_at: string;
    arrived_at: string;
    actual_travel_minutes: number | string | null;
    appointments: { dest_lat: number | string | null; dest_lng: number | string | null } | { dest_lat: number | string | null; dest_lng: number | string | null }[] | null;
  };
  const rows = must<Row[]>(
    'travel samples',
    await db
      .from('appointment_participants')
      .select('origin_lat, origin_lng, transport_type, departed_at, arrived_at, actual_travel_minutes, appointments!inner(dest_lat, dest_lng)')
      .eq('user_id', userId)
      .not('departed_at', 'is', null)
      .not('arrived_at', 'is', null)
      .not('origin_lat', 'is', null)
      .order('arrived_at', { ascending: false })
      .limit(100),
  );
  const out: TravelSample[] = [];
  for (const r of rows) {
    const a = Array.isArray(r.appointments) ? r.appointments[0] : r.appointments;
    if (!a || r.origin_lat == null || r.origin_lng == null || a.dest_lat == null || a.dest_lng == null) continue;
    const departedAt = new Date(r.departed_at);
    const actual = r.actual_travel_minutes == null ? NaN : Number(r.actual_travel_minutes);
    out.push({
      origin: { lat: Number(r.origin_lat), lng: Number(r.origin_lng) },
      destination: { lat: Number(a.dest_lat), lng: Number(a.dest_lng) },
      transport: r.transport_type,
      departedAt,
      arrivedAt: Number.isFinite(actual) ? new Date(departedAt.getTime() + actual * 60_000) : new Date(r.arrived_at),
    });
  }
  return out;
}

export type BuiltPlan = { plan: Plan; inputs: PlanInputs; timeZone: string };

// 이동시간을 구할 길이 없을 때(좌표가 없고 직접 입력도 없음) — 7.1.2의 마지막 단계(직접 입력)로 가야 하는 상태
//   alarm-commit은 이 오류(502 ROUTE_UNAVAILABLE, details.manual_required)를 그대로 돌려주고,
//   alarm-suggest(미리 보기)는 잡아서 오류 대신 "이동시간만 직접 입력해 주세요"인 200 응답으로 바꿈 (toTravelRequiredSuggestion)
export class TravelRequiredError extends HttpError {
  readonly inputs: PlanInputs;
  readonly travel: ResolvedTravel;
  readonly timeZone: string;

  constructor(inputs: PlanInputs, travel: ResolvedTravel, timeZone: string) {
    super('ROUTE_UNAVAILABLE', '이동시간을 구하지 못했어요. 직접 입력해 주세요', { manual_required: true, warnings: travel.warnings });
    this.name = 'TravelRequiredError';
    this.inputs = inputs;
    this.travel = travel;
    this.timeZone = timeZone;
  }
}

// CatBoost is experimental and off by default. Nothing is sent until both the
// feature flag and verified, persisted survey codes exist. All failures fall
// back to the original P80-based preparation-time calculation.
async function optionalMlPrediction(
  ctx: PlanContext,
  at: Date,
  timeZone: string,
  allow: boolean,
): Promise<MlPrediction | undefined> {
  if (!mayUseMl({
    enabled: getEnv('PREPARE_ML_ENABLED') === '1',
    allowForPlan: allow,
    userId: ctx.userId,
    allowedUserIds: getEnv('PREPARE_ML_ALLOWED_USER_IDS'),
  })) return undefined;
  const url = getEnv('PREPARE_ML_URL');
  const token = getEnv('PREPARE_ML_API_TOKEN');
  if (!url || !token) return undefined;

  try {
    // Never trust client-writable profiles.ml_* fields. The separate table
    // is readable only by service_role; this is reached only after auth +
    // exact user UUID allowlist. Match an explicitly approved codebook version.
    // Lazily load Deno's npm: Supabase client only when ML is actually enabled.
    // Plan calculation and FakeDb regression tests run in Node without npm: support.
    const { createServiceClient } = await import('./supabase.ts');
    const { data: row, error: profileError } = await createServiceClient()
      .from('prepare_ml_verified_profiles')
      .select('ml_age_code, ml_education_code, ml_economic_code, codebook_version, consent_at, verified_at')
      .eq('user_id', ctx.userId).maybeSingle();
    if (profileError || !row) return undefined;
    const verified = approvedMlProfile(row as VerifiedMlProfile, getEnv('PREPARE_ML_CODEBOOK_VERSION'));
    if (!verified) return undefined;

    // Crucial: use the record from EXACTLY the preceding local calendar day.
    // Unlike loadPrepareStats(), it is NOT the latest arbitrary history item.
    const { data: previous, error: previousError } = await ctx.db.from('daily_records')
      .select('actual_prepare_minutes')
      .eq('user_id', ctx.userId)
      .eq('record_date', previousDateKey(at, timeZone))
      .maybeSingle();
    // Do not turn a query failure into a fabricated zero-minute warm-start input.
    const minutes = previousError || previous?.actual_prepare_minutes == null
      ? null
      : Number(previous.actual_prepare_minutes);
    const request = buildMlRequest({ appointmentAt: at, timezone: timeZone, profile: verified, previousDayMinutes: minutes });
    if (!request) return undefined;
    return (await requestMlPrediction(request, { enabled: true, url, token })) ?? undefined;
  } catch {
    return undefined; // Missing migration, API offline, timeout etc.
  }
}

// wantAutoTravel: 직접 입력한 이동시간이 있어도 자동 값을 같이 구함 (H03 "자동으로 되돌리기" 미리 보기). 호출이 한 번 늘어남
// mode: 어느 쪽에서 부르는지. preview(alarm-suggest)는 경고를 "저장할 때 …" 말투로, save(alarm-commit, 기본)는 저장한 뒤 말투로
export async function buildPlan(ctx: PlanContext, draft: PlanDraft, options: { wantAutoTravel?: boolean; mode?: PlanMode } = {}): Promise<BuiltPlan> {
  const profile = await loadProfile(ctx.db, ctx.userId);
  const timeZone = safeTimeZone(profile.timezone);

  let appointment: AppointmentRow | undefined;
  let participant: ParticipantRow | undefined;
  let existingAlarms: AlarmRow[] = [];
  if (draft.appointmentId) {
    // RLS가 거르므로 내 일정이거나 내가 참여 중인 그룹 일정만 보임
    appointment = (await loadAppointment(ctx.db, draft.appointmentId)) ?? undefined;
    if (!appointment) throw new HttpError('NOT_FOUND', '일정을 찾을 수 없어요');
    participant = (await loadParticipant(ctx.db, appointment.appointment_id, ctx.userId)) ?? undefined;
    if (participant) existingAlarms = await loadAlarms(ctx.db, participant.participant_id);
  }

  const basics = resolveBasics({ draft, profile, appointment, participant });
  const [stats, lateCount4w, sameDayWake] = await Promise.all([
    loadPrepareStats(ctx.db, ctx.userId),
    loadLateCount(ctx.db, ctx.userId, ctx.now),
    draft.withWake != null ? Promise.resolve(!draft.withWake) : loadSameDayWake(ctx.db, ctx.userId, basics.at, timeZone, appointment?.appointment_id),
  ]);

  const inputs: PlanInputs = { now: ctx.now, draft, profile, appointment, participant, existingAlarms, stats, lateCount4w, sameDayWake };

  // 요청에 이동시간이 없고 저장된 게 직접 입력(MANUAL)이면 그대로 이어받음 — 시각 · 강도의 직접 값과 같은 규칙(D42 C). 길찾기를 다시 안 부름
  //   API로 저장된 값은 D5(카카오 응답 저장 · 재사용 불허) 때문에 이어받지 않고 다시 구함
  const keptManualMinutes = draft.travelMinutes == null && participant?.travel_source === 'MANUAL' ? (participant.est_travel_minutes ?? undefined) : undefined;

  let travel: ResolvedTravel;
  if (draft.travelMinutes != null && draft.travelSource === 'API') {
    // 앱이 확인 시트에서 보여 준 길찾기 값을 그대로 저장 — 다시 부르지 않음
    const chosen = { minutes: draft.travelMinutes, source: 'API' as const, needsConfirmation: false, note: '길찾기 기준' };
    travel = { chosen, auto: chosen, warnings: [] };
  } else {
    const deps: TravelDeps = {
      ...(ctx.kakaoKey ? { kakao: (a) => kakaoTravelMinutes(ctx.kakaoKey as string, a, ctx.fetchImpl) } : {}),
      samples: () => loadTravelSamples(ctx.db, ctx.userId),
    };
    const coords = (p: { lat?: number; lng?: number }) => (p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : undefined);
    travel = await resolveTravel(
      { origin: coords(basics.origin), destination: coords(basics.destination), transport: basics.transport, override: draft.travelMinutes ?? keptManualMinutes },
      deps,
      { wantAuto: options.wantAutoTravel },
    );
  }

  // 길찾기도 같은 경로 기록도 근사값도 없음 → 직접 입력하는 흐름으로 (8장 8.2.2)
  if (!travel.chosen) throw new TravelRequiredError(inputs, travel, timeZone);
  // Keep manual prepare settings and already-awake schedules on the existing path.
  const allowMl = draft.prepareMinutes == null && draft.withWake !== false &&
    !(draft.withWake == null && sameDayWake);
  inputs.mlPrediction = await optionalMlPrediction(ctx, basics.at, timeZone, allowMl);
  return { plan: computePlan(inputs, travel, options.mode), inputs, timeZone };
}
