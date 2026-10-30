// 폰 예약 맞추기 — 서버(alarms · alarm_events)와 폰(알람 코어 @capstone/alarm-core)을 이어 주는 곳 (전체작업계획 7절, docs/alarm-core.md "앞으로 더할 것")
//   · applyCommit(result)  alarm-commit 응답을 폰에 반영 (canceled_alarm_ids → cancel, ring_packages → scheduleAll). 약속 알람 만들기 · 시각 바꾸기 뒤에
//   · reconcile()          내 켜진 알람을 서버에서 읽어 폰 예약과 맞춤 (없으면 걸고, 다르면 다시 걸고, 서버에 없으면 지움. 출발 알람이 바뀌면 그 약속의 준비 · 기상 글자도 다시 걺). 로그인 직후 · 앱이 앞에 올 때
//   · uploadEvents()       폰에 쌓인 울림 기록을 alarm_events로 올림. 앱이 앞에 올 때 · 기상 확인 화면에 들어올 때
//   · syncNow()            기록 올리기 → 내 반복 회차 넘기기(서버 alarm-roll) → 맞추기를 한 묶음으로. 로그인 직후 · 앱이 앞에 올 때 · 반복 일정을 저장한 직후
//   · cancelAllPhoneAlarms() / setSigningOut(value) / discardPendingEvents() / onEventsUploaded(handler) / onAlarmsSynced(handler)  로그아웃 정리 · 원탭 뒤처리 훅 · 맞춘 뒤 훅 (아래)
//   · failedAlarmCount() / onFailedAlarmsChange(listener)  폰에 못 건 알람 수 (홈 빨간 줄용, 맞춘 뒤 훅에 붙어 있음)
// 실데이터 모드에서만 일함 (reconcile · uploadEvents는 가짜 모드면 아무것도 안 함). 이 함수들은 한 줄로 차례대로 돎 — 맞추는 도중에 저장 결과가 끼어들어 방금 건 알람을 지우지 않게
// 계산은 reconcile.ts · events.ts(순수 함수)에, 여기는 DB · 폰 호출만
import * as AlarmCore from '@capstone/alarm-core';
import type { AlarmEvent, RingPackage, ScheduleOutcome } from '@capstone/alarm-core';

import { dbTimeMs } from '../dbTime';
import { callEdge } from '../edge';
import { isMock } from '../mode';
import { supabase } from '../supabase';
import { currentUserId } from '../user';
import { isPermanentInsertError, toEventRow, type EventRow } from './events';
import {
  buildServerPackages,
  dropRecorded,
  expandWithTextSiblings,
  planReconcile,
  upcomingParticipants,
  type ReconcilePlan,
  type ServerPackage,
  type SyncRow,
  type UpcomingParticipant,
} from './reconcile';

export type SyncSummary = {
  scheduled: string[]; // 폰에 걸린 alarmId
  skippedPast: string[]; // 시각이 지나서 안 건 것 (오류 아님)
  deferred: string[]; // 울리거나 미룬 중이라 새 꾸러미를 못 받은 것 — 다음 맞추기(앱이 앞에 올 때)에서 다시 넘김
  canceled: string[]; // 폰에서 지운 alarmId
  failed: { alarmId: string; error: string }[]; // 걸거나 지우지 못한 것 (정확한 알람 권한 없음 등)
};

const emptySummary = (): SyncSummary => ({ scheduled: [], skippedPast: [], deferred: [], canceled: [], failed: [] });

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// 맞추기 · 올리기를 한 줄로 — 앞 일이 끝나야 다음 일을 시작 (앞 일이 실패해도 이어서)
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.catch(() => {});
  return run;
}

// 마지막으로 받은 프로필 시간대 — 켜기 · 끄기 · 강도처럼 시간대를 모르는 호출 경로(reconcile({ alarmIds }))도 같은 부제("오전 10:00 · 장소")를 만들게
//   useAlarmSync가 로그인 직후 넘긴 값을 기억해 둠 (호출 경로마다 부제 시각이 다르면 같은 알람이 경로에 따라 다시 걸림)
let lastTimeZone: string | null = null;

