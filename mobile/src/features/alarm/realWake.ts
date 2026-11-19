// ① 약속 기반 알람 — 실데이터 울림 · 기상 확인 (H07 · H08)
//   울림 소리 · 진동 · 다시 울림은 폰 알람 코어가 하고, 화면(H07 ring.tsx)은 앱이 잠금화면 위에 띄움 (#332, docs/alarm-core.md):
//     풀스크린 인텐트 → 길잡이 화면 → 앱 /ring?alarm=<id> → getRing = 코어의 지금 울리는 알람(getRinging)을 RingInfo로 바꿈
//     앱이 못 뜨면 코어의 네이티브 대체 화면이 해제 · 미루기를 함
//   · 해제 → 알람 코어 stop + 잠금화면 위 설정 되돌리기(잠금 해제 요청), 미루기 → 알람 코어 snooze + 되돌리기(앱을 뒤로)
//   · 미룬 알람 보기 · 취소 → 알람 코어 list · cancel (미루기 예약은 코어가 가짐)
//   · 기상 확인: 해제 기록(alarm_events DISMISSED) 시각부터 10분의 화면 사용 구간(AlarmCore.getUsageSpans)으로 판정 (features/alarm/wake.ts evaluateWake, D14)
//     확정하면 daily_records.wake_confirmed_at(빈 칸만) → alarm_events WAKE_CONFIRMED(event_at = θ를 넘은 시각 · 직접 응답은 응답 시각) 순으로 씀
//     이벤트가 확정의 표지라(이게 있으면 다시 안 씀) 맨 마지막에 쓰고, 번호(client_event_id)는 그 알람의 그 해제로 정해지는 고정 값 — 중간에 끊겨 다시 눌러도 둘 다 한 번씩만 남음
//     놓침(MISSED)은 서버 배치(wake-check)가 씀 — 앱은 안 씀
//     끄지 않고 울림이 끝난 날(해제 기록 없음)도 울린 기록(TRIGGERED) · 놓침이 있으면 확인 화면(확인 알림 단계)을 보여 [일어났어요]로 확정할 수 있음 (G1, 11/19)
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as AlarmCore from '@capstone/alarm-core';

import { reconcile, uploadEvents } from '@/lib/alarmSync';
import { now } from '@/lib/clock';
import { parseDbTime } from '@/lib/dbTime';
import { dayKey, startOfDay } from '@/lib/format';
import { isUuid, stableUuid } from '@/lib/uuid';
import { supabase } from '@/lib/supabase';
import { requireUserId } from '@/lib/user';

import { STANDALONE_TITLE } from './map';
import { clearWakePingNotices } from './wakePing';
import { AUTO_WAKE_FIX_MINUTES, EARLY_WAKE_MINUTES, LEVELS, toLevel, WAKE_OBSERVE_MINUTES, type Appointment, type AutoWake, type EarlyWake, type CancelSnoozeResult, type RingInfo, type Snooze, type WakeCheck } from './types';
import { evaluateWake, pickDismissedAt, thetaReachedAt, WAKE_PROMPT_WINDOW_MINUTES, WAKE_THETA_MINUTES, type UseSpan } from './wake';

// 미룬 알람의 Snooze.minutes에 넣는 참고 값 — 폰 list()는 고른 분을 안 돌려줘서 기본 미루기 시간(10분)을 넣음.
// 홈은 다시 울릴 시각(at)만 읽음. 5 · 10 · 15분 고르기와 3번 한도는 알람 코어 화면이 처리 (docs/alarm-core.md, D3 기본안 A)
const SNOOZE_MINUTES = 10;
const MINUTE_MS = 60_000;

// ---------------------------------------------------------------------------
// 울림 (H07)
// ---------------------------------------------------------------------------

