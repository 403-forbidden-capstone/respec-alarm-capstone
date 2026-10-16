// ① 약속 기반 알람 — 실데이터 울림 · 기상 확인 (H07 · H08)
//   울림 자체는 폰 알람 코어(네이티브 화면)가 함. 앱의 ring.tsx는 디자인 · 웹 미리 보기용이라 실데이터에서는 열 알람이 없음(getRing = null)
//   · 해제 → 알람 코어 stop, 미룬 알람 보기 · 취소 → 알람 코어 list · cancel (미루기 예약은 코어가 가짐)
//   · 기상 확인: 해제 기록(alarm_events DISMISSED) 시각부터 10분의 화면 사용 구간(AlarmCore.getUsageSpans)으로 판정 (features/alarm/wake.ts evaluateWake, D14)
//     확정하면 alarm_events WAKE_CONFIRMED(event_at = θ를 넘은 시각 · 직접 응답은 응답 시각) + daily_records.wake_confirmed_at
//     놓침(MISSED)은 서버 배치(wake-check)가 씀 — 앱은 안 씀
import * as AlarmCore from '@capstone/alarm-core';

import { uploadEvents } from '@/lib/alarmSync';
import { now } from '@/lib/clock';
import { parseDbTime } from '@/lib/dbTime';
import { dayKey } from '@/lib/format';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

import { STANDALONE_TITLE } from './map';
import { WAKE_OBSERVE_MINUTES, type RingInfo, type Snooze, type WakeCheck } from './types';
import { evaluateWake, pickDismissedAt, thetaReachedAt, WAKE_PROMPT_WINDOW_MINUTES, WAKE_THETA_MINUTES, type UseSpan } from './wake';

// 폰 미루기는 10분 고정 (docs/alarm-core.md, 고르기는 D3 뒤)
const SNOOZE_MINUTES = 10;
const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// 울림 (H07)
// ---------------------------------------------------------------------------

// 실데이터에서는 이 화면으로 오지 않음 — 울림은 알람 코어 화면이 하고 해제 · 미루기도 거기서 함. 열려도 "울릴 알람을 찾을 수 없어요"
export async function getRing(): Promise<RingInfo | null> {
  return null;
}

// 울림 시작 · 화면을 나감 · 미루기는 알람 코어가 기록하고 처리하므로 앱이 할 일 없음
export async function startRing(): Promise<void> {}
export async function stopRing(): Promise<void> {}
export async function snoozeRing(): Promise<void> {}

// 해제 — 지금 울리는 알람을 코어가 해제 처리 (해제 기록은 코어가 남기고 올리기가 서버에 보냄)
export async function dismissRing(): Promise<void> {
  await AlarmCore.stop();
}

// 미룬 알람 (H01) — 폰이 가진 미루기 예약 중 다시 울릴 시각이 아직 안 된 가장 이른 것
//   홈의 덧붙임 줄이라 폰 예약을 못 읽어도 홈 전체가 막히지 않게 없는 것으로 봄
export async function getSnooze(): Promise<Snooze | null> {
  try {
    const t = now().getTime();
    const waiting = (await AlarmCore.list())
      .filter((a) => a.snoozeCount > 0 && a.nextRingAt > t)
      .sort((x, y) => x.nextRingAt - y.nextRingAt)
      .find((a) => a.type === 'WAKE' || a.type === 'PREPARE' || a.type === 'DEPARTURE');
    if (!waiting || (waiting.type !== 'WAKE' && waiting.type !== 'PREPARE' && waiting.type !== 'DEPARTURE')) return null;
    return { alarmId: waiting.id, kind: waiting.type, appointmentTitle: waiting.title || STANDALONE_TITLE, at: new Date(waiting.nextRingAt), minutes: SNOOZE_MINUTES };
  } catch {
    return null;
  }
}