// 마지막으로 반복 회차 넘기기(alarm-roll)가 성공한 시각(밀리초) — 10분에 한 번만 부르려고 (rollOwn)
let lastRollOkAt: number | null = null;

// 로그아웃 중 — 켜져 있으면 reconcile이 서버 알람을 폰에 걸지 않고 돌아감. 로그아웃 정리(lib/session)가 폰 알람을 다 지우는 동안 맞추기가 끼어들어 앞 계정 알람을 다시 걸지 않게
// 로그아웃이 끝까지 가면 켜 둔 채로 두고 다시 로그인할 때 useAlarmSync가 끔. 로그아웃이 중간에 멈추면(알람을 못 지움 등) session.ts가 바로 끔
let signingOut = false;
export function setSigningOut(value: boolean): void {
  signingOut = value;
  if (value) {
    lastTimeZone = null; // 다음에 로그인하는 계정의 시간대와 섞이지 않게
    lastRollOkAt = null; // 〃 반복 회차 넘기기 10분 제한도 새 계정은 처음부터
    setFailed(new Set()); // 못 건 알람 목록도 앞 계정 것이라 비움
  }
}

// ---------------------------------------------------------------------------
// 맞춘 뒤 훅 — 폰 예약을 서버와 맞춘 직후(reconcile 끝 · applyCommit 끝)에 부름. L7 실패 수 · L2 지오펜스 등록 등이 붙는 한 곳 (설계메모 5절)
// ---------------------------------------------------------------------------

export type AlarmsSyncedInfo = {
  source: 'reconcile' | 'commit'; // 어디서 맞췄는지: 서버를 읽어 맞춤 / 저장 결과(alarm-commit)를 반영
  whole: boolean; // 전체 맞추기면 true. alarmIds로 일부만 맞췄거나 저장 결과를 반영한 것이면 false — 빠진 것을 "없어졌다"로 보면 안 됨
  summary: SyncSummary;
  droppedIds?: readonly string[]; // alarmIds로 지정했는데 서버 목록에 없던 알람(끄거나 지움) — 일부 맞추기에서만. 못 건 알람 목록에서 뺄 근거 (L7)
  upcoming: UpcomingParticipant[]; // 이번에 본 앞으로 알람의 참여 행(겹침 없이, 약속 시각 순). appointmentAt은 ISO 글자
  nowMs: number;
};

type SyncedHandler = (info: AlarmsSyncedInfo) => Promise<void> | void;
const syncedHandlers = new Set<SyncedHandler>();

// 구독 해제 함수를 돌려줌 (onEventsUploaded와 같은 모양). 핸들러는 맞추기를 막지 않음 — 기다리지 않고, 던져도 맞추기는 성공 (개발 중에만 경고)
export function onAlarmsSynced(handler: SyncedHandler): () => void {
  syncedHandlers.add(handler);
  return () => {
    syncedHandlers.delete(handler);
  };
}

function afterSync(info: AlarmsSyncedInfo): void {
  const warn = (e: unknown) => {
    if (__DEV__) console.warn('[alarmSync] 맞춘 뒤 훅 실패', e);
  };
  for (const handler of [...syncedHandlers]) {
    try {
      Promise.resolve(handler(info)).catch(warn); // await하지 않음 (지오펜스 등록이 맞추기 줄을 막지 않게)
    } catch (e) {
      warn(e);
    }
  }
}

// ---------------------------------------------------------------------------
// 폰에 못 건 알람 — 홈 빨간 줄 ("알람 N개를 폰에 걸지 못했어요")이 읽음. 맞춘 뒤 훅(onAlarmsSynced)에 붙어서 목록을 고침
// ---------------------------------------------------------------------------

let failedIds = new Set<string>();
const failedListeners = new Set<() => void>();

// 목록이 달라졌을 때만 구독자에게 알림 (맞출 때마다 홈이 다시 그려지지 않게)
function setFailed(next: Set<string>): void {
  const changed = next.size !== failedIds.size || [...next].some((id) => !failedIds.has(id));
  failedIds = next;
  if (changed) for (const listener of [...failedListeners]) listener();
}

