// appointment-edit이 DB를 읽고 쓰는 부분 — 일정 고치기 · 지우기 · 되돌리기 · 공동 약속에서 빠지기 (L1 PR 4b, 이슈 #276)
//   계산(어떤 범위가 무엇을 하는가 · 바뀌는 알람 · 확인 · 7.1.3 재판정)은 edit.ts(순수), 알람 시각 계산은 plan-core.ts computePlan · commit-core.ts diffAlarms 그대로 (alarm-commit과 같은 규칙)
//   Deno.serve 없이 모듈로 빼서 가짜 DB로 시험함 (edit-run.test.ts)
// 읽기 · 쓰기 모두 부른 사람의 RLS 클라이언트(userDb)로 함 — 남의 약속은 애초에 안 보이고 못 고침. service 클라이언트는 셋뿐:
//   (1) roll_attempts 정리 (service 전용 표) (2) 공동 약속을 지울 때 다른 참여자의 출발 · 도착 기록 확인 (RLS로는 내 참여만 보임)
//   (3) 공동 약속의 시각 · 장소를 만든 사람이 고칠 때 다른 참여자의 참여 조건 · 알람을 읽고 다시 계산해 씀(참여자별 userId로 좁혀서) + 푸시 (9장)
// supabase-js에는 트랜잭션이 없어 같은 요청을 다시 보내면 이어서 맞춰지는 순서로 씀:
//   고치기 = (이후 모두면) 뒤 회차 지우기 → 참여 조건 → 알람 → 약속 행 마지막 / 지우기(이후 모두) = 뒤 회차 → 규칙 비우기 → 이 행 마지막
//   약속 행을 마지막에 쓰는 이유: 앞에서 실패해도 약속 행이 안 바뀌어 있어 다시 보내면 고칠 것이 그대로 보임
// 하루 경계는 profiles.timezone(없으면 Asia/Seoul) 0시 (tz.ts)
import { hasEarlierWake, isEveningWake, type SameDayWake } from './calc/index.ts';
import { diffAlarms, type AlarmDiff, type AlarmWrite } from './commit-core.ts';
import { summarize } from './commit.ts';
import { must } from './db.ts';
import {
  alarmChanges,
  CONFIRM_MOVE_MINUTES,
  applyPatch,
  byTimeThenId,
  deleteMode,
  editorVerdict,
  laterRowsToDelete,
  needsConfirm,
  scopeEffect,
  wakeAction,
  wakesOfRows,
  type AlarmChangeLine,
  type DayWakeRow,
  type ExceptionKind,
  type SeriesRow,
} from './edit.ts';
import type { EditRequest } from './edit-request.ts';
import { HttpError } from './errors.ts';
import { loadAlarms, loadLateCount, loadParticipant, loadPrepareStats, loadProfile, loadTravelSamples, loadPurePrepCandidate, ALARM_COLUMNS, SERIES_APPOINTMENT_COLUMNS, type SeriesAppointmentRow } from './plan.ts';
import { computePlan, purePrepPersistenceOf, firstPrepareMinutes, resolveBasics, withoutFriendTimes, type AlarmRow, type AppointmentRow, type ParticipantRow, type Plan, type PlanInputs, type ProfileRow } from './plan-core.ts';
import { buildRingPackages, canceledAlarmIds, subtitleFor, type RingPackage } from './ring-package.ts';
import { planGroupPush, sendGroupPush, type GroupPlan, type NotifyOptions } from './notify.ts';
import { resolveTravel, type TravelChoice, type TravelDeps } from './route.ts';
import { inheritedKinds, resolvedTravelOf, shiftManualTimes } from './roll.ts';
import type { Db } from './supabase.ts';
import { localDateKey, localDayRange, safeTimeZone } from './tz.ts';

export type EditCtx = {
  userId: string; // 검증한 로그인 사용자 (요청 본문에서 받지 않음)
  userDb: Db; // 부른 사람의 RLS 클라이언트 — 읽기 · 쓰기 모두
  service: Db; // service_role — roll_attempts 정리 · 공동 약속 기록 확인 · 공동 약속 고치기의 참여자 동기화 · 푸시만
  now: Date;
  kakao?: TravelDeps['kakao']; // 장소를 바꿀 때만 씀. 키가 없으면 안 줌
  push?: NotifyOptions; // 공동 약속 푸시를 보낼 때(Expo 액세스 토큰 등). 시험은 가짜 fetch
};

export type EditWarning = { code: string; message: string; detail?: string };

// 모든 응답이 공통으로 가짐 — 앱 applyCommit({ ring_packages, canceled_alarm_ids })이 그대로 받음 (alarm-commit과 같은 이름 · 모양)
type Common = {
  appointment_id: string;
  ring_packages: RingPackage[]; // 폰에 걸 예약 (고친 일정 + 7.1.3으로 다시 판정한 같은 날 다른 일정)
  canceled_alarm_ids: string[]; // 폰에서 지울 예약 (지워졌거나 꺼진 알람, 지운 뒤 회차의 알람)
  warnings: EditWarning[];
};

// 공동 약속 시각 · 장소를 고쳤을 때 다른 참여자들의 알람이 어떻게 됐나 — 사람 이름 없이 개수만 (updated = 바로 맞춤 · 계산을 못 해 약속이 옮겨진 만큼 같이 옮김, held = 5분 이상 늦춰져 그 사람의 확인을 기다림, skipped = 다시 계산하지 못해 그대로)
export type ParticipantSync = { updated: number; held: number; skipped: number };

export type UpdateResponse = Common & {
  saved: boolean; // false = 늦춰지는 알람이 있어 확인이 먼저 (아직 저장 안 함, needs_confirm true) → 확인 뒤 confirmed: true로 같은 요청을 다시
  needs_confirm: boolean;
  changes: AlarmChangeLine[];
  alarms: ReturnType<typeof summarize>[];
  deleted_appointment_ids: string[]; // 이후 모두 고치기가 지운 뒤 회차
  participants?: ParticipantSync; // 공동 약속의 시각 · 장소를 고쳤을 때만
  notified?: number; // 공동 약속 변경 푸시를 받은 기기 수 (보냈을 때만)
};

export type DeleteResponse = Common & {
  deleted: boolean;
  mode: 'ROW' | 'CANCEL_THIS' | 'FROM_HERE' | 'NONE'; // NONE = 이미 없음(같은 요청을 두 번 보내면 두 번째)
  deleted_appointment_ids: string[];
  notified?: number; // 공동 약속 취소 푸시를 받은 기기 수 (앞으로 약속을 지웠을 때만)
};

export type RestoreResponse = Common & { restored: boolean; reason?: 'NOT_FOUND' | 'NOT_DELETED' };
export type LeaveResponse = Common & { left: boolean };

// ---------------------------------------------------------------------------
// 읽기 도우미
// ---------------------------------------------------------------------------

type EditRow = SeriesAppointmentRow & { exception_kind: ExceptionKind | null };
const APPOINTMENT_COLUMNS = `${SERIES_APPOINTMENT_COLUMNS}, exception_kind`;
const PARTICIPANT_COLUMNS = 'participant_id, appointment_id, user_id, origin_name, origin_lat, origin_lng, transport_type, est_travel_minutes, travel_source, prepare_minutes, prepare_value_source, buffer_minutes, prepare_advance_minutes';

type Target = { appointment: EditRow; participant: ParticipantRow | null; alarms: AlarmRow[] };
type DayRow = { appointment: EditRow; participant: ParticipantRow; alarms: AlarmRow[] };

const common = (id: string): Common => ({ appointment_id: id, ring_packages: [], canceled_alarm_ids: [], warnings: [] });
const wakeOf = (alarms: readonly AlarmRow[]) => alarms.find((a) => a.alarm_type === 'WAKE');
const ids = (rows: readonly { alarm_id: string }[]) => rows.map((a) => a.alarm_id);
const unique = (list: readonly string[]) => [...new Set(list)];

async function loadTarget(ctx: EditCtx, appointmentId: string): Promise<Target | null> {
  const appointment = must<EditRow | null>('appointments', await ctx.userDb.from('appointments').select(APPOINTMENT_COLUMNS).eq('appointment_id', appointmentId).maybeSingle());
  if (!appointment) return null; // 없거나 내게 안 보임 (RLS) — 구분하지 않음
  const participant = await loadParticipant(ctx.userDb, appointmentId, ctx.userId);
  const alarms = participant ? await loadAlarms(ctx.userDb, participant.participant_id, ctx.userId) : [];
  return { appointment, participant, alarms };
}

// 계산에 쓰는 사용자 값 (프로필 · 준비시간 통계 · 지각 횟수) — 한 요청에서 처음 쓸 때 한 번 읽음
class Env {
  private ctx: EditCtx;
  private cache = new Map<string, Promise<unknown>>();
  constructor(ctx: EditCtx) {
    this.ctx = ctx;
  }
  private memo<T>(key: string, load: () => Promise<T>): Promise<T> {
    let hit = this.cache.get(key) as Promise<T> | undefined;
    if (!hit) {
      hit = load();
      this.cache.set(key, hit);
    }
    return hit;
  }
  profile(): Promise<ProfileRow> {
    return this.memo('profile', () => loadProfile(this.ctx.userDb, this.ctx.userId));
  }
  async tz(): Promise<string> {
    return safeTimeZone((await this.profile()).timezone);
  }
  stats() {
    return this.memo('stats', () => loadPrepareStats(this.ctx.userDb, this.ctx.userId));
  }
  late() {
    return this.memo('late', () => loadLateCount(this.ctx.userDb, this.ctx.userId, this.ctx.now));
  }
}