// 알람 코어가 지금 울리는 알람을 H07이 그리는 모양으로 바꿈. 울리는 게 없거나 다른 알람이면 null ("울릴 알람을 찾을 수 없어요")
//   코어는 약속 정보(장소 · 음성 문장 · 중요도)를 안 가져서 제목만 코어 값이고, 나머지는 빈 값 — 화면(ring.tsx)이 빈 줄은 그리지 않음
//   울린 시각(at)은 지금 — 다시 울림 · 미루고 난 뒤의 울림에서도 "지금 몇 시"를 보이고, 미루기의 늦어요 계산이 지금을 기준으로 함(네이티브 화면과 같음)
export async function getRing(alarmId: string): Promise<RingInfo | null> {
  const ringing = await AlarmCore.getRinging();
  if (!ringing || ringing.id !== alarmId) return null;
  if (ringing.type !== 'WAKE' && ringing.type !== 'PREPARE' && ringing.type !== 'DEPARTURE') return null;
  const at = now();
  const appointment: Appointment = {
    id: ringing.id,
    title: ringing.title || STANDALONE_TITLE,
    at: new Date(ringing.atMillis),
    place: '',
    origin: '',
    transport: 'WALK',
    travelMinutes: 0,
    travelSource: '',
    bufferMinutes: 0,
    beforePrepMinutes: 0,
    prepMinutes: 0,
    predictedPrepMinutes: 0,
    importance: 'NORMAL',
    repeatLabel: '',
    recurrenceRule: null,
    groupName: null,
    items: [],
    withWake: ringing.type === 'WAKE',
    enabled: true,
    alarms: [],
    level: toLevel(ringing.intensity),
  };
  return {
    alarmId: ringing.id,
    kind: ringing.type,
    appointment,
    at,
    // AI 음성 브리핑이 있으면 지금 단계의 문장 (음성을 못 틀어도 화면에 오늘 일정이 남음). 없으면 안내 칸을 안 그림
    voiceTone: ringing.briefingText ? 'AI 브리핑' : '',
    voiceLine: ringing.briefingText ?? '',
    notice: ringing.heading || undefined,
    levelLine: `알람 강도 ${LEVELS[toLevel(ringing.intensity)].name}`,
    important: false,
    snoozeCount: ringing.snoozeCount,
    snoozeLimit: ringing.snoozeLimit,
    departAt: ringing.departAtMillis != null ? new Date(ringing.departAtMillis) : null,
  };
}

// H07을 띄웠다고 코어의 길잡이 화면에 알림 — 안 알리면 몇 초 뒤 네이티브 대체 화면이 뜸. 못 알려도(옛 APK) 화면은 계속 씀
export function ackRing(): void {
  try {
    AlarmCore.ackRingScreen();
  } catch {
    // 옛 APK에는 함수가 없음
  }
}

// 알람이 끝난 뒤 H07의 잠금화면 위 설정 되돌리기 — 끝난 알람의 뒷정리라 실패해도 해제 · 미루기 결과는 그대로 둠
async function releaseOverLock(dismissKeyguard: boolean): Promise<void> {
  try {
    await AlarmCore.releaseRingOverLock(dismissKeyguard);
  } catch {
    // 옛 APK에는 함수가 없음
  }
}

// 울림 시작 · 화면을 나감은 알람 코어가 기록하고 처리하므로 앱이 할 일 없음
export async function startRing(): Promise<void> {}
export async function stopRing(): Promise<void> {}

// 미루기 — 코어가 고른 분으로 다시 울릴 예약 + SNOOZED 기록. 한도(3번) · 허용 분(5 · 10 · 15)은 코어가 검사해 false를 줄 수 있음(이미 멈춤 포함)
//   미뤘으면 H07을 잠금화면 위에서 내리고 앱을 뒤로 보냄(잠금화면으로 돌아감)
export async function snoozeRing(_alarmId: string, minutes: number): Promise<boolean> {
  const snoozed = await AlarmCore.snooze(minutes);
  if (snoozed) await releaseOverLock(false);
  return snoozed;
}