export function failedAlarmCount(): number {
  return failedIds.size;
}

export function onFailedAlarmsChange(listener: () => void): () => void {
  failedListeners.add(listener);
  return () => {
    failedListeners.delete(listener);
  };
}

// 맞춘 결과로 못 건 알람 목록을 고침
//   whole = 서버 알람 전체를 맞춘 경우(잘리지 않았을 때) → 이번 결과로 목록을 새로 정함 (이번에 안 건드린 알람은 폰에 이미 걸려 있거나 서버에 없는 것)
//   일부 맞추기 · 저장 결과 반영은 이번 결과에 나온 알람만 고침: 걸렸거나 지운 것은 빼고 실패한 것은 넣음
//   summary.failed에는 지우지 못한 것도 섞여 있음 (SyncSummary가 구분하지 않아 같이 셈)
//   droppedIds = 일부 맞추기에서 지정했는데 서버 목록에 없고 폰에도 없어 summary에 안 나온 알람 (끄거나 지운 알람) — 더 걸 게 없으니 목록에서 뺌
onAlarmsSynced((info) => {
  if (signingOut) return; // 정리가 시작된 뒤 끝난 맞추기는 앞 계정의 못 건 목록을 다시 채우지 않음 (setSigningOut이 비운 목록)
  const { summary, whole, droppedIds = [] } = info;
  const failedNow = summary.failed.map((f) => f.alarmId).filter((id) => id !== '');
  if (whole) {
    setFailed(new Set(failedNow));
    return;
  }
  const next = new Set(failedIds);
  for (const id of [...summary.scheduled, ...summary.skippedPast, ...summary.deferred, ...summary.canceled, ...droppedIds]) next.delete(id);
  for (const id of failedNow) next.add(id);
  setFailed(next);
});

// ---------------------------------------------------------------------------
// 폰 예약
// ---------------------------------------------------------------------------

async function cancelAlarms(ids: readonly string[], into: SyncSummary) {
  for (const id of ids) {
    try {
      await AlarmCore.cancel(id);
      into.canceled.push(id);
    } catch (e) {
      into.failed.push({ alarmId: id, error: errorText(e) });
    }
  }
}

async function scheduleAlarms(packages: readonly RingPackage[], into: SyncSummary) {
  if (!packages.length) return;
  const outcomes: ScheduleOutcome[] = await AlarmCore.scheduleAll(packages);
  for (const o of outcomes) {
    if (o.status === 'scheduled') into.scheduled.push(o.alarmId);
    else if (o.status === 'skipped_past') into.skippedPast.push(o.alarmId);
    else if (o.status === 'deferred') into.deferred.push(o.alarmId);
    else into.failed.push({ alarmId: o.alarmId, error: o.error ?? '알 수 없는 오류' });
  }
}

// alarm-commit 응답 중 폰에 반영할 두 칸 (나머지 칸은 안 봄)
export type CommitResult = {
  ring_packages?: readonly RingPackage[] | null; // 켜진 알람의 예약 꾸러미
  canceled_alarm_ids?: readonly string[] | null; // 폰에서 지울 알람 (지워졌거나 꺼진 것)
  // 맞춘 뒤 훅(onAlarmsSynced)의 upcoming용 — 약속 알람 저장이면 호출하는 쪽이 같이 넘김. alarm-commit 응답에는 약속 시각이 없어 응답을 그대로 넘기면 비어 있음
  participant_id?: string | null;
  appointment_at?: string | null;
};