// 그날(내 시간대 0시 기준) 내 참여 약속 — 약속 + 내 참여 조건 + 내 알람. 이번만 지운(CANCELED) 회차는 알람이 없고 숨김이라 뺌
async function readDay(ctx: EditCtx, tz: string, instant: Date): Promise<DayRow[]> {
  const { start, end } = localDayRange(instant, tz);
  type Joined = ParticipantRow & { appointments: EditRow | EditRow[] | null };
  const joined = must<Joined[]>(
    'day participants',
    await ctx.userDb
      .from('appointment_participants')
      .select(`${PARTICIPANT_COLUMNS}, appointments!inner(${APPOINTMENT_COLUMNS})`)
      .eq('user_id', ctx.userId)
      .gte('appointments.appointment_at', start.toISOString())
      .lt('appointments.appointment_at', end.toISOString()),
  );
  const rows = joined.flatMap((j): { appointment: EditRow; participant: ParticipantRow }[] => {
    const appointment = Array.isArray(j.appointments) ? j.appointments[0] : j.appointments;
    if (!appointment || appointment.exception_kind === 'CANCELED') return [];
    const { appointments: _embedded, ...participant } = j;
    return [{ appointment, participant }];
  });
  if (!rows.length) return [];
  const alarms = must<AlarmRow[]>('day alarms', await ctx.userDb.from('alarms').select(ALARM_COLUMNS).eq('user_id', ctx.userId).in('participant_id', rows.map((r) => r.participant.participant_id)));
  return rows.map((r) => ({ ...r, alarms: alarms.filter((a) => a.participant_id === r.participant.participant_id) }));
}

const dayWakeRow = (r: DayRow): DayWakeRow => ({ id: r.appointment.appointment_id, at: new Date(r.appointment.appointment_at), wakeEnabled: wakeOf(r.alarms)?.is_enabled ?? null });

// 바꾸기 전의 날들을 읽어 둠 — 7.1.3 재판정이 "전에는 앞 기상에 밀려 있었나"를 이것으로 가림. 키 = 내 시간대 날짜
async function snapshotDays(ctx: EditCtx, env: Env, instants: readonly Date[]): Promise<{ days: Map<string, DayRow[]>; instants: Map<string, Date> }> {
  const tz = await env.tz();
  const byKey = new Map<string, Date>();
  for (const at of instants) byKey.set(localDateKey(at, tz), at);
  const days = new Map<string, DayRow[]>();
  for (const [key, at] of byKey) days.set(key, await readDay(ctx, tz, at));
  return { days, instants: byKey };
}
type Snapshot = Awaited<ReturnType<typeof snapshotDays>>;

// 이 회차들 중 내 출발 · 도착 기록이 있는 것 (지난 회차는 기록으로 남김)
async function recordIdsOf(ctx: EditCtx, appointmentIds: readonly string[]): Promise<Set<string>> {
  if (!appointmentIds.length) return new Set();
  const out = new Set<string>();
  for (const column of ['departed_at', 'arrived_at'] as const) {
    const rows = must<{ appointment_id: string }[]>(
      'records',
      await ctx.userDb.from('appointment_participants').select('appointment_id').eq('user_id', ctx.userId).in('appointment_id', [...appointmentIds]).not(column, 'is', null),
    );
    for (const r of rows) out.add(r.appointment_id);
  }
  return out;
}

// 공동 약속은 다른 참여자의 기록도 확인 (RLS로는 내 참여만 보여서 service로)
async function sharedRecordExists(ctx: EditCtx, appointmentId: string): Promise<boolean> {
  for (const column of ['departed_at', 'arrived_at'] as const) {
    const rows = must<{ participant_id: string }[]>('shared records', await ctx.service.from('appointment_participants').select('participant_id').eq('appointment_id', appointmentId).not(column, 'is', null));
    if (rows.length) return true;
  }
  return false;
}

async function seriesRows(ctx: EditCtx, row: Pick<EditRow, 'series_id'>): Promise<SeriesRow[]> {
  return must<SeriesRow[]>(
    'series rows',
    await ctx.userDb.from('appointments').select('appointment_id, occurrence_on, appointment_at, exception_kind').eq('creator_id', ctx.userId).eq('series_id', row.series_id),
  );
}

// ---------------------------------------------------------------------------
// 쓰기 도우미
// ---------------------------------------------------------------------------

// 알람 고치기 → 만들기 → 지우기 순 (commit.ts persistAppointment와 같음 — 중간에 실패해도 있던 알람이 먼저 사라지지 않게). 돌려주는 값 = 고친 뒤 알람 전체
async function applyAlarmDiff(ctx: EditCtx, participantId: string, diff: AlarmDiff, existing: readonly AlarmRow[]): Promise<AlarmRow[]> {
  const touched: AlarmRow[] = [];
  for (const u of diff.update) {
    touched.push(must<AlarmRow>('alarms update', await ctx.userDb.from('alarms').update(u.patch).eq('alarm_id', u.alarm_id).eq('user_id', ctx.userId).select(ALARM_COLUMNS).single()));
  }
  if (diff.insert.length) {
    const rows = diff.insert.map((w) => ({ ...w, user_id: ctx.userId, participant_id: participantId }));
    touched.push(...must<AlarmRow[]>('alarms insert', await ctx.userDb.from('alarms').insert(rows).select(ALARM_COLUMNS)));
  }
  if (diff.remove.length) must('alarms delete', await ctx.userDb.from('alarms').delete().in('alarm_id', diff.remove).eq('user_id', ctx.userId));
  return [...touched, ...existing.filter((a) => !diff.remove.includes(a.alarm_id) && !diff.update.some((u) => u.alarm_id === a.alarm_id))];
}

// 약속 행 고치기 — 내가 만든 행 하나가 정확히 고쳐져야 함
async function updateRow(ctx: EditCtx, appointmentId: string, patch: Record<string, unknown>, creatorId: string | null = ctx.userId) {
  const query = ctx.userDb.from('appointments').update(patch).eq('appointment_id', appointmentId);
  const done = must<{ appointment_id: string }[]>('appointments update', await (creatorId == null ? query.is('creator_id', null) : query.eq('creator_id', creatorId)).select('appointment_id'));
  if (done.length !== 1) throw new HttpError('NOT_FOUND', '일정을 찾을 수 없어요');
}

// 공동 약속을 고치거나 지우려면 지금 그 그룹에 참여 중이어야 함. 나갔거나 내보내진 만든 사람은 만든 사람 경로로 약속이 아직 보이고 editorVerdict도 통과하는데,
//   약속 행 쓰기는 RLS가 막으므로(is_group_member) 그 전에 service로 다른 참여자의 알람을 먼저 바꾸는 일이 없게 쓰기 전에 확인함 (9장 PR 리뷰)
async function assertGroupMember(ctx: EditCtx, row: { group_id: string | null }): Promise<void> {
  if (row.group_id == null) return;
  const mine = must<{ user_id: string }[]>(
    'group member',
    await ctx.userDb.from('group_members').select('user_id').eq('group_id', row.group_id).eq('user_id', ctx.userId).eq('invite_status', 'JOINED').limit(1),
  );
  if (!mine.length) throw new HttpError('NOT_FOUND', '일정을 찾을 수 없어요');
}

// 약속 행들을 지움 (참여 조건 · 알람은 CASCADE). 돌려주는 값 = 지워지는 내 알람 id (폰에서 지울 예약)
//   creatorId = 지울 행의 만든 사람 — 내가 만든 약속은 내 id, 만든 사람이 비어 있는(탈퇴한) 공동 약속은 null (참여자가 지움, DB 정책 appointments_delete_creator가 참여 중인 그룹원에게만 열어 둠)
async function deleteRows(ctx: EditCtx, appointmentIds: readonly string[], creatorId: string | null = ctx.userId): Promise<string[]> {
  if (!appointmentIds.length) return [];
  const list = [...appointmentIds];
  const participants = must<{ participant_id: string }[]>('participants', await ctx.userDb.from('appointment_participants').select('participant_id').eq('user_id', ctx.userId).in('appointment_id', list));
  const alarmIds = participants.length
    ? ids(must<{ alarm_id: string }[]>('alarms', await ctx.userDb.from('alarms').select('alarm_id').eq('user_id', ctx.userId).in('participant_id', participants.map((p) => p.participant_id))))
    : [];
  const del = ctx.userDb.from('appointments').delete().in('appointment_id', list);
  if (creatorId == null) {
    // 만든 사람이 빈 약속은 RLS 정책(참여자 · 안 지난 약속)만이 조건을 걸어 막혀도 오류 없이 0행 — 지운 줄 알고 성공으로 돌려주지 않게 지운 행 수를 확인
    const gone = must<{ appointment_id: string }[]>('appointments delete', await del.is('creator_id', null).select('appointment_id'));
    if (gone.length !== list.length) throw new HttpError('FORBIDDEN', '이 약속은 지울 수 없어요');
  } else {
    must('appointments delete', await del.eq('creator_id', creatorId));
  }
  return alarmIds;
}

