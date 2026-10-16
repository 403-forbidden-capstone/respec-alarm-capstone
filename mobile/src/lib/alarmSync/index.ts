// 폰 예약 맞추기 — 서버(alarms · alarm_events)와 폰(알람 코어 @capstone/alarm-core)을 이어 주는 곳 (전체작업계획 7절, docs/alarm-core.md "앞으로 더할 것")
//   · applyCommit(result)  alarm-commit 응답을 폰에 반영 (canceled_alarm_ids → cancel, ring_packages → scheduleAll). 약속 알람 만들기 · 시각 바꾸기 뒤에
//   · reconcile()          내 켜진 알람을 서버에서 읽어 폰 예약과 맞춤 (없으면 걸고, 다르면 다시 걸고, 서버에 없으면 지움). 로그인 직후 · 앱이 앞에 올 때
//   · uploadEvents()       폰에 쌓인 울림 기록을 alarm_events로 올림. 앱이 앞에 올 때 · 기상 확인 화면에 들어올 때
//   · discardPendingEvents() / onEventsUploaded(handler)  로그아웃 정리 · 원탭 뒤처리 훅 (아래)
// 실데이터 모드에서만 일함 (reconcile · uploadEvents는 가짜 모드면 아무것도 안 함). 세 함수는 한 줄로 차례대로 돎 — 맞추는 도중에 저장 결과가 끼어들어 방금 건 알람을 지우지 않게
// 계산은 reconcile.ts · events.ts(순수 함수)에, 여기는 DB · 폰 호출만
import * as AlarmCore from '@capstone/alarm-core';
import type { AlarmEvent, RingPackage, ScheduleOutcome } from '@capstone/alarm-core';

import { isMock } from '../mode';
import { supabase } from '../supabase';
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

async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data.session?.user.id ?? null;
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

// 내 켜진 알람 중 지금 이후 것을 서버에서 읽음 (RLS가 친구 알람을 줄 수 있어 user_id로 한 번 더 좁힘)
// 위쪽 기간 제한 없이 읽는 이유: 폰에 이미 있는 먼 알람을 "서버에 없다"고 보고 지우지 않으려고 (planReconcile)
async function fetchServerRows(userId: string, fromMs: number): Promise<SyncRow[]> {
  const { data, error } = await supabase
    .from('alarms')
    .select(
      'alarm_id, alarm_type, scheduled_at, intensity, sound_key, snooze_limit, is_enabled, participant_id, routine_id, appointment_participants(appointments(title, appointment_at, dest_name)), routines(title)',
    )
    .eq('user_id', userId)
    .eq('is_enabled', true)
    .gt('scheduled_at', new Date(fromMs).toISOString())
    .order('scheduled_at')
    .limit(500);
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
    routine_title: row.routines?.title ?? null,
  }));
}

export type ReconcileOptions = {
  timeZone?: string | null; // 부제 "오전 10:00 · 장소"의 시각 기준 — profiles.timezone (없으면 Asia/Seoul)
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
    const userId = await currentUserId();
    if (!userId) return emptySummary();
    const nowMs = options.nowMs ?? Date.now();
    const rows = await fetchServerRows(userId, nowMs);
    const server = buildServerPackages(rows, options.timeZone ?? undefined);
    const phone = await AlarmCore.list();
    return executePlan(planReconcile({ server, phone, nowMs }));
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