// 저장 결과를 폰에 반영 — 약속 알람 만들기 · 시각 바꾸기(alarm-commit)가 성공한 뒤에 부름. 던지지 않고 결과를 돌려줌 (부분 실패도 있음)
//   deferred(울리거나 미룬 중)는 지금 못 바꾸므로 다음 맞추기에서 서버 값으로 다시 걸림
export function applyCommit(result: CommitResult): Promise<SyncSummary> {
  return serial(async () => {
    const summary = emptySummary();
    await cancelAlarms(result.canceled_alarm_ids ?? [], summary);
    await scheduleAlarms(result.ring_packages ?? [], summary);
    const nowMs = Date.now();
    // L6 안건후보: 저장 직후 훅의 upcoming 기본안 = 호출하는 쪽이 참여 행 · 약속 시각을 넘긴 저장(약속 알람)이면 그 한 건, 아니면 빈 목록 (alarm-commit 응답에 약속 시각이 없음)
    const appointmentMs = result.appointment_at ? dbTimeMs(result.appointment_at) : NaN;
    const upcoming: UpcomingParticipant[] = result.participant_id && appointmentMs > nowMs ? [{ participantId: result.participant_id, appointmentAt: new Date(appointmentMs).toISOString() }] : [];
    afterSync({ source: 'commit', whole: false, summary, upcoming, nowMs });
    return summary;
  });
}

// 로그아웃 정리용 — 폰 알람을 전부 지움 (무음 알림 포함). 맞추기 · 올리기와 같은 줄이라 앞에 서 있는 맞추기가 다 끝난 뒤에 지움
export function cancelAllPhoneAlarms(): Promise<void> {
  return serial(() => AlarmCore.cancelAll());
}

const SERVER_ROW_LIMIT = 500; // 서버 알람을 한 번에 읽는 줄 수 — 이만큼 오면 목록이 잘렸을 수 있음 (reconcile)

// 내 켜진 알람 중 지금 이후 것을 서버에서 읽음 (RLS가 친구 알람을 줄 수 있어 user_id로 한 번 더 좁힘)
// 위쪽 기간 제한 없이 읽는 이유: 폰에 이미 있는 먼 알람을 "서버에 없다"고 보고 지우지 않으려고 (planReconcile)
//   truncated = 상한만큼 와서 목록이 잘렸을 수 있음. 출발 · 도착 기록으로 뺄 행(dropRecorded)도 읽은 줄 수에 들어가므로, 거르기 전에 정함
async function fetchServerRows(userId: string, fromMs: number): Promise<{ rows: SyncRow[]; truncated: boolean }> {
  const { data, error } = await supabase
    .from('alarms')
    .select(
      'alarm_id, alarm_type, scheduled_at, intensity, voice_tone, sound_key, vibration, snooze_limit, is_enabled, participant_id, routine_id, appointment_participants(est_travel_minutes, departed_at, arrived_at, appointments(title, appointment_at, dest_name)), routines(title)',
    )
    .eq('user_id', userId)
    .eq('is_enabled', true)
    .gt('scheduled_at', new Date(fromMs).toISOString())
    .order('scheduled_at')
    .limit(SERVER_ROW_LIMIT);
  if (error) throw error;
  const rows = (data ?? []).map((row) => ({
    alarm_id: row.alarm_id,
    alarm_type: row.alarm_type,
    scheduled_at: row.scheduled_at,
    intensity: row.intensity,
    voice_tone: row.voice_tone,
    sound_key: row.sound_key,
    vibration: row.vibration,
    snooze_limit: row.snooze_limit,
    is_enabled: row.is_enabled,
    participant_id: row.participant_id,
    routine_id: row.routine_id,
    appointment: row.appointment_participants?.appointments ?? null,
    travel_minutes: row.appointment_participants?.est_travel_minutes ?? null,
    routine_title: row.routines?.title ?? null,
    departed_at: row.appointment_participants?.departed_at ?? null,
    arrived_at: row.appointment_participants?.arrived_at ?? null,
  }));
  return { rows, truncated: rows.length >= SERVER_ROW_LIMIT };
}

// 이 알람들 중 서버에 켜진 행이 아직 있는 것의 id — 시각은 안 봄 (미룸 · 울리는 중이라 첫 시각이 지난 알람도 서버에는 켜진 채로 있으므로)
async function fetchEnabledIds(userId: string, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { data, error } = await supabase.from('alarms').select('alarm_id').eq('user_id', userId).eq('is_enabled', true).in('alarm_id', [...ids]);
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.alarm_id));
}