// 응답 마무리 — 폰에 걸 예약(ring_packages)과 지울 예약(canceled_alarm_ids)이 겹치지 않게: 같은 알람이 여러 번 실렸으면(고친 일정이 7.1.3 재판정으로 한 번 더 계산됨) 마지막 것만,
//   지워진 알람은 걸 예약에서 뺌. 시각 순으로 정렬
function settle<T extends { ring_packages: RingPackage[]; canceled_alarm_ids: string[] }>(result: T, canceled: readonly string[]): T {
  const gone = new Set(canceled);
  const last = new Map<string, RingPackage>();
  for (const p of result.ring_packages) last.set(p.alarmId, p);
  result.ring_packages = [...last.values()].filter((p) => !gone.has(p.alarmId)).sort((a, b) => a.atMillis - b.atMillis);
  result.canceled_alarm_ids = [...gone];
  return result;
}

const storedTravel = (p: ParticipantRow): TravelChoice | null =>
  p.est_travel_minutes == null ? null : { minutes: p.est_travel_minutes, source: p.travel_source, needsConfirmation: false, note: '저장된 이동시간' };

const packagesOf = (args: { alarms: readonly AlarmRow[]; appointment: Pick<EditRow, 'title' | 'dest_name'>; at: Date; tz: string; travelMinutes: number | null; departAt?: Date }): RingPackage[] =>
  buildRingPackages({
    alarms: args.alarms,
    title: args.appointment.title,
    subtitle: subtitleFor(args.at, args.appointment.dest_name, args.tz),
    ...(args.departAt ? { departAt: args.departAt } : {}),
    appointment: { appointmentAt: args.at, travelMinutes: args.travelMinutes, timeZone: args.tz },
  });

// ---------------------------------------------------------------------------
// 7.1.3 재판정 — 앞 일정이 바뀌거나 지워지면 같은 날 다음 일정의 기상 알람을 다시 정함
// ---------------------------------------------------------------------------

// 고친 뒤(또는 지운 뒤) 영향받은 날들을 다시 읽어, 그날 약속을 시각 순으로 보며 기상이 붙고 떨어져야 하는 일정만 다시 계산해 씀.
//   고친 일정 자신도 같이 봄 — 그날 다른 일정의 기상이 바뀌면 고친 일정의 기상도 달라질 수 있어서(예: 뒤로 옮겼더니 옛 첫 일정이 다시 첫 일정). 판정은 edit.ts wakeAction → calc/wake.ts hasEarlierWake (alarm-commit · 앱 목업과 같은 판정)
//   이동시간은 저장된 값을 그대로 (길찾기를 새로 안 부름). 다시 계산이 안 되면(출발 시각 지남 · 이동시간 없음) 그 일정은 그대로 두고 경고만
async function reevaluateWake(ctx: EditCtx, env: Env, snapshot: Snapshot): Promise<{ ring_packages: RingPackage[]; canceled_alarm_ids: string[]; warnings: EditWarning[] }> {
  const out = { ring_packages: [] as RingPackage[], canceled_alarm_ids: [] as string[], warnings: [] as EditWarning[] };
  const tz = await env.tz();
  for (const [key, instant] of snapshot.instants) {
    const beforeWakes = wakesOfRows((snapshot.days.get(key) ?? []).map(dayWakeRow));
    const after = (await readDay(ctx, tz, instant)).sort((a, b) => byTimeThenId(dayWakeRow(a), dayWakeRow(b)));
    const sim: SameDayWake[] = [];
    for (const row of after) {
      const row_id = row.appointment.appointment_id;
      const at = new Date(row.appointment.appointment_at);
      let finalWake: boolean | null = wakeOf(row.alarms)?.is_enabled ?? null;
      const hasRing = row.alarms.some((a) => a.alarm_type !== 'ROUTINE');
      if (hasRing) {
        // 울릴 시각이 이미 지난 기상 알람은 REMOVE 대상에서 뺌 — 울린 기록이 학습 · 미루기 근거라 알람 행을 지우지 않음 (edit.ts wakeAction)
        const wake = wakeOf(row.alarms);
        const wakeRung = wake != null && Date.parse(wake.scheduled_at) <= ctx.now.getTime();
        const { action, earlierAfter } = wakeAction({ id: row_id, at, hasWake: wake != null, wakeRung, beforeWakes, sim });
        if (action !== 'NONE') {
          const done = await replanForWake(ctx, env, row, earlierAfter);
          if (done.ok) {
            out.ring_packages.push(...done.ring_packages);
            out.canceled_alarm_ids.push(...done.canceled_alarm_ids);
            finalWake = wakeOf(done.after)?.is_enabled ?? null;
          } else {
            out.warnings.push({ code: 'WAKE_REEVAL_SKIPPED', message: '같은 날 다른 일정의 기상 알람을 다시 정하지 못했어요', detail: done.reason });
          }
        }
      }
      if (finalWake != null) sim.push({ appointmentId: row_id, appointmentAt: at, isEnabled: finalWake });
    }
  }
  out.canceled_alarm_ids = unique(out.canceled_alarm_ids);
  return out;
}

async function replanForWake(
  ctx: EditCtx,
  env: Env,
  row: DayRow,
  earlierAfter: boolean,
): Promise<{ ok: true; after: AlarmRow[]; ring_packages: RingPackage[]; canceled_alarm_ids: string[] } | { ok: false; reason: string }> {
  const travel = storedTravel(row.participant);
  if (!travel) return { ok: false, reason: 'NO_TRAVEL' };
  const [profile, stats, lateCount4w] = await Promise.all([env.profile(), env.stats(), env.late()]);
  const tz = safeTimeZone(profile.timezone);
  const inputs: PlanInputs = {
    now: ctx.now,
    // 기상이 붙는 쪽(ADD)은 "밀려서 없던" 일정이므로 기상을 더해 줌, 떨어지는 쪽(REMOVE)은 기존 종류 그대로 두고 기상만 빠짐 (inheritedKinds)
    draft: { kinds: inheritedKinds(row.alarms, { withWake: !earlierAfter, baseHadEarlierWake: true }) },
    profile,
    appointment: row.appointment,
    participant: row.participant,
    existingAlarms: row.alarms,
    stats,
    lateCount4w,
    sameDayWake: earlierAfter,
    purePrepCandidate: row.appointment.group_id == null && row.participant.user_id === ctx.userId
      ? await loadPurePrepCandidate(ctx.userDb, ctx.userId, profile, ctx.now, new Date(row.appointment.appointment_at))
      : undefined,
  };
  const plan = computePlan(inputs, resolvedTravelOf(travel), 'save');
  if (!plan.check.ok) return { ok: false, reason: plan.check.reason };
  const diff = diffAlarms(plan, row.alarms, { now: ctx.now, replaceExisting: true });
  must(
    'appointment_participants update',
    await ctx.userDb.from('appointment_participants').update({ prepare_minutes: plan.prepare.minutes, ...purePrepPersistenceOf(plan, inputs.purePrepCandidate) }).eq('participant_id', row.participant.participant_id).eq('user_id', ctx.userId),
  );
  const after = await applyAlarmDiff(ctx, row.participant.participant_id, diff, row.alarms);
  return {
    ok: true,
    after,
    ring_packages: packagesOf({ alarms: after, appointment: row.appointment, at: new Date(row.appointment.appointment_at), tz, travelMinutes: plan.travelMinutes, departAt: plan.departure }),
    canceled_alarm_ids: canceledAlarmIds({ before: row.alarms, after }),
  };
}

// ---------------------------------------------------------------------------
// 고치기
// ---------------------------------------------------------------------------

function assertEditor(target: Target | null, ctx: EditCtx, verb: '고칠' | '지울'): asserts target is Target {
  const verdict = editorVerdict({ row: target?.appointment ?? null, userId: ctx.userId, participating: target?.participant != null });
  if (verdict === 'NOT_VISIBLE') throw new HttpError('NOT_FOUND', '일정을 찾을 수 없어요');
  if (verdict === 'NOT_CREATOR') {
    // L6 안건후보: 공동 약속을 참여만 한 사람이 고치기 · 지우기를 하면 기본안 = 거절 (만든 사람만). 참여자는 "나는 빠지기"(LEAVE)
    throw new HttpError('FORBIDDEN', `공동 약속은 만든 사람만 ${verb} 수 있어요. 나는 빠지기를 써 주세요`);
  }
}