// 미루기 취소 (H01) — 폰의 예약을 지움. 서버 알람은 그대로지만 시각이 이미 지나 다시 걸리지 않음
export async function cancelSnooze(alarmId: string): Promise<void> {
  await AlarmCore.cancel(alarmId);
}

// ---------------------------------------------------------------------------
// 기상 확인 (H08)
// ---------------------------------------------------------------------------

type WakeContext = {
  alarmId: string;
  title: string;
  groupId: string | null;
  groupName: string | null;
  dismissedAt: Date | null; // 판정에 쓸 해제 시각
  confirmed: { at: Date; how: 'self' | 'auto' } | null;
};

// 폰에 아직 못 올린 해제 기록도 같이 봄 (오프라인이거나 올리기가 막 실패했을 때)
async function pendingDismissals(alarmId?: string): Promise<{ alarmId: string; at: Date }[]> {
  try {
    return (await AlarmCore.getPendingEvents())
      .filter((e) => e.eventType === 'DISMISSED' && e.alarmType === 'WAKE' && (alarmId == null || e.alarmId === alarmId))
      .map((e) => ({ alarmId: e.alarmId, at: new Date(e.at) }));
  } catch {
    return [];
  }
}

async function loadWakeContext(userId: string, alarmId: string): Promise<WakeContext | null> {
  const [alarm, events, pending] = await Promise.all([
    supabase
      .from('alarms')
      .select('alarm_id, alarm_type, appointment_participants(appointments(title, group_id, groups(group_name)))')
      .eq('alarm_id', alarmId)
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('alarm_events')
      .select('event_type, event_at, input_source')
      .eq('alarm_id', alarmId)
      .eq('user_id', userId)
      .in('event_type', ['DISMISSED', 'WAKE_CONFIRMED'])
      .order('event_at'),
    pendingDismissals(alarmId),
  ]);
  if (alarm.error) throw alarm.error;
  if (events.error) throw events.error;
  if (!alarm.data || alarm.data.alarm_type !== 'WAKE') return null;

  const appointment = alarm.data.appointment_participants?.appointments ?? null;
  const rows = events.data ?? [];
  const confirmedRow = rows.find((r) => r.event_type === 'WAKE_CONFIRMED');
  const confirmed = confirmedRow ? { at: parseDbTime(confirmedRow.event_at), how: confirmedRow.input_source === 'USAGE' ? ('auto' as const) : ('self' as const) } : null;
  const dismissals = [...rows.filter((r) => r.event_type === 'DISMISSED').map((r) => parseDbTime(r.event_at)), ...pending.map((p) => p.at)];
  return {
    alarmId,
    title: appointment?.title ?? STANDALONE_TITLE,
    groupId: appointment?.group_id ?? null,
    groupName: appointment?.groups?.group_name ?? null,
    dismissedAt: pickDismissedAt(dismissals, confirmed?.at ?? null),
    confirmed,
  };
}

// 해제 뒤 화면 사용 구간(분) — 사용 정보 접근 권한이 없거나 못 읽으면(안드로이드 9 미만) null → 판정 대신 "일어났어요" 확인
async function readSpans(dismissedAt: Date, at: Date): Promise<UseSpan[] | null> {
  try {
    if (!(await AlarmCore.hasUsageAccess())) return null;
    const from = dismissedAt.getTime();
    const to = Math.max(from, Math.min(at.getTime(), from + WAKE_OBSERVE_MINUTES * MINUTE_MS));
    return AlarmCore.toUseSpans(await AlarmCore.getUsageSpans(from, to), from);
  } catch {
    return null;
  }
}