// 이 알람들(폰에 있는 출발 알람)이 속한 약속의 키(participant_id) — 켜짐 여부는 안 봄 (꺼진 행도 약속은 알려 줌). 지워진 행이나 약속 없는 알람은 빠짐
//   서버에 없어서 폰에서 지울 출발 알람의 약속을 알아야 같은 약속의 준비 · 기상 글자를 다시 걸 수 있음 (planReconcile). 읽기에 실패하면 던짐
async function fetchParticipantIds(userId: string, ids: readonly string[]): Promise<Map<string, string>> {
  const groups = new Map<string, string>();
  if (!ids.length) return groups;
  const { data, error } = await supabase.from('alarms').select('alarm_id, participant_id').eq('user_id', userId).in('alarm_id', [...ids]);
  if (error) throw error;
  for (const row of data ?? []) if (row.participant_id) groups.set(row.alarm_id, row.participant_id);
  return groups;
}

export type ReconcileOptions = {
  timeZone?: string | null; // 부제 "오전 10:00 · 장소"의 시각 기준 — profiles.timezone (없으면 Asia/Seoul)
  alarmIds?: readonly string[]; // 이 알람만 맞춤 — 켜기 · 끄기 · 강도처럼 DB에 직접 쓴 뒤 그 알람만 폰에 반영할 때. 없으면 전부
  nowMs?: number; // 시험용
};

async function executePlan(plan: ReconcilePlan): Promise<SyncSummary> {
  const summary = emptySummary();
  await cancelAlarms(plan.cancel, summary);
  await scheduleAlarms(plan.schedule, summary);
  return summary;
}