// 고친 약속으로 한 참여자의 알람을 다시 계산함 (쓰지는 않음). 부른 사람(만든 사람)과 공동 약속의 다른 참여자가 같은 계산을 씀 — 다른 참여자는 ctx를 그 사람 몫(userId · userDb)으로 바꿔서 부름
//   장소가 바뀌면 길찾기를 새로 부르고 안 되면 ROUTE_UNAVAILABLE을 던짐(호출한 쪽이 처리)
async function replanFor(
  ctx: EditCtx,
  env: Env,
  a: { row: EditRow; patched: ReturnType<typeof applyPatch>; participant: ParticipantRow; alarms: AlarmRow[]; snapshot: Snapshot; excluded: ReadonlySet<string>; oldAt: Date; newAt: Date; tz: string },
): Promise<{ plan: Plan; purePrepCandidate?: PlanInputs['purePrepCandidate']; diff: AlarmDiff; changes: AlarmChangeLine[]; warnings: EditWarning[] }> {
  const { row, patched, participant, alarms, snapshot, excluded, oldAt, newAt, tz } = a;
  const warnings: EditWarning[] = [];
  const patchedRow: AppointmentRow = { ...row, ...patched.next, recurrence_rule: row.recurrence_rule };
  const newDay = snapshot.days.get(localDateKey(newAt, tz)) ?? [];
  const oldDay = snapshot.days.get(localDateKey(oldAt, tz)) ?? [];
  const sameDayWake = hasEarlierWake(newAt, wakesOfRows(newDay.filter((r) => !excluded.has(r.appointment.appointment_id)).map(dayWakeRow)), row.appointment_id);
  // 기상이 없던 이유가 "앞 기상에 밀려서"만이 아님 — 저녁 일정은 계산된 기상이 낮 12시 이후라 기상을 안 만듦(plan-core.ts, #320). 저녁 일정을 아침으로 옮기면 기상이 붙어야 하므로 같이 "밀려서 없던 것"으로 봄
  //   L6 안건후보: 기상 없는 일정을 고칠 때 기본안 = 옛 시각의 **계산된** 기상(옛 이동 · 여유 + 기상 있는 첫 준비값)이 낮 12시 이후였으면 규칙 때문에 없던 것이라 다시 계산하고,
  //   12시 전이었는데 기상이 없으면 사용자가 일부러 끈 것이라 그대로 둠 (헤드 확정 10/30 — 13:00 일정에서 끈 기상이 장소만 고쳐도 되살아나던 것, 리뷰 F1)
  const oldFirstPrepare = firstPrepareMinutes(await env.profile());
  const oldWakeAt = new Date(oldAt.getTime() - ((participant.buffer_minutes ?? 0) + (participant.est_travel_minutes ?? 0) + oldFirstPrepare) * 60_000);
  const hadNoWakeInEvening =
    alarms.some((x) => x.alarm_type === 'PREPARE' || x.alarm_type === 'DEPARTURE') && !alarms.some((x) => x.alarm_type === 'WAKE') && isEveningWake(oldWakeAt, tz, oldAt);
  const hadEarlierWake = hasEarlierWake(oldAt, wakesOfRows(oldDay.map(dayWakeRow)), row.appointment_id) || hadNoWakeInEvening;

  const travelled = await travelFor(ctx, env, { row: patchedRow, participant, placeChanged: patched.changed.place });
  warnings.push(...travelled.warnings);

  const [profile, stats, lateCount4w] = await Promise.all([env.profile(), env.stats(), env.late()]);
  // 친구가 제안해 주인이 적용한 시각(original_scheduled_at 있음)은 약속의 시각 · 장소를 바꾸면 새 계산이 이김 — 친구가 바꾸기 전 모습으로 되돌린 알람을 새 계산의 입력(직접 고른 시각 · 기존 알람 간격)으로 씀.
  //   시각 · 장소가 그대로면(제목 · 중요도만) 이 되돌림을 안 해서 친구 값이 그대로 남음. 변경 비교(diffAlarms)에는 실제 행을 넘김
  const planAlarms = patched.changed.at || patched.changed.place ? withoutFriendTimes(alarms) : alarms;
  const inputs: PlanInputs = {
    now: ctx.now,
    draft: {
      // 그날 첫 일정이 바뀌면 기상이 붙고 떨어짐 (7.1.3). 직접 고른 알람 시각은 같은 날이면 그대로 · 날짜가 바뀌면 날짜만 따라감
      //   L6 안건후보: 일정 시각을 옮길 때 직접 고른 알람 시각 기본안 = 같은 날이면 유지 · 날짜가 바뀌면 날짜만 따라감 (앱 가짜 모드와 같음)
      kinds: inheritedKinds(alarms, { withWake: !sameDayWake, baseHadEarlierWake: hadEarlierWake }),
      //   친구가 제안해서 주인이 적용한 시각(original_scheduled_at 있음)은 약속의 시각 · 장소를 바꾸면 새 계산이 이김 — 시각 · 장소가 그대로면(제목 · 중요도만) 이 길이 아예 안 돎 (친구 10-22, D67)
      manualTimes: shiftManualTimes(planAlarms, oldAt, localDateKey(newAt, tz), tz),
    },
    profile,
    appointment: patchedRow,
    participant,
    existingAlarms: planAlarms,
    stats,
    lateCount4w,
    sameDayWake,
    purePrepCandidate: patchedRow.group_id == null && participant.user_id === ctx.userId
      ? await loadPurePrepCandidate(ctx.userDb, ctx.userId, profile, ctx.now, newAt)
      : undefined,
  };
  const plan = computePlan(inputs, resolvedTravelOf(travelled.travel), 'save');
  if (!plan.check.ok) throw new HttpError('UNPROCESSABLE', plan.check.message, { reason: plan.check.reason, ...(plan.check.detail ?? {}) });
  const diff = diffAlarms(plan, alarms, { now: ctx.now, replaceExisting: true });
  const changes = alarmChanges(alarms, [...diff.update.map((u) => u.patch), ...diff.insert]);
  warnings.push(...plan.warnings.filter((w) => w.code === 'PAST_ALARM_DISABLED'));
  return { plan, purePrepCandidate: inputs.purePrepCandidate, diff, changes, warnings };
}

// 공동 약속의 시각 · 장소를 만든 사람이 고쳤을 때 다른 참여자들의 알람을 다시 계산해 씀 — 각자의 출발지 · 수단 · 준비 시간으로 (9-14).
//   앞당김과 5분 미만 늦춤은 바로 쓰고, 5분 이상 늦춰지면 그 사람이 확인할 때까지 보류(D67, 9-11 · 9-12 — 그 사람 앱이 푸시의 needsConfirm을 보고 alarm-commit 미리 보기로 다시 계산해 묻고 저장)
//   이미 울린 알람은 안 건드림(9-16). 계산을 못 한 사람(길찾기 안 됨 · 계산 불가)은 약속 시각이 안 바뀌었거나 5분 이상 늦춰지면 기존 알람을 그대로 두고 경고 · 확인 알림만(9-17), 앞당김 · 5분 미만 늦춤이면 알람을 약속이 옮겨진 만큼 같이 옮김(약속 행을 쓴 뒤, X-APPT-03). 사람 이름은 응답에 넣지 않음
//   service 클라이언트로 읽고 쓰되 모든 조회를 그 참여자의 user_id로 좁힘(ctx를 그 사람 몫으로 바꿔서 같은 함수를 부름). DB 오류는 올리고(같은 요청을 다시 보내면 이어서 맞춰짐), 계산 못 하는 사람만 건너뜀
// 한 참여자를 맞춘 결과. UPDATED = 바로 반영 · HELD = 5분 이상 늦춰져 확인 전 보류 · SKIPPED = 맞출 알람이 없음(다 울림) · NOT_UPDATED = 계산을 못 해 알람을 그대로 둠 ·
//   SHIFT = 계산을 못 해 약속이 옮겨진 만큼 알람을 같이 옮길 예정(약속 행을 쓴 뒤 shift()로 씀 — 못 쓰면 NOT_UPDATED처럼 알람 그대로 + 경고)
type SyncOutcome = { userId: string; kind: 'UPDATED' | 'HELD' | 'SKIPPED' | 'NOT_UPDATED' | 'SHIFT'; warning?: EditWarning; confirm?: boolean; shift?: () => Promise<void> };

const ROUTE_FAILED: EditWarning = { code: 'PARTICIPANT_ROUTE_FAILED', message: '참여자 한 명의 이동시간을 구하지 못해 그 사람의 알람을 그대로 뒀어요. 이동 시간 확인이 필요해요' };

const ROUTE_FAILED_SHIFTED: EditWarning = {
  code: 'PARTICIPANT_ROUTE_FAILED',
  message: '참여자 한 명의 이동시간을 새로 구하지 못해 지난번 이동 · 준비 간격 그대로 알람을 약속이 옮겨진 만큼 같이 옮겼어요. 그 사람의 확인이 필요해요',
  detail: 'SHIFTED',
};
const SHIFT_KINDS: readonly string[] = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE'];

// 알람을 새로 계산하지 못한 참여자(길찾기 실패 · 계산 불가)의 안 울린 알람을 약속이 옮겨진 만큼 그대로 같이 옮길 계획을 세움 — 지난번 이동 · 준비 간격을 쓰는 셈.
//   약속을 앞당겼는데 알람이 새 약속 뒤에 그대로 남아 지각하는 일을 막음 (탐색 시험 X-APPT-03). 옮긴 시각이 이미 지난 알람은 끄고, 꺼 둔 알람은 꺼 둔 채로 같이 옮겨 순서가 안 뒤집히게 함
//   약속 시각이 안 바뀌었거나(장소만 바뀜), 5분 이상 늦춰져 확인이 먼저인 경우는 옮기지 않음(null) — 기존대로 알람을 두고 경고 · 확인 알림만 (종류와 상관없이 약속이 늦춰진 만큼으로 정함)
//   옮기는 쓰기는 돌려주는 함수를 부를 때 함 — 약속 행을 쓴 뒤에 부름. 시각을 상대로 옮기는 일이라 약속 행 쓰기 앞에서 하면 요청이 실패해 다시 보낼 때 한 번 더 옮겨지기 때문 (약속 행이 새 시각이 되면 다시 보내도 시각이 안 바뀐 요청이라 옮기지 않음)
function planShift(
  ctx: EditCtx,
  p: ParticipantRow,
  loaded: { alarms: AlarmRow[]; rung: ReadonlySet<string> },
  a: { oldAt: Date; newAt: Date; atChanged: boolean },
): (() => Promise<void>) | null {
  const deltaMs = a.newAt.getTime() - a.oldAt.getTime();
  if (!a.atChanged || deltaMs === 0 || deltaMs >= CONFIRM_MOVE_MINUTES * 60_000) return null;
  const movable = loaded.alarms.filter((x) => !loaded.rung.has(x.alarm_id) && SHIFT_KINDS.includes(x.alarm_type));
  if (!movable.some((x) => x.is_enabled)) return null;
  const nowIso = ctx.now.toISOString();
  const update = movable.map((x) => {
    const at = new Date(Date.parse(x.scheduled_at) + deltaMs);
    const patch: AlarmWrite = {
      alarm_type: x.alarm_type,
      scheduled_at: at.toISOString(),
      intensity: x.intensity,
      voice_tone: x.voice_tone,
      sound_key: x.sound_key as AlarmWrite['sound_key'],   // DB 칸은 null 허용 — 쓰기 모양(AlarmWrite)이 string이라 좁혀 놓았을 뿐 값은 그대로
      vibration: x.vibration,
      is_enabled: x.is_enabled && at.getTime() > ctx.now.getTime(),
      time_source: x.time_source,
      intensity_source: x.intensity_source,
      last_calculated_at: nowIso,
    };
    return { alarm_id: x.alarm_id, patch };
  });
  return async () => {
    await applyAlarmDiff(ctx, p.participant_id, { insert: [], update, remove: [] }, loaded.alarms);
  };
}