// 가장 최근에 끈 기상 알람 — 해제 기록(올린 것 + 폰에 남은 것) 중 windowMs 안에서 가장 늦은 것
async function findRecentDismissedWake(userId: string, windowMs: number): Promise<string | null> {
  const since = new Date(now().getTime() - windowMs);
  const { data, error } = await supabase
    .from('alarm_events')
    .select('alarm_id, event_at, alarms!inner(alarm_type)')
    .eq('user_id', userId)
    .eq('event_type', 'DISMISSED')
    .eq('alarms.alarm_type', 'WAKE')
    .gte('event_at', since.toISOString())
    .order('event_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const found = data?.[0] ? { alarmId: data[0].alarm_id, at: parseDbTime(data[0].event_at) } : null;
  const pending = (await pendingDismissals()).filter((p) => p.at.getTime() >= since.getTime()).sort((x, y) => y.at.getTime() - x.at.getTime())[0];
  return (pending && (!found || pending.at.getTime() > found.at.getTime()) ? pending.alarmId : found?.alarmId) ?? null;
}

// 확정 기록: alarm_events WAKE_CONFIRMED + 그날 daily_records.wake_confirmed_at (이미 있으면 처음 값 그대로). 같은 알람의 동시 확정은 한 번만
const writing = new Map<string, Promise<void>>();

async function writeConfirmation(userId: string, ctx: WakeContext, wokeAt: Date, how: 'self' | 'auto'): Promise<void> {
  const eventAt = wokeAt.toISOString();
  const event = await supabase.from('alarm_events').insert({
    user_id: userId,
    alarm_id: ctx.alarmId,
    event_type: 'WAKE_CONFIRMED',
    event_at: eventAt,
    client_event_id: AlarmCore.makeUuid(),
    input_source: how === 'self' ? 'BUTTON' : 'USAGE',
  });
  if (event.error) throw event.error;

  const day = dayKey(wokeAt);
  const record = await supabase.from('daily_records').select('record_id, wake_confirmed_at, wake_reported_at').eq('user_id', userId).eq('record_date', day).maybeSingle();
  if (record.error) throw record.error;
  const reportedAt = ctx.dismissedAt?.toISOString() ?? null;
  if (!record.data) {
    const inserted = await supabase.from('daily_records').insert({ user_id: userId, record_date: day, wake_confirmed_at: eventAt, wake_reported_at: reportedAt, data_source: 'ALARM' });
    if (!inserted.error) return;
    if (inserted.error.code !== '23505') throw inserted.error; // 그 사이 다른 곳이 만들었으면 아래처럼 빈 칸만 채움
  }
  const patch = {
    ...(record.data?.wake_confirmed_at ? {} : { wake_confirmed_at: eventAt }),
    ...(record.data?.wake_reported_at || !reportedAt ? {} : { wake_reported_at: reportedAt }),
  };
  if (!Object.keys(patch).length) return;
  const updated = await supabase.from('daily_records').update(patch).eq('user_id', userId).eq('record_date', day);
  if (updated.error) throw updated.error;
}

function settle(userId: string, ctx: WakeContext, wokeAt: Date, how: 'self' | 'auto'): Promise<void> {
  const running = writing.get(ctx.alarmId);
  if (running) return running;
  const task = writeConfirmation(userId, ctx, wokeAt, how).finally(() => writing.delete(ctx.alarmId));
  writing.set(ctx.alarmId, task);
  return task;
}

function toCheck(ctx: WakeContext, fields: Pick<WakeCheck, 'phase' | 'usage' | 'recent' | 'confirmed'>): WakeCheck {
  return {
    alarmId: ctx.alarmId,
    appointmentTitle: ctx.title,
    groupId: ctx.groupId,
    groupName: ctx.groupName,
    dismissedAt: ctx.dismissedAt ?? fields.confirmed?.at ?? now(),
    thetaMinutes: WAKE_THETA_MINUTES,
    ...fields,
  };
}

// 기상 확인 화면이 읽는 상태. alarmId가 없으면 가장 최근에 끈 기상 알람(12시간 안)
//   해제 시각부터 10분이 끝났는데 조건을 채웠으면 여기서 확정까지 기록함 (앱을 열지 않은 사이에 끝났어도 OS가 보관한 사용 구간으로 같은 결과 — 다음에 열 때 기록)
//   먼저 폰에 쌓인 울림 기록(방금 한 해제)을 서버에 올림
export async function getWakeCheck(alarmId?: string): Promise<WakeCheck | null> {
  await uploadEvents().catch(() => {});
  const userId = await requireUserId();
  const id = alarmId ?? (await findRecentDismissedWake(userId, 12 * 60 * MINUTE_MS));
  if (!id) return null;
  const ctx = await loadWakeContext(userId, id);
  if (!ctx) return null;

  const current = now();
  if (ctx.confirmed) {
    // 확정한 알람 — 막대에 그때 사용 시간을 보여 줌 (읽을 수 있을 때만)
    const spans = ctx.dismissedAt ? await readSpans(ctx.dismissedAt, current) : null;
    const shown = ctx.dismissedAt && spans ? evaluateWake({ dismissedAt: ctx.dismissedAt, now: current, spans }) : { usage: 0, recent: 0 };
    return toCheck(ctx, { phase: 'observing', usage: shown.usage, recent: shown.recent, confirmed: ctx.confirmed });
  }
  if (!ctx.dismissedAt) return null; // 아직 안 껐음 (울리기 전 · 울리는 중)

  const evaluation = evaluateWake({ dismissedAt: ctx.dismissedAt, now: current, spans: await readSpans(ctx.dismissedAt, current) });
  if (evaluation.phase === 'auto' && evaluation.reachedAt) {
    await settle(userId, ctx, evaluation.reachedAt, 'auto');
    return toCheck(ctx, { phase: 'observing', usage: evaluation.usage, recent: evaluation.recent, confirmed: { at: evaluation.reachedAt, how: 'auto' } });
  }
  return toCheck(ctx, { phase: evaluation.phase === 'observing' ? 'observing' : 'prompt', usage: evaluation.usage, recent: evaluation.recent, confirmed: null });
}

// 진행 중인 기상 확인 (H01 다시 들어가기) — 기상 알람을 끈 뒤 관찰 10분 + 응답 여유 30분 안이고 아직 확정 전이면
//   홈의 덧붙임 줄이라 읽지 못해도(오프라인 등) 홈 전체가 막히지 않게 없는 것으로 봄
export async function getWakeInProgress(): Promise<WakeCheck | null> {
  try {
    const userId = await requireUserId();
    const id = await findRecentDismissedWake(userId, (WAKE_OBSERVE_MINUTES + WAKE_PROMPT_WINDOW_MINUTES) * MINUTE_MS);
    if (!id) return null;
    const check = await getWakeCheck(id);
    return check && !check.confirmed ? check : null;
  } catch {
    return null;
  }
}

// 확인 알림 · 놓침 단계는 시간과 사용 구간으로 정해지고(getWakeCheck), 놓침(MISSED)은 서버 배치가 기록함 — 앱이 따로 남길 것이 없음
export async function promptWake(): Promise<void> {}
export async function missWake(): Promise<void> {}

// 기상 확정 기록. how = self(확인 알림에 직접 응답) → 응답한 지금 시각, auto → 누적 사용이 θ를 넘은 시각 (D14, 못 구하면 지금)
//   이미 확정한 알람이면 처음 판정 그대로 (두 번 눌러도 한 번만). 화면이 넘기는 판정 시각(at)은 가짜 시나리오 시각이라 쓰지 않음
export async function confirmWake(alarmId: string, how: 'self' | 'auto'): Promise<void> {
  const userId = await requireUserId();
  const ctx = await loadWakeContext(userId, alarmId);
  if (!ctx || ctx.confirmed) return;
  const current = now();
  let wokeAt = current;
  if (how === 'auto' && ctx.dismissedAt) {
    const spans = await readSpans(ctx.dismissedAt, current);
    wokeAt = (spans && thetaReachedAt(ctx.dismissedAt, spans, WAKE_THETA_MINUTES)) || current;
  }
  await settle(userId, ctx, wokeAt, how);
}