// 서버 ↔ 폰 맞추기 — 로그인 직후 · 앱이 앞에 올 때. 실데이터 모드 + 로그인 상태에서만 (아니면 빈 결과)
//   읽기에 실패하면 던짐 (호출하는 쪽이 다음에 다시 — 폰 예약은 그대로라 알람은 계속 울림)
export function reconcile(options: ReconcileOptions = {}): Promise<SyncSummary> {
  if (isMock()) return Promise.resolve(emptySummary());
  return serial(async () => {
    if (signingOut) return emptySummary();
    const userId = await currentUserId();
    if (!userId) return emptySummary();
    const nowMs = options.nowMs ?? Date.now();
    const { rows: readRows, truncated } = await fetchServerRows(userId, nowMs);
    // 출발 · 도착 기록이 있는 약속의 준비 · 출발(· 도착 목표) 알람은 폰 예약 대상에서 뺌 — 서버 행 목록에서 빼면 폰에 이미 걸린 것은 아래에서 "서버에 없음"으로 지워짐
    const { kept: rows, dropped } = dropRecorded(readRows);
    const droppedIds = new Set(dropped.map((row) => row.alarm_id));
    if (options.timeZone) lastTimeZone = options.timeZone;
    const allServer = buildServerPackages(rows, options.timeZone ?? lastTimeZone ?? undefined);
    const allPhone = await AlarmCore.list();
    const only = options.alarmIds ? new Set(options.alarmIds) : null;
    let scopeIds: ReadonlySet<string> | null = null; // 이번에 맞춘 알람 id (alarmIds를 줬을 때만). 훅의 upcoming 범위
    // 준비 알림 글자 · 기상 음성 문장은 같은 약속의 출발 알람에서 나옴 — 폰에서 지울(서버에 없는) 앞으로 울릴 출발 알람의 약속을 알아 두면 같은 약속의 준비 · 기상을 다시 걸 수 있음 (planReconcile)
    //   목록이 상한에서 잘렸으면 "서버에 없음"을 못 믿어 건너뜀 (그때는 서버에 없다고 확인된 것만 지우므로 아래)
    const serverIds = new Set(allServer.map((p) => p.alarmId));
    const goneDepartures = truncated
      ? []
      : allPhone.filter((a) => a.type === 'DEPARTURE' && a.atMillis > nowMs && !serverIds.has(a.id) && (only == null || only.has(a.id))).map((a) => a.id);
    const departureGroups = await fetchParticipantIds(userId, goneDepartures);
    let server: readonly ServerPackage[] = allServer;
    let phone = allPhone;
    if (only) {
      // 지정한 출발 알람(걸리거나 · 바뀌거나 · 꺼진)의 약속은 준비 · 기상도 같이 맞춤 — 안 넣으면 위 필터에서 빠져 새 글자로 못 걸림
      const withSiblings = expandWithTextSiblings(only, allServer, departureGroups);
      server = allServer.filter((p) => withSiblings.has(p.alarmId));
      phone = allPhone.filter((a) => withSiblings.has(a.id));
      scopeIds = withSiblings;
    }
    // 서버의 지금 이후 목록에 없는 폰 예약 중 서버에 켜진 행이 정말 없는 것(꺼졌거나 지워짐)은 첫 울림이 지났어도(미룸 · 다시 울림 대기 · 울리는 중) 지움 — 안 지우면 꺼진 알람이 미룸으로 다시 울림
    //   서버에 켜진 행이 남은 것은 울린 뒤 시각이 과거가 되어 목록에서 빠졌을 뿐이라 그대로 둠 (planReconcile)
    //   지정한 알람(alarmIds, 끄기를 DB에 쓴 직후)은 확인이 실패하면 던져 호출한 쪽이 알게 하고, 전체 맞추기는 확인이 실패하면 안 지움 (조심 쪽, 다음 맞추기에서 다시)
    const listed = new Set(server.map((p) => p.alarmId));
    const candidates = phone.filter((a) => !listed.has(a.id) && (only != null || a.atMillis <= nowMs)).map((a) => a.id);
    let forceCancel: Set<string> | undefined;
    try {
      const stillOn = await fetchEnabledIds(userId, candidates);
      forceCancel = new Set(candidates.filter((id) => !stillOn.has(id)));
    } catch (e) {
      if (only) throw e;
      if (__DEV__) console.warn('[alarmSync] 서버에 켜진 알람 확인 실패 — 첫 울림이 지난 폰 예약은 이번엔 안 지움', e);
    }
    if (signingOut) return emptySummary(); // 읽는 사이 로그아웃이 시작됐으면 폰을 건드리지 않음
    const plan = planReconcile({ server, phone, nowMs, forceCancel, departureGroups });
    // 서버 목록이 상한에서 잘렸으면 "서버에 없음"이 진짜 없다는 뜻이 아닐 수 있음 — 서버에 없다고 확인된 것(forceCancel)만 지움
    //   출발 · 도착 기록으로 뺀 알람(droppedIds)은 서버에서 읽은 행이라 없는 게 아니라 일부러 뺀 것 — 잘렸어도 지움
    if (truncated) plan.cancel = plan.cancel.filter((id) => forceCancel?.has(id) === true || droppedIds.has(id));
    const summary = await executePlan(plan);
    // 맞춘 뒤 훅 — 기다리지 않음. 전체 맞추기가 아니면(alarmIds) whole = false, upcoming은 이번에 맞춘 알람의 참여 행만
    const scope = scopeIds;
    afterSync({ source: 'reconcile', whole: only == null && !truncated, summary, droppedIds: only ? [...only].filter((id) => !listed.has(id)) : undefined, upcoming: upcomingParticipants(scope ? rows.filter((row) => scope.has(row.alarm_id)) : rows), nowMs });
    return summary;
  });
}

// ---------------------------------------------------------------------------
// 울림 기록 올리기
// ---------------------------------------------------------------------------

export type UploadSummary = {
  uploaded: number; // 서버에 저장됨 (같은 번호가 이미 있어 무시된 것도 포함)
  dropped: number; // 다시 올려도 소용없어(지워진 알람 · 남의 알람) 버린 것
  kept: number; // 일시 오류 · 뒤처리 실패로 폰에 남겨 둔 것 — 다음에 다시
};