// 참여자를 몇 명씩 한꺼번에 맞출지 — 참여자 한 명마다 DB 약 12번 + 길찾기 1번이라 20명을 하나씩 하면 길찾기가 느린 순간 앱 제한(30초)을 넘음
export const SYNC_CONCURRENCY = 4;

async function syncOne(ctx: EditCtx, a: { row: EditRow; patched: ReturnType<typeof applyPatch>; oldAt: Date; newAt: Date }, p: ParticipantRow): Promise<SyncOutcome> {
  const { row, patched, oldAt, newAt } = a;
  const pctx: EditCtx = { ...ctx, userId: p.user_id, userDb: ctx.service };
  let loaded: { alarms: AlarmRow[]; rung: ReadonlySet<string> } | undefined;
  const shifted = (): SyncOutcome | null => {
    const shift = loaded ? planShift(pctx, p, loaded, { oldAt, newAt, atChanged: patched.changed.at }) : null;
    return shift ? { userId: p.user_id, kind: 'SHIFT', warning: ROUTE_FAILED_SHIFTED, confirm: true, shift } : null;
  };
  try {
    const alarms = await loadAlarms(ctx.service, p.participant_id, p.user_id);
    const rung = new Set(alarms.filter((x) => Date.parse(x.scheduled_at) <= ctx.now.getTime()).map((x) => x.alarm_id)); // 이미 울린 알람은 안 건드림
    loaded = { alarms, rung };
    if (alarms.every((x) => rung.has(x.alarm_id))) return { userId: p.user_id, kind: 'SKIPPED' };
    const penv = new Env(pctx);
    const tz = await penv.tz();
    const snapshot = await snapshotDays(pctx, penv, [oldAt, newAt]);
    const made = await replanFor(pctx, penv, { row, patched, participant: p, alarms, snapshot, excluded: new Set([row.appointment_id]), oldAt, newAt, tz });
    // 장소가 바뀌었는데 길찾기가 안 돼 근사값 · 내 이동 기록뿐이면 그 사람의 기존 알람을 그대로 두고 '이동 시간 확인 필요' 경고만 (9-17)
    const source = made.plan.travel.chosen?.source;
    //   약속 시각도 바뀌었으면 지난번 이동 간격 그대로 알람을 같이 옮김 (X-APPT-03, 쓰기는 약속 행을 쓴 뒤)
    if (patched.changed.place && (source === 'ESTIMATE' || source === 'CACHED')) return shifted() ?? { userId: p.user_id, kind: 'NOT_UPDATED', warning: ROUTE_FAILED };
    const diff: AlarmDiff = { insert: made.diff.insert, update: made.diff.update.filter((u) => !rung.has(u.alarm_id)), remove: made.diff.remove.filter((id) => !rung.has(id)) };
    const changes = alarmChanges(alarms.filter((x) => !rung.has(x.alarm_id)), [...diff.update.map((u) => u.patch), ...diff.insert]);
    if (needsConfirm(changes)) return { userId: p.user_id, kind: 'HELD' };
    must(
      'appointment_participants update',
      await ctx.service
        .from('appointment_participants')
        .update({ est_travel_minutes: made.plan.travelMinutes, travel_source: made.plan.travel.chosen?.source, prepare_minutes: made.plan.prepare.minutes, ...purePrepPersistenceOf(made.plan, made.purePrepCandidate) })
        .eq('participant_id', p.participant_id)
        .eq('user_id', p.user_id),
    );
    await applyAlarmDiff(pctx, p.participant_id, diff, alarms);
    return { userId: p.user_id, kind: 'UPDATED' };
  } catch (e) {
    // 계산을 못 하는 사람(길찾기 장애 · 계산 결과가 맞지 않음)은 알람을 같이 옮기거나(shifted) 그대로 두고 경고. DB 오류 같은 나머지는 요청 전체를 실패로 올림 —
    //   이 시점에 약속 행은 아직 안 바뀌어 있어 같은 요청을 다시 보내면 이어서 맞춰짐 (이미 맞춘 사람은 바뀔 것이 없음 — 같이 옮기는 쓰기는 약속 행 뒤에 해서 이 약속을 깨지 않음)
    if (!(e instanceof HttpError) || (e.code !== 'ROUTE_UNAVAILABLE' && e.code !== 'UNPROCESSABLE')) throw e;
    const moved = shifted();   // 약속 시각이 바뀌었으면 알람을 같이 옮김 — 약속을 앞당겼는데 알람이 새 약속 뒤에 남지 않게 (X-APPT-03)
    if (moved) return moved;
    return {
      userId: p.user_id,
      kind: 'NOT_UPDATED',
      warning: e.code === 'ROUTE_UNAVAILABLE' ? ROUTE_FAILED : { code: 'PARTICIPANT_NOT_UPDATED', message: '참여자 한 명의 알람을 다시 계산하지 못해 그대로 뒀어요', detail: e.code },
    };
  }
}

// held = 푸시에 needsConfirm: true를 실을 사람 — 서버가 아직 맞추지 못했거나 정확히 계산하지 못한 사람(보류 · 계산 못 함 · 지난번 간격으로 옮김). 그 사람 폰이 미리 보기로 다시 계산해 묻고 저장함
// finish() = 약속 행을 쓴 뒤 부르는 마무리 — 계산을 못 해 같이 옮기기로 한 사람의 알람을 쓰고, 쓰기가 안 되면(DB 오류) 그 사람은 알람 그대로 + 경고 · 확인 알림으로 내림 (이미 약속이 바뀐 뒤라 요청을 실패로 돌리지 않음)
async function syncOtherParticipants(
  ctx: EditCtx,
  a: { row: EditRow; patched: ReturnType<typeof applyPatch>; oldAt: Date; newAt: Date },
): Promise<{ summary: ParticipantSync; held: Set<string>; warnings: EditWarning[]; finish: () => Promise<void> }> {
  const { row } = a;
  const summary: ParticipantSync = { updated: 0, held: 0, skipped: 0 };
  const held = new Set<string>();
  const warnings: EditWarning[] = [];
  const members = must<{ user_id: string }[]>('group members', await ctx.service.from('group_members').select('user_id').eq('group_id', row.group_id as string).eq('invite_status', 'JOINED'));
  const joined = new Set(members.map((m) => m.user_id));
  const others = must<ParticipantRow[]>(
    'participants',
    await ctx.service.from('appointment_participants').select(PARTICIPANT_COLUMNS).eq('appointment_id', row.appointment_id).neq('user_id', ctx.userId),
  ).filter((p) => joined.has(p.user_id));

  const outcomes: SyncOutcome[] = [];
  for (let i = 0; i < others.length; i += SYNC_CONCURRENCY) {
    // allSettled: 한 명이 실패해도 같은 묶음의 쓰기가 끝난 뒤에 오류를 올림 (요청이 끝난 뒤에 남은 쓰기가 돌지 않게)
    const settled = await Promise.allSettled(others.slice(i, i + SYNC_CONCURRENCY).map((p) => syncOne(ctx, a, p)));
    const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw failed.reason;
    outcomes.push(...settled.map((r) => (r as PromiseFulfilledResult<SyncOutcome>).value));
  }
  const pending: SyncOutcome[] = [];
  for (const o of outcomes) {
    if (o.kind === 'UPDATED') {
      summary.updated += 1;
      if (o.confirm) held.add(o.userId);
      if (o.warning) warnings.push(o.warning);
    } else if (o.kind === 'SHIFT') {
      summary.updated += 1;   // 같이 옮길 사람 — 쓰기는 finish()에서, 못 쓰면 거기서 skipped로 내림
      held.add(o.userId);   // 지난번 간격으로 옮긴 사람 폰은 확인 화면을 띄움
      if (o.warning) warnings.push(o.warning);
      pending.push(o);
    } else if (o.kind === 'HELD') {
      summary.held += 1;
      held.add(o.userId);
    } else {
      summary.skipped += 1;
      if (o.kind === 'NOT_UPDATED') held.add(o.userId);
      if (o.warning) warnings.push(o.warning);
    }
  }
  const finish = async () => {
    for (const o of pending) {
      try {
        await o.shift!();
      } catch {
        summary.updated -= 1;
        summary.skipped += 1;
        const i = warnings.indexOf(o.warning!);
        if (i >= 0) warnings[i] = ROUTE_FAILED;
      }
    }
  };
  return { summary, held, warnings, finish };
}

