// 폰 예약 맞추기 — 서버(alarms · alarm_events)와 폰(알람 코어 @capstone/alarm-core)을 이어 주는 곳 (전체작업계획 7절, docs/alarm-core.md "앞으로 더할 것")
//   · applyCommit(result)  alarm-commit 응답을 폰에 반영 (canceled_alarm_ids → cancel, ring_packages → scheduleAll). 약속 알람 만들기 · 시각 바꾸기 뒤에
//   · reconcile()          내 켜진 알람을 서버에서 읽어 폰 예약과 맞춤 (없으면 걸고, 다르면 다시 걸고, 서버에 없으면 지움). 로그인 직후 · 앱이 앞에 올 때
//   · uploadEvents()       폰에 쌓인 울림 기록을 alarm_events로 올림. 앱이 앞에 올 때 · 기상 확인 화면에 들어올 때
//   · cancelAllPhoneAlarms() / setSigningOut(value) / discardPendingEvents() / onEventsUploaded(handler)  로그아웃 정리 · 원탭 뒤처리 훅 (아래)
// 실데이터 모드에서만 일함 (reconcile · uploadEvents는 가짜 모드면 아무것도 안 함). 이 함수들은 한 줄로 차례대로 돎 — 맞추는 도중에 저장 결과가 끼어들어 방금 건 알람을 지우지 않게
// 계산은 reconcile.ts · events.ts(순수 함수)에, 여기는 DB · 폰 호출만
import * as AlarmCore from '@capstone/alarm-core';
import type { AlarmEvent, RingPackage, ScheduleOutcome } from '@capstone/alarm-core';

import { isMock } from '../mode';
import { supabase } from '../supabase';
import { currentUserId } from '../user';
import { isPermanentInsertError, toEventRow, type EventRow } from './events';
import { buildServerPackages, planReconcile, type ReconcilePlan, type SyncRow } from './reconcile';

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

// 로그아웃 중 — 켜져 있으면 reconcile이 서버 알람을 폰에 걸지 않고 돌아감. 로그아웃 정리(lib/session)가 폰 알람을 다 지우는 동안 맞추기가 끼어들어 앞 계정 알람을 다시 걸지 않게
// 로그아웃이 끝까지 가면 켜 둔 채로 두고 다시 로그인할 때 useAlarmSync가 끔. 로그아웃이 중간에 멈추면(알람을 못 지움 등) session.ts가 바로 끔
let signingOut = false;
export function setSigningOut(value: boolean): void {
  signingOut = value;
  if (value) lastTimeZone = null; // 다음에 로그인하는 계정의 시간대와 섞이지 않게
}

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
};

// 저장 결과를 폰에 반영 — 약속 알람 만들기 · 시각 바꾸기(alarm-commit)가 성공한 뒤에 부름. 던지지 않고 결과를 돌려줌 (부분 실패도 있음)
//   deferred(울리거나 미룬 중)는 지금 못 바꾸므로 다음 맞추기에서 서버 값으로 다시 걸림
export function applyCommit(result: CommitResult): Promise<SyncSummary> {
  return serial(async () => {
    const summary = emptySummary();
    await cancelAlarms(result.canceled_alarm_ids ?? [], summary);
    await scheduleAlarms(result.ring_packages ?? [], summary);
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
async function fetchServerRows(userId: string, fromMs: number): Promise<SyncRow[]> {
  const { data, error } = await supabase
    .from('alarms')
    .select(
      'alarm_id, alarm_type, scheduled_at, intensity, sound_key, snooze_limit, is_enabled, participant_id, routine_id, appointment_participants(est_travel_minutes, appointments(title, appointment_at, dest_name)), routines(title)',
    )
    .eq('user_id', userId)
    .eq('is_enabled', true)
    .gt('scheduled_at', new Date(fromMs).toISOString())
    .order('scheduled_at')
    .limit(SERVER_ROW_LIMIT);
  if (error) throw error;
  return (data ?? []).map((row) => ({
    alarm_id: row.alarm_id,
    alarm_type: row.alarm_type,
    scheduled_at: row.scheduled_at,
    intensity: row.intensity,
    sound_key: row.sound_key,
    snooze_limit: row.snooze_limit,
    is_enabled: row.is_enabled,
    participant_id: row.participant_id,
    routine_id: row.routine_id,
    appointment: row.appointment_participants?.appointments ?? null,
    travel_minutes: row.appointment_participants?.est_travel_minutes ?? null,
    routine_title: row.routines?.title ?? null,
  }));
}

// 이 알람들 중 서버에 켜진 행이 아직 있는 것의 id — 시각은 안 봄 (미룸 · 울리는 중이라 첫 시각이 지난 알람도 서버에는 켜진 채로 있으므로)
async function fetchEnabledIds(userId: string, ids: readonly string[]): Promise<Set<string>> {
  if (!ids.length) return new Set();
  const { data, error } = await supabase.from('alarms').select('alarm_id').eq('user_id', userId).eq('is_enabled', true).in('alarm_id', [...ids]);
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.alarm_id));
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
    const rows = await fetchServerRows(userId, nowMs);
    if (options.timeZone) lastTimeZone = options.timeZone;
    let server = buildServerPackages(rows, options.timeZone ?? lastTimeZone ?? undefined);
    let phone = await AlarmCore.list();
    const only = options.alarmIds ? new Set(options.alarmIds) : null;
    if (only) {
      server = server.filter((p) => only.has(p.alarmId));
      phone = phone.filter((a) => only.has(a.id));
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
    const plan = planReconcile({ server, phone, nowMs, forceCancel });
    // 서버 목록이 상한에서 잘렸으면 "서버에 없음"이 진짜 없다는 뜻이 아닐 수 있음 — 서버에 없다고 확인된 것(forceCancel)만 지움
    if (rows.length >= SERVER_ROW_LIMIT) plan.cancel = plan.cancel.filter((id) => forceCancel?.has(id) === true);
    return executePlan(plan);
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

// 로그인 직후 · 앱이 앞에 올 때 부르는 한 묶음 — 기록 올리기 → 서버 ↔ 폰 맞추기. 한쪽이 실패해도 앱은 그대로 쓰고 다음 기회에 다시
// 실패는 개발 중에만 콘솔에 남김 (폰 예약이 그대로라 알람은 계속 울림. 화면에 오류를 띄울 일은 아님)
export async function syncNow(options: ReconcileOptions = {}): Promise<void> {
  try {
    await uploadEvents();
  } catch (e) {
    if (__DEV__) console.warn('[alarmSync] 울림 기록 올리기 실패', e);
  }
  try {
    await reconcile(options);
  } catch (e) {
    if (__DEV__) console.warn('[alarmSync] 폰 예약 맞추기 실패', e);
  }
}