const emptyUpload = (): UploadSummary => ({ uploaded: 0, dropped: 0, kept: 0 });

// 올린 기록의 뒤처리 훅 — 원탭 기록(ACKNOWLEDGED DEPARTURE · ARRIVAL_CONFIRMED)을 appointment_participants의 departed_at · arrived_at으로 옮기는 일 등 (P6-2가 등록)
//   서버에 올라간 기록만 넘어옴. 던지면 이번에 올린 기록을 폰에 남겨 다음 올리기 때 다시 넘김(서버는 같은 번호를 무시하므로 두 번 저장되지 않음)
//   → 핸들러는 같은 기록으로 다시 불려도 같은 결과가 되게 쓰고, 다시 해도 소용없는 오류(권한 · 없는 행)는 던지지 말고 삼킬 것
type UploadedHandler = (events: AlarmEvent[]) => Promise<void> | void;
const uploadedHandlers = new Set<UploadedHandler>();

export function onEventsUploaded(handler: UploadedHandler): () => void {
  uploadedHandlers.add(handler);
  return () => {
    uploadedHandlers.delete(handler);
  };
}

// 성공이면 null, 실패면 오류 (supabase-js는 네트워크 실패도 던지지 않고 error로 줌 — 혹시 던져도 일시 오류로 취급)
async function insertEvents(rows: EventRow[]): Promise<{ code?: string | null } | null> {
  try {
    const { error } = await supabase.from('alarm_events').upsert(rows, { onConflict: 'client_event_id', ignoreDuplicates: true });
    return error;
  } catch (e) {
    return { code: null, message: errorText(e) } as { code?: string | null };
  }
}

async function uploadNow(): Promise<UploadSummary> {
  const userId = await currentUserId();
  if (!userId) return emptyUpload();
  const pending = await AlarmCore.getPendingEvents();
  if (!pending.length) return emptyUpload();

  const accepted: AlarmEvent[] = [];
  const dropped: AlarmEvent[] = [];
  let kept = 0;

  const batchError = await insertEvents(pending.map((e) => toEventRow(userId, e)));
  if (!batchError) {
    accepted.push(...pending);
  } else if (!isPermanentInsertError(batchError)) {
    return { uploaded: 0, dropped: 0, kept: pending.length }; // 네트워크 등 일시 오류 — 폰에 그대로 두고 다음에
  } else if (pending.length === 1) {
    dropped.push(...pending);
  } else {
    // 한 줄이 문제라 전체가 막힌 것 — 하나씩 올려서 나머지는 살림
    for (const event of pending) {
      const error = await insertEvents([toEventRow(userId, event)]);
      if (!error) accepted.push(event);
      else if (isPermanentInsertError(error)) dropped.push(event);
      else kept += 1;
    }
  }

  let handled = true;
  if (accepted.length) {
    for (const handler of uploadedHandlers) {
      try {
        await handler(accepted);
      } catch {
        handled = false; // 올린 기록은 폰에 남김 — 다음 올리기 때 훅이 다시 불림
      }
    }
  }
  await AlarmCore.markEventsUploaded([...dropped, ...(handled ? accepted : [])].map((e) => e.clientEventId));
  return { uploaded: accepted.length, dropped: dropped.length, kept: kept + (handled ? 0 : accepted.length) };
}

// 폰에 쌓인 울림 기록을 alarm_events로 올림. 성공한 것만 폰에서 지움 (markEventsUploaded). 실데이터 모드 + 로그인 상태에서만
export function uploadEvents(): Promise<UploadSummary> {
  if (isMock()) return Promise.resolve(emptyUpload());
  return serial(uploadNow);
}

// 로그아웃 정리용 — 올리지 못하고 남은 기록을 폰에서 버림 (다음에 들어올 다른 계정에 섞이지 않게). 올려 본 뒤에 부를 것
export function discardPendingEvents(): Promise<number> {
  return serial(async () => {
    const pending = await AlarmCore.getPendingEvents();
    await AlarmCore.markEventsUploaded(pending.map((e) => e.clientEventId));
    return pending.length;
  });
}