// 공동 약속 푸시(GROUP_APPT_CHANGED) — 받는 사람은 DB 함수 plan_group_push가 정함(보낸 사람이 만든 사람이고 아직 안 지난 약속일 때만). 푸시가 안 가도 고치기 · 지우기는 이미 끝난 일이라 오류로 만들지 않고 경고만
async function planGroupPushSafe(ctx: EditCtx, row: EditRow): Promise<{ plan?: GroupPlan; warnings: EditWarning[] }> {
  try {
    return { plan: await planGroupPush(ctx.service, ctx.userId, { kind: 'GROUP_APPT_CHANGED', groupId: row.group_id as string, appointmentId: row.appointment_id }), warnings: [] };
  } catch (e) {
    console.error('[appointment-edit] 공동 약속 푸시 받는 사람 정하기 실패', e instanceof Error ? e.message : String(e));
    return { warnings: [{ code: 'PUSH_NOT_SENT', message: '참여자에게 알림을 보내지 못했어요' }] };
  }
}

async function pushGroupChange(
  ctx: EditCtx,
  row: EditRow,
  change: 'CHANGED' | 'CANCELED',
  opts: { plan?: GroupPlan; held?: ReadonlySet<string> },
): Promise<{ notified?: number; warnings: EditWarning[] }> {
  const planned = opts.plan ? { plan: opts.plan, warnings: [] as EditWarning[] } : await planGroupPushSafe(ctx, row);
  if (!planned.plan) return { warnings: planned.warnings };
  const req = { kind: 'GROUP_APPT_CHANGED' as const, groupId: row.group_id as string, appointmentId: row.appointment_id };
  try {
    const perRecipient = opts.held ? new Map([...planned.plan.recipients, ...planned.plan.silentRecipients].map((id) => [id, { needsConfirm: opts.held!.has(id) }])) : undefined;
    const out = await sendGroupPush(ctx.service, req, planned.plan, ctx.push ?? {}, { change, ...(perRecipient ? { perRecipient } : {}) });
    const failed = out.reason && out.reason !== 'NO_TOKENS';
    return { notified: out.sent, warnings: failed ? [{ code: 'PUSH_NOT_SENT', message: '참여자에게 알림을 보내지 못했어요', detail: out.reason }] : [] };
  } catch (e) {
    console.error('[appointment-edit] 공동 약속 푸시 실패', e instanceof Error ? e.message : String(e));
    return { warnings: [{ code: 'PUSH_NOT_SENT', message: '참여자에게 알림을 보내지 못했어요' }] };
  }
}

export async function updateAppointment(ctx: EditCtx, req: Extract<EditRequest, { action: 'UPDATE' }>): Promise<UpdateResponse> {
  const target = await loadTarget(ctx, req.appointmentId);
  assertEditor(target, ctx, '고칠');
  await assertGroupMember(ctx, target.appointment);
  const { appointment: row, participant, alarms } = target;
  if (row.exception_kind === 'CANCELED') throw new HttpError('NOT_FOUND', '일정을 찾을 수 없어요'); // 이번만 지운 회차 — 고치려면 되돌리기(RESTORE)가 먼저

  const env = new Env(ctx);
  const group = row.group_id != null;
  const recurring = !group && row.recurrence_rule != null;
  const patched = applyPatch(row, req.patch);
  const effect = scopeEffect({ recurring, group, scope: req.scope, patchRule: req.patch.recurrenceRule, currentRule: row.recurrence_rule });

  // 지난 공동 약속은 고칠 수 없고, 지난 날로 옮길 수도 없음 (9-32 · DB 정책 appointments_update와 같은 규칙). '지난'은 하루 경계 — 내 폰 시간대의 오늘 0시보다 앞 (오늘 이미 지난 약속은 오늘 안에는 고칠 수 있음, 9-러)
  const todayStart = group ? localDayRange(ctx.now, await env.tz()).start.getTime() : 0;
  if (group && (Date.parse(row.appointment_at) < todayStart || (patched.changed.at && Date.parse(patched.next.appointment_at) < todayStart))) {
    throw new HttpError('UNPROCESSABLE', '지난 약속이에요', { reason: 'PAST_APPOINTMENT' });
  }
  // 공동 약속의 반복은 회차마다 참여자 알람을 만드는 일이 따로 필요해 아직 못 고침 (9-머 · 9-버, 반복 공동 약속은 회차 만들기부터 이어서)
  if (group && req.patch.recurrenceRule !== undefined && req.patch.recurrenceRule !== row.recurrence_rule) {
    throw new HttpError('UNPROCESSABLE', '공동 약속의 반복은 아직 고칠 수 없어요', { reason: 'GROUP_RECURRENCE_LATER' });
  }

  const result: UpdateResponse = { ...common(row.appointment_id), saved: true, needs_confirm: false, changes: [], alarms: alarms.map(summarize), deleted_appointment_ids: [] };
  if (!patched.any && effect.rule.kind === 'KEEP') return result; // 바뀐 것이 없음 — 같은 요청을 두 번 보내면 두 번째가 여기

  const tz = await env.tz();
  const oldAt = new Date(row.appointment_at);
  const newAt = new Date(patched.next.appointment_at);

  // 뒤 회차 (이후 모두 고치기) — 지운 뒤 alarm-roll이 새 기준으로 다시 만듦
  let laterIds: string[] = [];
  if (effect.deleteLater) {
    const rows = await seriesRows(ctx, row);
    laterIds = laterRowsToDelete({ rows, target: row, now: ctx.now, recordIds: await recordIdsOf(ctx, rows.map((r) => r.appointment_id)), mode: 'EDIT' });
  }

  // 바꾸기 전의 날들을 읽어 둠 — 알람을 다시 계산하거나(시각 · 장소 · 중요도) 7.1.3 재판정을 할 때만 필요
  const needSnapshot = (participant != null && patched.affectsAlarms) || patched.changed.at || laterIds.length > 0;
  const snapshot: Snapshot = needSnapshot ? await snapshotDays(ctx, env, [oldAt, newAt, ...(await laterAts(ctx, laterIds))]) : { days: new Map(), instants: new Map() };
  const excluded = new Set([row.appointment_id, ...laterIds]);

  // ---- 알람 다시 계산 (시각 · 장소 · 중요도가 바뀔 때만) ----
  let plan: Plan | undefined;
  let purePrepCandidate: PlanInputs['purePrepCandidate'];
  let diff: AlarmDiff | undefined;
  if (participant && patched.affectsAlarms) {
    const made = await replanFor(ctx, env, { row, patched, participant, alarms, snapshot, excluded, oldAt, newAt, tz });
    plan = made.plan;
    purePrepCandidate = made.purePrepCandidate;
    diff = made.diff;
    result.changes = made.changes;
    result.warnings.push(...made.warnings);

    // L6 안건후보: 확인 시트 기본안 = 고치는 일정의 알람이 5분 이상 늦춰지면 저장하지 않고 needs_confirm. 앞당김은 바로 저장 (D67)
    if (needsConfirm(result.changes) && !req.confirmed) {
      return { ...result, saved: false, needs_confirm: true, alarms: alarms.map(summarize), warnings: result.warnings };
    }
  }

  // ---- 쓰기 ----
  const canceled: string[] = [];
  if (laterIds.length) {
    canceled.push(...(await deleteRows(ctx, laterIds)));
    result.deleted_appointment_ids = laterIds;
  }

  let after = alarms;
  if (participant && plan && diff) {
    must(
      'appointment_participants update',
      await ctx.userDb
        .from('appointment_participants')
        .update({ est_travel_minutes: plan.travelMinutes, travel_source: plan.travel.chosen?.source, prepare_minutes: plan.prepare.minutes, ...purePrepPersistenceOf(plan, purePrepCandidate) })
        .eq('participant_id', participant.participant_id)
        .eq('user_id', ctx.userId),
    );
    after = await applyAlarmDiff(ctx, participant.participant_id, diff, alarms);
    canceled.push(...canceledAlarmIds({ before: alarms, after }));
  }

  // 공동 약속: 만든 사람이 시각 · 장소를 고치면 다른 참여자의 알람도 다시 계산함. 약속 행을 쓰기 전에 해서 실패해도 같은 요청을 다시 보내면 이어서 맞춰지게 함 (9-10 ~ 9-17 · 9-43)
  const sync = group && (patched.changed.at || patched.changed.place) ? await syncOtherParticipants(ctx, { row, patched, oldAt, newAt }) : undefined;

  const rowPatch: Record<string, unknown> = { ...patched.next };
  if (effect.mark === 'EDITED') rowPatch.exception_kind = 'EDITED';
  if (effect.mark === 'CLEAR') rowPatch.exception_kind = null;
  if (effect.rule.kind === 'SET') rowPatch.recurrence_rule = effect.rule.value;
  if (effect.rule.kind === 'CLEAR_ALL') {
    // 반복 끔: 앞 회차가 기준이 되어 roll이 다시 만들지 않도록 묶음 모든 행의 규칙을 비움 (지난 행은 기록으로 남음)
    must(
      'appointments rule clear',
      await ctx.userDb.from('appointments').update({ recurrence_rule: null }).eq('creator_id', ctx.userId).eq('series_id', row.series_id).not('recurrence_rule', 'is', null),
    );
    rowPatch.recurrence_rule = null;
  }
  await updateRow(ctx, row.appointment_id, rowPatch, row.creator_id);
  if (sync) await sync.finish();   // 계산을 못 한 참여자의 알람을 약속이 옮겨진 만큼 같이 옮김 — 약속 행 뒤에 해야 요청을 다시 보내도 두 번 안 옮겨짐 (X-APPT-03)

  if (effect.deleteLater) await clearAttempts(ctx, row, { after: row.occurrence_on });

  // 시각 · 장소가 바뀐 공동 약속만 참여자에게 알림(제목 · 중요도만 고치면 없음, 9-39). 푸시는 약속 행이 써진 뒤에, 실패해도 고친 것은 그대로
  if (sync) {
    result.participants = sync.summary;
    result.warnings.push(...sync.warnings);
    const pushed = await pushGroupChange(ctx, row, 'CHANGED', { held: sync.held });
    if (pushed.notified != null) result.notified = pushed.notified;
    result.warnings.push(...pushed.warnings);
  }

  // 제목만 바뀐 경우도 폰의 알람 제목이 바뀌어야 하므로 꾸러미를 다시 줌
  if (participant && (plan || patched.changed.title)) {
    const departure = after.find((a) => a.alarm_type === 'DEPARTURE');
    result.ring_packages.push(
      ...packagesOf({
        alarms: after,
        appointment: { title: patched.next.title, dest_name: patched.next.dest_name },
        at: newAt,
        tz,
        travelMinutes: plan?.travelMinutes ?? participant.est_travel_minutes,
        departAt: plan ? plan.departure : departure ? new Date(departure.scheduled_at) : undefined,
      }),
    );
  }
  result.alarms = after.map(summarize);

  // ---- 7.1.3: 같은 날 다른 일정의 기상 다시 판정 ----
  if (patched.changed.at || laterIds.length) {
    const again = await reevaluateWake(ctx, env, snapshot);
    result.ring_packages.push(...again.ring_packages);
    canceled.push(...again.canceled_alarm_ids);
    result.warnings.push(...again.warnings);
  }
  return settle(result, canceled);
}