// 해제 — 지금 울리는 알람을 코어가 해제 처리 (해제 기록은 코어가 남기고 올리기가 서버에 보냄). 그 뒤 잠금 해제를 요청해 기상 확인(H08)이 이어서 보이게 함
export async function dismissRing(): Promise<void> {
  await AlarmCore.stop();
  await releaseOverLock(true);
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
//   기상 알람이면 "미루기를 취소 = 이제 직접 일어남"이라 해제로 봄 (작성자 판단 — 되돌리기 쉬움): 폰 예약만 지우면 코어가 해제 기록을 안 남겨
//   H08 판정이 시작되지 않고 서버가 약 49분 뒤 놓침(MISSED)으로 적음. 그래서 그 알람의 DISMISSED(입력 출처 MANUAL)를 남기고 기상 확인으로 이어가게 알림
//   순서: 기록 → 폰 예약 지우기. 기록이 막히면(오프라인) 예약을 그대로 두어 알람이 다시 울리게 하고 던짐 — 반대 순서면 예약만 지워진 채 판정이 영영 없음
//   기록 번호는 그 알람의 그 회차(처음 예약 시각)로 정한 고정 값이라, 지우기가 중간에 끊겨 다시 눌러도 한 줄만 남음. 기상이 아닌 알람은 지금대로 예약만 지움
//   예약을 지운 뒤 폰에 해제 + 10분 판정을 검 (AlarmCore.scheduleWakeJudge) — 폰 안에서 끈 것과 같은 길이라 앱을 닫아도 10분 뒤 자동 확정 · 확인 알림이 뜸 (G13)
export async function cancelSnooze(alarmId: string): Promise<CancelSnoozeResult> {
  const scheduled = (await AlarmCore.list()).find((a) => a.id === alarmId);
  const wake = scheduled?.type === 'WAKE';
  const dismissedAt = now();
  if (scheduled && wake) {
    const userId = await requireUserId();
    const { error } = await supabase.from('alarm_events').upsert(
      {
        user_id: userId,
        alarm_id: alarmId,
        event_type: 'DISMISSED',
        event_at: dismissedAt.toISOString(),
        client_event_id: stableUuid('snooze-cancel-dismissed', alarmId, scheduled.atMillis),
        input_source: 'MANUAL',
      },
      { onConflict: 'client_event_id', ignoreDuplicates: true },
    );
    if (error) throw error;
  }
  await AlarmCore.cancel(alarmId);
  // 해제와 같은 길 — 폰이 해제 + 10분 판정(자동 확정 · 확인 알림)을 걸어 앱을 안 열어도 이어짐 (G13). 서버 기록의 해제 시각과 같은 값이라 확정 번호도 같음. 못 걸어도 앱이 열릴 때 재판정
  if (scheduled && wake) await AlarmCore.scheduleWakeJudge(alarmId, dismissedAt.getTime()).catch(() => {});
  return { wakeCheck: wake };
}

// ---------------------------------------------------------------------------
// 기상 확인 (H08)
// ---------------------------------------------------------------------------

type WakeContext = {
  alarmId: string;
  title: string;
  groupId: string | null;
  groupName: string | null;
  alarmAt: Date | null; // 그 기상 알람의 울릴 시각 (서버 alarms.scheduled_at) — 하루 기록의 날짜(알람 기준일)를 정함 (G14)
  dismissedAt: Date | null; // 판정에 쓸 해제 시각
  confirmed: { at: Date; how: 'self' | 'auto' } | null;
  corrected: boolean; // 자동 확정을 [아니에요]로 취소함 — 같은 해제로는 다시 자동 확정하지 않고 확인 알림 단계로 (G9)
  rang: boolean; // 해제 기록이 없어도 이 알람이 울린 기록(TRIGGERED)이나 놓침(MISSED)이 있음 — 끄지 않고 울림이 끝난 뒤에도 [일어났어요]를 누를 수 있게 (G1)
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

// 폰에 아직 못 올린 울림 기록(TRIGGERED)이 있는지 — 올리기 전에 푸시 · 알림으로 H08에 들어와도 울린 알람으로 봄
async function pendingRings(alarmId: string): Promise<boolean> {
  try {
    return (await AlarmCore.getPendingEvents()).some((e) => e.eventType === 'TRIGGERED' && e.alarmType === 'WAKE' && e.alarmId === alarmId);
  } catch {
    return false;
  }
}

async function loadWakeContext(userId: string, alarmId: string): Promise<WakeContext | null> {
  if (!isUuid(alarmId)) return null; // 가짜 데이터 시절 주소(a1:WAKE)가 남아 있어도 DB 형식 오류 대신 "없음"
  const [alarm, events, pending, pendingRang, corrected] = await Promise.all([
    supabase
      .from('alarms')
      .select('alarm_id, alarm_type, scheduled_at, appointment_participants(appointments(title, group_id, groups(group_name)))')
      .eq('alarm_id', alarmId)
      .eq('user_id', userId)
      .maybeSingle(),
    supabase
      .from('alarm_events')
      .select('event_type, event_at, input_source')
      .eq('alarm_id', alarmId)
      .eq('user_id', userId)
      .in('event_type', ['DISMISSED', 'WAKE_CONFIRMED', 'TRIGGERED', 'MISSED'])
      .order('event_at'),
    pendingDismissals(alarmId),
    pendingRings(alarmId),
    isCorrected(alarmId),
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
    alarmAt: alarm.data.scheduled_at ? parseDbTime(alarm.data.scheduled_at) : null,
    dismissedAt: pickDismissedAt(dismissals, confirmed?.at ?? null),
    confirmed,
    corrected,
    rang: pendingRang || rows.some((r) => r.event_type === 'TRIGGERED' || r.event_type === 'MISSED'),
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

// 가장 최근에 울린 기상 알람 — 울림(TRIGGERED) · 놓침(MISSED) 기록 중 windowMs 안에서 가장 늦은 것. 끄지 않고 울림이 끝난 날 푸시로 H08을 열면 이 알람을 확인 대상으로 (G1)
async function findRecentRungWake(userId: string, windowMs: number): Promise<string | null> {
  const since = new Date(now().getTime() - windowMs);
  const { data, error } = await supabase
    .from('alarm_events')
    .select('alarm_id, event_at, alarms!inner(alarm_type)')
    .eq('user_id', userId)
    .in('event_type', ['TRIGGERED', 'MISSED'])
    .eq('alarms.alarm_type', 'WAKE')
    .gte('event_at', since.toISOString())
    .order('event_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const found = data?.[0] ? { alarmId: data[0].alarm_id, at: parseDbTime(data[0].event_at) } : null;
  let pendingId: string | null = null;
  try {
    const pending = (await AlarmCore.getPendingEvents())
      .filter((e) => e.eventType === 'TRIGGERED' && e.alarmType === 'WAKE' && e.at >= since.getTime())
      .sort((x, y) => y.at - x.at)[0];
    if (pending && (!found || pending.at > found.at.getTime())) pendingId = pending.alarmId;
  } catch {
    // 폰 기록을 못 읽으면 서버 것만
  }
  return pendingId ?? found?.alarmId ?? null;
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

// 확정 기록: 그날 daily_records.wake_confirmed_at (이미 있으면 처음 값 그대로) → alarm_events WAKE_CONFIRMED. 같은 알람의 동시 확정은 한 번만
//   이벤트를 마지막에 쓰는 이유: loadWakeContext가 이 이벤트로 "이미 확정"을 판단하므로, 먼저 쓰면 그날 기록을 쓰다 끊겼을 때
//   다시 눌러도 확정으로 보고 아무것도 안 해 daily_records(달력 점 · 주간 요약이 읽는 곳)가 영영 안 채워짐
//   이벤트 번호는 알람 id + 해제 시각으로 정한 고정 값이라 upsert(ignoreDuplicates)가 겹쳐 불려도 한 줄만 남김
const writing = new Map<string, Promise<void>>();

// 그 알람의 그 해제에 대한 확정 기록 번호. 해제 기록이 없으면(직접 응답만) 확정한 날로
const confirmEventId = (ctx: WakeContext, wokeAt: Date) => stableUuid('wake-confirmed', ctx.alarmId, ctx.dismissedAt?.getTime() ?? dayKey(wokeAt));

async function writeConfirmation(userId: string, ctx: WakeContext, wokeAt: Date, how: 'self' | 'auto'): Promise<void> {
  const eventAt = wokeAt.toISOString();
  await writeDailyRecord(userId, ctx, wokeAt);
  const event = await supabase.from('alarm_events').upsert(
    {
      user_id: userId,
      alarm_id: ctx.alarmId,
      event_type: 'WAKE_CONFIRMED',
      event_at: eventAt,
      client_event_id: confirmEventId(ctx, wokeAt),
      input_source: how === 'self' ? 'BUTTON' : 'USAGE',
    },
    { onConflict: 'client_event_id', ignoreDuplicates: true },
  );
  if (event.error) throw event.error;
}

// 하루 기록의 날짜 = 알람이 울린 날 — 서버 private.wake_day와 같은 규칙: 확인이 알람 시각의 [6시간 전, 18시간 뒤) 안이면 알람의 한국 날짜, 아니면 확인한 날
//   자정을 넘겨 확인해도(23:50 알람 → 00:10 확인) 서버 트리거가 만드는 줄과 같은 날이라 하루 기록이 둘로 안 갈림 (G14)
const WAKE_DAY_BEFORE_MS = 6 * 60 * MINUTE_MS;
const WAKE_DAY_AFTER_MS = 18 * 60 * MINUTE_MS;
export function wakeDay(alarmAt: Date | null, wokeAt: Date): string {
  if (alarmAt && wokeAt.getTime() >= alarmAt.getTime() - WAKE_DAY_BEFORE_MS && wokeAt.getTime() < alarmAt.getTime() + WAKE_DAY_AFTER_MS) return dayKey(alarmAt);
  return dayKey(wokeAt);
}

// 그날 기록의 빈 칸(기상 확인 · 해제 시각)만 채움 — 이미 있는 값은 덮지 않아서 몇 번을 불러도 같은 결과
async function writeDailyRecord(userId: string, ctx: WakeContext, wokeAt: Date): Promise<void> {
  const eventAt = wokeAt.toISOString();
  const day = wakeDay(ctx.alarmAt, wokeAt);
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

// 확정 기록이 서버에 들어가면 폰이 띄운 "지금 일어나셨나요?" 알림을 거둠 (먼저 깼어요 · H08 [일어났어요] · 자동 판정이 모두 settle을 지남). 실패는 삼킴 — 알림이 남아도 기록에는 영향 없음
async function dismissWakePrompt(alarmId: string): Promise<void> {
  try {
    await AlarmCore.dismissWakePrompt(alarmId);
  } catch {
    // 예전 APK · 웹 · iOS는 할 일 없음
  }
}

function settle(userId: string, ctx: WakeContext, wokeAt: Date, how: 'self' | 'auto'): Promise<void> {
  const running = writing.get(ctx.alarmId);
  if (running) return running;
  const task = writeConfirmation(userId, ctx, wokeAt, how)
    .then(() => dismissWakePrompt(ctx.alarmId))
    .then(() => clearWakePingNotices()) // 친구가 보낸 깨우기 알림도 거둠 (NEW-1)
    .then(() => clearCorrected(ctx.alarmId))
    .finally(() => writing.delete(ctx.alarmId));
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
  // 알람 id가 없으면(푸시 · 앱 아이콘으로 엶) 가장 최근에 끈 기상 알람, 없으면 끄지 않고 울림이 끝난(놓친) 기상 알람
  const id = alarmId ?? (await findRecentDismissedWake(userId, 12 * 60 * MINUTE_MS)) ?? (await findRecentRungWake(userId, 12 * 60 * MINUTE_MS));
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
  if (!ctx.dismissedAt) {
    // 안 껐어도 이 알람이 울린 기록 · 놓침이 있으면 확인 화면 — 끄지 않고 울림이 끝난 뒤(놓침 푸시) [일어났어요]로 직접 확인할 길 (G1). 판정할 해제가 없으니 확인 알림 단계로
    //   울리기 전이면 울린 기록이 없어 그대로 null (빈 화면)
    return ctx.rang ? toCheck(ctx, { phase: 'prompt', usage: 0, recent: 0, confirmed: null }) : null;
  }

  const evaluation = evaluateWake({ dismissedAt: ctx.dismissedAt, now: current, spans: await readSpans(ctx.dismissedAt, current) });
  // 자동 확정을 [아니에요]로 취소한 알람은 다시 자동 확정하지 않고 확인 알림 단계(직접 [일어났어요])로 (G9)
  if (ctx.corrected && current.getTime() >= ctx.dismissedAt.getTime() + WAKE_OBSERVE_MINUTES * MINUTE_MS) {
    return toCheck(ctx, { phase: 'prompt', usage: evaluation.usage, recent: evaluation.recent, confirmed: null });
  }
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

// 앱이 앞에 올 때 부름 (hooks/useWakeRecheck) — 최근 12시간에 끈 기상 알람 중 아직 확정이 없는 것을 H08과 같은 판정으로 다시 봄.
//   알람을 끈 뒤 앱을 안 열었어도(7장 A "판정은 해제 10분 뒤에 나고") 열 때 OS가 보관한 사용 구간으로 같은 결과를 내서, 조건을 채웠으면 확정(USAGE)까지 기록
//   — 판정 · 쓰기는 getWakeCheck와 같은 함수(evaluateWake · thetaReachedAt → settle)라 H08에서 먼저 확정했거나 두 번 불려도 기록은 한 번뿐 (고정 번호).
//   조건을 못 채운 것은 아무것도 안 씀: 확인 알림 단계는 H08을 열어야 보이고, 놓침(MISSED)은 서버 배치가 기록함. 네이티브(알람 코어 WakeJudgeWorker)도 해제 + 10분 2초에 같은 규칙 · 같은 번호로 스스로 판정해 서버에 기록하므로 앱이 열려 다시 판정할 때는 서버의 확정 기록을 보고 건너뜀 (docs/alarm-core.md)
//   한 알람이 실패해도 다른 알람은 이어서 판정하고, 확정한 알람 id를 돌려줌
const RECHECK_WINDOW_MS = 12 * 60 * MINUTE_MS;
const RECHECK_LIMIT = 20;

async function findUnconfirmedDismissedWakes(userId: string, windowMs: number): Promise<string[]> {
  const since = new Date(now().getTime() - windowMs).toISOString();
  const { data, error } = await supabase
    .from('alarm_events')
    .select('alarm_id, event_type, event_at, alarms!inner(alarm_type)')
    .eq('user_id', userId)
    .in('event_type', ['DISMISSED', 'WAKE_CONFIRMED'])
    .eq('alarms.alarm_type', 'WAKE')
    .gte('event_at', since)
    .order('event_at', { ascending: false })
    .limit(RECHECK_LIMIT * 5);
  if (error) throw error;
  const rows = data ?? [];
  const confirmed = new Set(rows.filter((r) => r.event_type === 'WAKE_CONFIRMED').map((r) => r.alarm_id));
  const dismissed = rows.filter((r) => r.event_type === 'DISMISSED').map((r) => r.alarm_id); // 최근에 끈 알람부터
  return [...new Set(dismissed)].filter((id) => !confirmed.has(id)).slice(0, RECHECK_LIMIT);
}

export async function recheckRecentWakes(): Promise<string[]> {
  await uploadEvents().catch(() => {}); // 방금 한 해제가 폰에 남아 있으면 먼저 올림 (확정 기록이 해제 기록보다 먼저 들어가지 않게)
  const userId = await requireUserId();
  const confirmedIds: string[] = [];
  for (const id of await findUnconfirmedDismissedWakes(userId, RECHECK_WINDOW_MS)) {
    try {
      const check = await getWakeCheck(id);
      if (check?.confirmed) confirmedIds.push(id);
    } catch {
      // 이 알람은 다음 기회에 — 다른 알람은 이어서
    }
  }
  return confirmedIds;
}

// 확인 알림 · 놓침 단계는 시간과 사용 구간으로 정해지고(getWakeCheck), 놓침(MISSED)은 서버 배치가 기록함 — 앱이 따로 남길 것이 없음
// 확인 알림에도 응답이 없으면 알람을 다시 울리지 않고 MISSED만 (D2 = B)
export async function promptWake(): Promise<void> {}

// ---------------------------------------------------------------------------
// 기상 정정 (D61 "판정마다 그 자리에서 1탭 정정", G9)
// ---------------------------------------------------------------------------

// 자동 확정을 취소했다는 표시 — 폰 저장소. 서버에는 정정 기록을 남길 이벤트 종류가 없어 폰에만 둠 (다른 기기 · 재설치에서는 다시 자동 확정될 수 있음, PR 본문 "서버 필요 사항")
const CORRECTED_KEY = 'respec.wake.corrected.';

async function isCorrected(alarmId: string): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(CORRECTED_KEY + alarmId)) != null;
  } catch {
    return false;
  }
}

async function markCorrected(alarmId: string): Promise<void> {
  try {
    await AsyncStorage.setItem(CORRECTED_KEY + alarmId, new Date(now().getTime()).toISOString());
  } catch {
    // 못 쓰면 이번 실행에만 — 취소 자체는 서버에 이미 반영
  }
}

async function clearCorrected(alarmId: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(CORRECTED_KEY + alarmId);
  } catch {
    // 남아도 확정 뒤에는 쓰이지 않음
  }
}

// 자동(USAGE)으로 확정한 기상 가운데 확정 뒤 60분 안인 가장 최근 한 건 — 홈 카드 "기상 오전 7:11 [아니에요]". 취소하면 그 기록이 지워져 이 읽기에 안 나옴
//   덧붙임 카드라 못 읽어도 홈이 막히지 않게 부르는 쪽이 삼킴
export async function getAutoWake(): Promise<AutoWake | null> {
  const userId = await requireUserId();
  const since = new Date(now().getTime() - AUTO_WAKE_FIX_MINUTES * MINUTE_MS);
  const { data, error } = await supabase
    .from('alarm_events')
    .select('alarm_id, event_at')
    .eq('user_id', userId)
    .eq('event_type', 'WAKE_CONFIRMED')
    .eq('input_source', 'USAGE')
    .gte('event_at', since.toISOString())
    .order('event_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = data?.[0];
  return row ? { alarmId: row.alarm_id, at: parseDbTime(row.event_at) } : null;
}

// [아니에요] — 자동 확정한 기상을 그 자리에서 취소하고 확인 알림 단계(H08)로 되돌림
//   순서: 취소 표시(폰) → 확정 기록(alarm_events WAKE_CONFIRMED USAGE) 지우기 → 그날 하루 기록의 기상 칸 비우기. 끊겨도 다시 눌러 이어 가게 표시가 먼저
//   하루 기록은 확정 시각이 그 값 그대로일 때만 비움 — 그 사이 다른 확정이 덮었으면 그대로 둠. 버튼 · 확인으로 확정한 기록은 안 지움(false)
//   확정 번호는 알람 + 해제 시각으로 정한 고정 값이라 다시 [일어났어요]를 눌러도 같은 번호로 새로 들어감(지워진 뒤라 충돌 없음)
export async function correctAutoWake(alarmId: string): Promise<boolean> {
  const userId = await requireUserId();
  const ctx = await loadWakeContext(userId, alarmId);
  if (!ctx) return false;
  const found = await supabase
    .from('alarm_events')
    .select('event_at')
    .eq('user_id', userId)
    .eq('alarm_id', alarmId)
    .eq('event_type', 'WAKE_CONFIRMED')
    .eq('input_source', 'USAGE')
    .limit(1);
  if (found.error) throw found.error;
  const confirmedAt = found.data?.[0]?.event_at;
  if (!confirmedAt) return false; // 자동 확정이 아님 (직접 확정 · 확정 없음)
  await markCorrected(alarmId);
  const removed = await supabase.from('alarm_events').delete().eq('user_id', userId).eq('alarm_id', alarmId).eq('event_type', 'WAKE_CONFIRMED').eq('input_source', 'USAGE');
  if (removed.error) throw removed.error;
  const cleared = await supabase
    .from('daily_records')
    .update({ wake_confirmed_at: null })
    .eq('user_id', userId)
    .eq('record_date', wakeDay(ctx.alarmAt, parseDbTime(confirmedAt)))
    .eq('wake_confirmed_at', confirmedAt);
  if (cleared.error) throw cleared.error;
  return true;
}

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

// H08 [먼저 깼어요] — 지금부터 60분 안에 울릴 켜진 기상 알람 중 가장 이른 것 (D61). 그 알람이 이미 울렸거나, 그날 이미 기상을 확인했으면 없음
//   기상 확인은 사람마다 하루 한 건(둘째는 서버가 버림, 7-d4) — 알람이 달라도 그날 확인이 있으면 묻지 않음
//   울림 기록은 그 알람 시각 6시간 전부터만 봄(서버 group_wake_rows와 같은 구간) — 반복 알람의 지난 회차 기록에 걸리지 않게
//   폰 알람 자체는 그대로 둠(미리 끄기는 알람 코어 몫) — 확인이 먼저 있으면 그 회차의 울림 · 미루기 기록은 서버가 끝냄 (7-d5)
export async function getEarlyWake(): Promise<EarlyWake | null> {
  const userId = await requireUserId();
  const current = now();
  const { data, error } = await supabase
    .from('alarms')
    .select('alarm_id, scheduled_at')
    .eq('user_id', userId)
    .eq('alarm_type', 'WAKE')
    .eq('is_enabled', true)
    .gt('scheduled_at', current.toISOString())
    .lte('scheduled_at', new Date(current.getTime() + EARLY_WAKE_MINUTES * MINUTE_MS).toISOString())
    .order('scheduled_at')
    .limit(1);
  if (error) throw error;
  const alarm = data?.[0];
  if (!alarm) return null;
  const at = parseDbTime(alarm.scheduled_at);
  const [rang, confirmed] = await Promise.all([
    supabase
      .from('alarm_events')
      .select('event_type')
      .eq('alarm_id', alarm.alarm_id)
      .eq('user_id', userId)
      .in('event_type', ['TRIGGERED', 'DISMISSED'])
      .gte('event_at', new Date(at.getTime() - EARLY_RANG_LOOKBACK_MS).toISOString())
      .limit(1),
    confirmedOnDay(userId, at),
  ]);
  if (rang.error) throw rang.error;
  if (rang.data?.length || confirmed) return null;
  return { alarmId: alarm.alarm_id, at };
}

const EARLY_RANG_LOOKBACK_MS = 6 * 60 * MINUTE_MS;

// 그 알람이 울리는 날(한국 시간 하루)에 이미 기상 확인이 있는지 — 알람과 상관없이 사람 단위
async function confirmedOnDay(userId: string, at: Date): Promise<boolean> {
  const from = startOfDay(at);
  const { data, error } = await supabase
    .from('alarm_events')
    .select('event_type')
    .eq('user_id', userId)
    .eq('event_type', 'WAKE_CONFIRMED')
    .gte('event_at', from.toISOString())
    .lt('event_at', new Date(from.getTime() + 24 * 60 * MINUTE_MS).toISOString())
    .limit(1);
  if (error) throw error;
  return !!data?.length;
}

// [먼저 깼어요]를 누름 — 지금 시각으로 기상 확인(BUTTON, 그룹에는 바로 '일어났어요', D61 · 7-20) + 그날 기록. 그 알람 · 그날 이미 확인했으면 그대로
export async function confirmEarlyWake(alarmId: string): Promise<void> {
  const userId = await requireUserId();
  const ctx = await loadWakeContext(userId, alarmId);
  if (!ctx || ctx.confirmed) return;
  const current = now();
  if (await confirmedOnDay(userId, current)) return;
  await settle(userId, ctx, current, 'self');
  // 확정했으니 그날 기상 알람은 이제 울리면 안 됨 — 폰 예약을 바로 지움 (서버 행은 그대로, 맞추기가 기상 확인 기록을 보고 뺌 · 앱이 앞에 올 때 되살아나지 않음). 실패해도 확정은 이미 기록됐으니 삼킴
  await reconcile({ alarmIds: [alarmId] }).catch(() => {});
}