// ---------------------------------------------------------------------------
// 내 반복 회차 넘기기 (alarm-roll) — 서버가 반복 일정의 앞으로 14일치 회차를 미리 만들어 두는 일 중 내 것을 지금 하게 함 (설계메모 5절)
// ---------------------------------------------------------------------------

const ROLL_TIMEOUT_MS = 8_000; // 이만큼 안 끝나면 기다리지 않고 맞추기를 이어감 (서버는 하던 일을 마저 함 — 같은 요청을 두 번 해도 같은 결과)
const ROLL_INTERVAL_MS = 10 * 60_000; // 앱이 앞에 올 때마다 부르지 않고 10분에 한 번 (반복 저장 직후는 건너뜀)

let rollInFlight: Promise<void> | null = null;

// 던지지 않음. 실패(네트워크 · 서버 · 시간 초과)는 삼키고 개발 중에만 경고 — 맞추기 자체는 서버에 이미 있는 회차로 계속
async function rollOnce(seriesId: string | undefined, nowMs: number): Promise<void> {
  if (isMock() || signingOut) return;
  if (!seriesId && lastRollOkAt != null && nowMs - lastRollOkAt < ROLL_INTERVAL_MS) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!(await currentUserId())) return;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('alarm-roll 시간 초과')), ROLL_TIMEOUT_MS);
    });
    // 응답의 ring_packages는 안 씀 — 꾸러미는 이어서 도는 reconcile이 DB에서 다시 읽어 걺
    await Promise.race([callEdge('alarm-roll', seriesId ? { series_id: seriesId } : {}, { timeoutMs: ROLL_TIMEOUT_MS }), deadline]);
    lastRollOkAt = nowMs;
  } catch (e) {
    if (__DEV__) console.warn('[alarmSync] 반복 회차 넘기기 실패 — 서버에 있는 회차로 맞춤', e);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// seriesId(반복 일정을 저장한 직후)를 주면 10분 제한 없이 그 묶음을 먼저 넘김. 이미 돌고 있는 요청이 있으면 제한 걸린 호출은 그 요청을 같이 기다리고, 묶음 지정 호출은 끝난 뒤에 이어서 함
function rollOwn(seriesId: string | undefined, nowMs: number): Promise<void> {
  if (!seriesId && rollInFlight) return rollInFlight;
  const run = (rollInFlight ?? Promise.resolve()).then(() => rollOnce(seriesId, nowMs));
  rollInFlight = run;
  void run.then(() => {
    if (rollInFlight === run) rollInFlight = null;
  });
  return run;
}

export type SyncOptions = ReconcileOptions & {
  rollSeriesId?: string; // 방금 저장한 반복 일정의 묶음 번호(series_id, 새 약속은 appointment_id) — 이 묶음의 회차를 바로 넘김
};

// 로그인 직후 · 앱이 앞에 올 때 부르는 한 묶음 — 기록 올리기 → 내 반복 회차 넘기기 → 서버 ↔ 폰 맞추기. 한쪽이 실패해도 앱은 그대로 쓰고 다음 기회에 다시
// 순서가 이래야 하는 이유: 출발 · 도착 기록이 먼저 서버에 가야 맞추기가 그 알람을 빼고, 회차를 먼저 만들어야 맞추기가 새 회차를 폰에 걺
// 실패는 개발 중에만 콘솔에 남김 (폰 예약이 그대로라 알람은 계속 울림. 화면에 오류를 띄울 일은 아님)
export async function syncNow(options: SyncOptions = {}): Promise<void> {
  const { rollSeriesId, ...reconcileOptions } = options;
  try {
    await uploadEvents();
  } catch (e) {
    if (__DEV__) console.warn('[alarmSync] 울림 기록 올리기 실패', e);
  }
  await rollOwn(rollSeriesId, reconcileOptions.nowMs ?? Date.now());
  try {
    await reconcile(reconcileOptions);
  } catch (e) {
    if (__DEV__) console.warn('[alarmSync] 폰 예약 맞추기 실패', e);
  }
}