// 지울 회차들의 약속 시각 (7.1.3으로 다시 볼 날을 정하려고)
async function laterAts(ctx: EditCtx, appointmentIds: readonly string[]): Promise<Date[]> {
  if (!appointmentIds.length) return [];
  return must<{ appointment_at: string }[]>('later rows', await ctx.userDb.from('appointments').select('appointment_at').eq('creator_id', ctx.userId).in('appointment_id', [...appointmentIds])).map((r) => new Date(r.appointment_at));
}

// 이동시간 정하기 — 장소가 안 바뀌면 저장된 값 그대로, 직접 입력(MANUAL)도 그대로 (D42 C). 장소가 바뀌면 길찾기 → 내 실측 중앙값 → 직선 근사 (7.1.2)
//   L6 안건후보: 시각만 바꿀 때 이동시간 기본안 = 저장된 값 그대로 (길찾기를 새로 안 부름 — 앱 가짜 모드와 같음). 장소를 바꾸면 길찾기를 새로 구함
async function travelFor(ctx: EditCtx, env: Env, args: { row: AppointmentRow; participant: ParticipantRow; placeChanged: boolean }): Promise<{ travel: TravelChoice; warnings: EditWarning[] }> {
  const stored = storedTravel(args.participant);
  if (stored && (!args.placeChanged || args.participant.travel_source === 'MANUAL')) return { travel: stored, warnings: [] };

  const profile = await env.profile();
  const basics = resolveBasics({ draft: {}, profile, appointment: args.row, participant: args.participant });
  const coords = (p: { lat?: number; lng?: number }) => (p.lat != null && p.lng != null ? { lat: p.lat, lng: p.lng } : undefined);
  const resolved = await resolveTravel(
    { origin: coords(basics.origin), destination: coords(basics.destination), transport: basics.transport },
    { ...(ctx.kakao ? { kakao: ctx.kakao } : {}), samples: () => loadTravelSamples(ctx.userDb, ctx.userId) },
  );
  if (!resolved.chosen) {
    throw new HttpError('ROUTE_UNAVAILABLE', '새 장소까지 이동시간을 구하지 못했어요. 장소를 검색해서 골라 주세요', { manual_required: true, warnings: resolved.warnings });
  }
  const warnings: EditWarning[] = resolved.warnings.map((w) => ({ code: w.code, message: w.message, ...(w.detail ? { detail: w.detail } : {}) }));
  // 길찾기가 안 돼 근사값(ESTIMATE) · 내 이동 기록(CACHED)으로 저장함 — H03가 "대략"으로 보임 (roll의 폴백과 같음)
  //   L6 안건후보: 장소를 바꿨는데 길찾기가 안 될 때 기본안 = 근사값(ESTIMATE)으로 저장하고 경고를 같이 줌 (저장을 막지 않음)
  if (resolved.chosen.source === 'ESTIMATE' || resolved.chosen.source === 'CACHED') warnings.push({ code: 'TRAVEL_NOT_EXACT', message: '이동시간이 길찾기 값이 아니에요. 대략적인 값이니 확인해 주세요', detail: resolved.chosen.source });
  return { travel: resolved.chosen, warnings };
}

// 이후 모두 고치기 · 지우기로 날짜가 바뀐 묶음의 재시도 기록 정리 (service 전용 표). after = 이 날짜 뒤의 기록만 (이 날짜까지는 그대로)
async function clearAttempts(ctx: EditCtx, row: Pick<EditRow, 'series_id'>, scope: { after: string } | 'all') {
  const q = ctx.service.from('roll_attempts').delete().eq('user_id', ctx.userId).eq('series_id', row.series_id);
  must('roll_attempts delete', await (scope === 'all' ? q : q.gt('occurrence_on', scope.after)));
}

// ---------------------------------------------------------------------------
// 지우기
// ---------------------------------------------------------------------------

export async function deleteAppointment(ctx: EditCtx, req: Extract<EditRequest, { action: 'DELETE' }>): Promise<DeleteResponse> {
  const target = await loadTarget(ctx, req.appointmentId);
  // 없는 행(이미 지움 · 남의 개인 약속)은 성공 — 같은 요청을 두 번 보내면 같은 결과. 남의 것은 RLS로 안 보여서 건드릴 것이 애초에 없음
  if (!target) return { ...common(req.appointmentId), deleted: false, mode: 'NONE', deleted_appointment_ids: [] };
  assertEditor(target, ctx, '지울');
  await assertGroupMember(ctx, target.appointment);
  const { appointment: row, alarms } = target;

  const group = row.group_id != null;
  const recurring = !group && row.recurrence_rule != null;
  const mode = deleteMode({ recurring, group, scope: req.scope });
  const result: DeleteResponse = { ...common(row.appointment_id), deleted: true, mode, deleted_appointment_ids: [] };
  if (mode === 'CANCEL_THIS' && row.exception_kind === 'CANCELED') return result; // 이미 이번만 지움 — 같은 결과

  // 출발 · 도착 기록이 있는 회차는 지우지 않음 (기록이 사라짐). L6 안건후보: 기록 있는 일정 지우기 기본안 = 거절
  const withRecords = (await recordIdsOf(ctx, [row.appointment_id])).has(row.appointment_id) || (group && (await sharedRecordExists(ctx, row.appointment_id)));
  if (withRecords) throw new HttpError('UNPROCESSABLE', '출발 · 도착 기록이 있는 일정은 지울 수 없어요', { reason: 'HAS_RECORDS' });

  const env = new Env(ctx);
  const at = new Date(row.appointment_at);
  // 만든 사람이 비어 있는 공동 약속은 안 지난 약속만 지움 (DB 정책 appointments_delete_creator · 고치기와 같은 하루 경계, X-APPT-01). 정책이 막으면 0행이라 오류 없이 성공처럼 보이므로 먼저 거절
  if (group && row.creator_id == null && at.getTime() < localDayRange(ctx.now, await env.tz()).start.getTime()) {
    throw new HttpError('UNPROCESSABLE', '지난 약속이에요', { reason: 'PAST_APPOINTMENT' });
  }
  const canceled: string[] = [];
  let laterIds: string[] = [];
  let laterAtList: Date[] = [];
  if (mode === 'FROM_HERE') {
    const rows = await seriesRows(ctx, row);
    laterIds = laterRowsToDelete({ rows, target: row, now: ctx.now, recordIds: await recordIdsOf(ctx, rows.map((r) => r.appointment_id)), mode: 'DELETE' });
    laterAtList = await laterAts(ctx, laterIds);
  }
  const snapshot = await snapshotDays(ctx, env, [at, ...laterAtList]);

  if (mode === 'CANCEL_THIS') {
    // 행은 두고 알람만 지움 + 지운 회차 표시 — 행을 지우면 alarm-roll이 이 날짜를 다시 만듦. 표시는 마지막에 (알람이 먼저 지워지면 다시 보냈을 때 이어서 끝남)
    canceled.push(...ids(alarms));
    if (alarms.length) must('alarms delete', await ctx.userDb.from('alarms').delete().in('alarm_id', ids(alarms)).eq('user_id', ctx.userId));
    await updateRow(ctx, row.appointment_id, { exception_kind: 'CANCELED' });
  } else if (mode === 'FROM_HERE') {
    canceled.push(...(await deleteRows(ctx, laterIds)));
    result.deleted_appointment_ids = laterIds;
    // 남은 행의 규칙을 비움 (alarm-roll 대상에서 빠짐, 지난 행은 기록으로) — 이 행을 지우기 전에 해서, 중간에 실패해도 다시 보내면 이어서 끝남
    must('appointments rule clear', await ctx.userDb.from('appointments').update({ recurrence_rule: null }).eq('creator_id', ctx.userId).eq('series_id', row.series_id).not('recurrence_rule', 'is', null));
    canceled.push(...(await deleteRows(ctx, [row.appointment_id])));
    result.deleted_appointment_ids = [...laterIds, row.appointment_id];
    await clearAttempts(ctx, row, 'all');
  } else {
    // 한 번짜리 · 공동 약속(만든 사람) — 약속 + 참여 + 알람. 공동 약속은 다른 참여자의 참여 · 알람도 같이 사라짐(CASCADE)
    //   L6 안건후보: 공동 약속 지우기 기본안 = 만든 사람이 지우면 약속 전체가 지워짐. 다른 참여자의 폰 예약은 그 사람의 다음 맞추기(reconcile)에서 정리 (변경 알림은 L3 S2 뒤)
    //   공동 약속의 받는 사람(참여자)은 지우기 전에 정해 두고 지운 뒤에 '취소됐어요' 푸시를 보냄 — 받은 폰이 그 약속의 알람을 지움 (9-20). 지난 약속은 알릴 일이 없음
    const planned = group && Date.parse(row.appointment_at) >= localDayRange(ctx.now, await env.tz()).start.getTime() ? await planGroupPushSafe(ctx, row) : undefined;
    canceled.push(...(await deleteRows(ctx, [row.appointment_id], row.creator_id)));
    result.deleted_appointment_ids = [row.appointment_id];
    if (planned) {
      result.warnings.push(...planned.warnings);
      if (planned.plan) {
        const pushed = await pushGroupChange(ctx, row, 'CANCELED', { plan: planned.plan });
        if (pushed.notified != null) result.notified = pushed.notified;
        result.warnings.push(...pushed.warnings);
      }
    }
  }

  const again = await reevaluateWake(ctx, env, snapshot);
  result.ring_packages = again.ring_packages;
  result.warnings = [...result.warnings, ...again.warnings];
  return settle(result, [...canceled, ...again.canceled_alarm_ids]);
}

// ---------------------------------------------------------------------------
// 되돌리기 — 이미 지운 뒤의 되돌리기 (이번만 지운 회차만)
// ---------------------------------------------------------------------------

// 앱은 5초 안에 되돌리면 서버에 아무것도 안 보내므로 이 함수는 "이미 지운 뒤"에만 불림.
// 되살릴 수 있는 것은 CANCELED 표시로 행이 남아 있는 회차뿐 — 한 번짜리 · 이후 모두 지우기는 행 자체를 지워서 되살릴 수 없음(restored false).
//   L6 안건후보: 되돌리기 기본안 = 이번만 지운 회차만 서버에서 되살림. 행을 지우는 경우까지 되살리려면 모든 읽는 곳이 거를 소프트 삭제 칸이 필요해 범위 밖 (앱은 지우기 전 값을 들고 있다가 alarm-commit으로 다시 만들 수 있음)
export async function restoreAppointment(ctx: EditCtx, req: Extract<EditRequest, { action: 'RESTORE' }>): Promise<RestoreResponse> {
  const target = await loadTarget(ctx, req.appointmentId);
  if (!target) return { ...common(req.appointmentId), restored: false, reason: 'NOT_FOUND' };
  assertEditor(target, ctx, '고칠');
  const { appointment: row, participant, alarms: existingAlarms } = target;
  if (row.exception_kind !== 'CANCELED') return { ...common(row.appointment_id), restored: false, reason: 'NOT_DELETED' }; // 지운 적 없음 — 아무것도 안 함 (같은 요청을 두 번 보내면 두 번째)

  const env = new Env(ctx);
  const tz = await env.tz();
  const at = new Date(row.appointment_at);
  const result: RestoreResponse = { ...common(row.appointment_id), restored: true };
  // 되살린 회차는 이번만 고침(EDITED)으로 둠 — 지우기 전에 이번만 고쳤는지 알 수 없어서, 다음 회차의 기준이 되어 값이 번지는 쪽보다 안전한 쪽
  //   L6 안건후보: 되돌린 회차의 표시 기본안 = EDITED (안전쪽)
  if (!participant) {
    await updateRow(ctx, row.appointment_id, { exception_kind: 'EDITED' });
    return result;
  }
  const travel = storedTravel(participant);
  if (!travel) throw new HttpError('ROUTE_UNAVAILABLE', '이동시간을 알 수 없어서 알람을 다시 만들지 못했어요', { manual_required: true });

  const snapshot = await snapshotDays(ctx, env, [at]);
  const day = snapshot.days.get(localDateKey(at, tz)) ?? [];
  const sameDayWake = hasEarlierWake(at, wakesOfRows(day.map(dayWakeRow)), row.appointment_id);
  const [profile, stats, lateCount4w] = await Promise.all([env.profile(), env.stats(), env.late()]);
  // 지운 알람의 종류 · 직접 고른 시각은 남아 있지 않음 → 계산된 알람 전부를 자동 값으로 다시 만듦
  // 이미 만들다 만 알람이 있으면(알람은 만들었는데 표시 쓰기가 실패한 뒤 다시 보낸 경우) 그 알람을 기준으로 이어서 맞춤 — 없는 것처럼 다시 넣으면 유일 제약에 걸려 영영 CONFLICT
  const purePrepCandidate = row.group_id == null && participant.user_id === ctx.userId
    ? await loadPurePrepCandidate(ctx.userDb, ctx.userId, profile, ctx.now, at)
    : undefined;
  const plan = computePlan({ now: ctx.now, draft: {}, profile, appointment: row, participant, existingAlarms, stats, lateCount4w, sameDayWake, purePrepCandidate }, resolvedTravelOf(travel), 'save');
  if (!plan.check.ok) throw new HttpError('UNPROCESSABLE', plan.check.message, { reason: plan.check.reason, ...(plan.check.detail ?? {}) });
  const diff = diffAlarms(plan, existingAlarms, { now: ctx.now, replaceExisting: false });
  must('appointment_participants restore pure-prep provenance', await ctx.userDb.from('appointment_participants').update(purePrepPersistenceOf(plan, purePrepCandidate)).eq('participant_id', participant.participant_id).eq('user_id', ctx.userId));
  const after = await applyAlarmDiff(ctx, participant.participant_id, diff, existingAlarms);
  await updateRow(ctx, row.appointment_id, { exception_kind: 'EDITED' });

  result.ring_packages = packagesOf({ alarms: after, appointment: row, at, tz, travelMinutes: plan.travelMinutes, departAt: plan.departure });
  const again = await reevaluateWake(ctx, env, snapshot);
  result.ring_packages.push(...again.ring_packages);
  result.warnings = again.warnings;
  return settle(result, again.canceled_alarm_ids);
}

// ---------------------------------------------------------------------------
// 공동 약속에서 나만 빠지기
// ---------------------------------------------------------------------------

// 내 참여 조건과 내 알람만 지움 — 약속은 다른 참여자에게 그대로. 만든 사람은 못 빠짐(지워야 함). 되살리기 없음
export async function leaveSharedAppointment(ctx: EditCtx, req: Extract<EditRequest, { action: 'LEAVE' }>): Promise<LeaveResponse> {
  const target = await loadTarget(ctx, req.appointmentId);
  if (!target) return { ...common(req.appointmentId), left: false };
  const { appointment: row, participant, alarms } = target;
  if (row.group_id == null) throw new HttpError('UNPROCESSABLE', '공동 약속이 아니에요', { reason: 'NOT_SHARED' });
  // L6 안건후보: 만든 사람이 빠지려 할 때 기본안 = 막고 "지워 주세요" 안내 (앱 가짜 모드와 같음)
  if (row.creator_id === ctx.userId) throw new HttpError('UNPROCESSABLE', '내가 만든 공동 약속은 빠질 수 없어요. 지워 주세요', { reason: 'CREATOR_CANNOT_LEAVE' });
  if (!participant) return { ...common(row.appointment_id), left: true }; // 이미 빠짐 — 같은 요청을 두 번 보내면 두 번째
  if ((await recordIdsOf(ctx, [row.appointment_id])).has(row.appointment_id)) throw new HttpError('UNPROCESSABLE', '출발 · 도착 기록이 있는 일정에서는 빠질 수 없어요', { reason: 'HAS_RECORDS' });

  const env = new Env(ctx);
  const snapshot = await snapshotDays(ctx, env, [new Date(row.appointment_at)]);
  must('appointment_participants delete', await ctx.userDb.from('appointment_participants').delete().eq('participant_id', participant.participant_id).eq('user_id', ctx.userId)); // 내 알람은 CASCADE
  const again = await reevaluateWake(ctx, env, snapshot);
  return settle({ ...common(row.appointment_id), left: true, ring_packages: again.ring_packages, warnings: again.warnings }, [...ids(alarms), ...again.canceled_alarm_ids]);
}

// ---------------------------------------------------------------------------

export async function runEdit(ctx: EditCtx, req: EditRequest): Promise<UpdateResponse | DeleteResponse | RestoreResponse | LeaveResponse> {
  switch (req.action) {
    case 'UPDATE':
      return updateAppointment(ctx, req);
    case 'DELETE':
      return deleteAppointment(ctx, req);
    case 'RESTORE':
      return restoreAppointment(ctx, req);
    case 'LEAVE':
      return leaveSharedAppointment(ctx, req);
  }
}
