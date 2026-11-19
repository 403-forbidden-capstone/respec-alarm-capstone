// 폰 네이티브가 앱을 열지 않고 올리는 기록 (알림 버튼 · 자동 기상 판정) — alarm-events-device의 본문
//   인증은 호출하는 쪽(기기 키, _shared/briefing-device.ts deviceUser)이 하고, 여기는 키 주인의 user_id만 받음 (서버 키로 쓰므로 모든 쿼리에 user_id 조건)
//   앱(lib/alarmSync insertEvents · features/alarm/realWake)이 로그인 토큰으로 쓰는 것과 같은 내용을 같은 순서로 씀 — 나중에 앱이 같은 기록을 올려도 한 줄만 남음
//     · alarm_events: client_event_id 유일 + 충돌 무시 (앱 upsert와 같음). 그 알람이 키 주인 것이 아니면 건너뜀(앱 쪽은 RLS가 막음)
//     · 받는 조합은 폰이 실제로 보내는 것만 (deviceEventAllowed): 알림 버튼 ACKNOWLEDGED · ARRIVAL_CONFIRMED = BUTTON, 울림 · 미루기 TRIGGERED · SNOOZED = 기상 · 준비 · 출발 · 도착 알람 + BUTTON(앱이 열릴 때 올리는 alarmSync uploadEvents와 같은 값),
//       해제 DISMISSED = 기상 · 준비 · 출발 알람 + BUTTON, 기상 확정 WAKE_CONFIRMED = WAKE 알람 + USAGE. wake도 WAKE 알람만. 나머지는 조용히 건너뜀(stored · skipped에 안 셈)
//     · wake: daily_records의 빈 칸(기상 확인 · 해제 시각)만 채움 → 그 뒤에 이벤트 (이벤트가 확정의 표지라 맨 마지막, realWake.ts writeConfirmation과 같은 순서)
//   원탭(출발 · 도착 · 준비 시작) · 준비 알람 해제(=준비 시작)를 appointment_participants에 옮기는 일은 (출발 알람의 해제는 기록만 — 출발은 위치 자동 · 감지가 꺼진 폰의 ACKNOWLEDGED로) alarm_events INSERT 트리거가 함 — 여기서는 안 건드림
// 순수 TS (Deno API 없음) — node --test로 시험 (device-events.test.ts)
import { must } from './db.ts';
import { HttpError } from './errors.ts';
import { Reader } from './read.ts';
import type { Db } from './supabase.ts';

// 폰이 이 길로 올릴 수 있는 종류 — 알림 버튼(ACKNOWLEDGED · ARRIVAL_CONFIRMED) · 울림 · 미루기 · 해제(TRIGGERED · SNOOZED · DISMISSED) · 자동 기상 확정. 11/19부터 기상 · 준비 · 출발 모두 진짜 알람이라 앱을 안 열어도 올림
export const DEVICE_EVENT_TYPES = ['TRIGGERED', 'SNOOZED', 'ACKNOWLEDGED', 'ARRIVAL_CONFIRMED', 'DISMISSED', 'WAKE_CONFIRMED'] as const;
const INPUT_SOURCES = ['BUTTON', 'USAGE'] as const;
const RING_ALARM_TYPES = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE']; // 울리고 미루는 알람 — 도착도 울림 · 미루기는 올림 (해제는 알림 버튼이라 ARRIVAL_CONFIRMED)
const DISMISS_ALARM_TYPES = ['WAKE', 'PREPARE', 'DEPARTURE']; // 해제 기록을 올리는 알람 (준비 해제 = 준비 시작, 출발 해제는 기록만)
const MAX_EVENTS = 20;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

// 이 알람 종류 · 출처 조합을 폰이 보내는지 (키가 새도 이 밖의 기록은 못 만듦 — 예: 남의 알람이 아니어도 MANUAL · VOICE 확정이나 USAGE 해제는 거절)
export function deviceEventAllowed(eventType: string, inputSource: string, alarmType: string): boolean {
  if (eventType === 'WAKE_CONFIRMED') return alarmType === 'WAKE' && inputSource === 'USAGE';
  if (eventType === 'TRIGGERED' || eventType === 'SNOOZED') return inputSource === 'BUTTON' && RING_ALARM_TYPES.includes(alarmType);
  if (eventType === 'DISMISSED') return inputSource === 'BUTTON' && DISMISS_ALARM_TYPES.includes(alarmType);
  if (eventType === 'ACKNOWLEDGED' || eventType === 'ARRIVAL_CONFIRMED') return inputSource === 'BUTTON';
  return false;
}

export type DeviceEventsResult = { stored: number; skipped: number; wake_recorded: boolean };

type EventRow = {
  user_id: string;
  alarm_id: string;
  client_event_id: string;
  event_type: (typeof DEVICE_EVENT_TYPES)[number];
  event_at: string;
  sequence_no: number;
  snooze_minutes: number | null;
  input_source: (typeof INPUT_SOURCES)[number];
};
type Wake = { alarm_id: string; record_date: string; wake_confirmed_at: string; wake_reported_at: string | null };

function parse(raw: unknown): { events: Omit<EventRow, 'user_id'>[]; wake: Wake | null } {
  const root = Reader.root(raw);
  const events = (root.objects('events', { max: MAX_EVENTS }) ?? []).map((e) => ({
    alarm_id: e.uuid('alarm_id', { required: true }) ?? '',
    client_event_id: e.uuid('client_event_id', { required: true }) ?? '',
    event_type: e.oneOf('event_type', DEVICE_EVENT_TYPES, { required: true }) ?? 'ACKNOWLEDGED',
    event_at: e.date('event_at', { required: true })?.toISOString() ?? '',
    sequence_no: e.int('sequence_no', { min: 1, max: 1000 }) ?? 1,
    snooze_minutes: e.int('snooze_minutes', { min: 1, max: 120 }) ?? null,
    input_source: e.oneOf('input_source', INPUT_SOURCES, { required: true }) ?? 'BUTTON',
  }));
  const w = root.object('wake');
  const wake = w
    ? {
        alarm_id: w.uuid('alarm_id', { required: true }) ?? '',
        record_date: w.string('record_date', { required: true, pattern: DAY }) ?? '',
        wake_confirmed_at: w.date('wake_confirmed_at', { required: true })?.toISOString() ?? '',
        wake_reported_at: w.date('wake_reported_at')?.toISOString() ?? null,
      }
    : null;
  root.finish();
  if (!events.length && !wake) throw new HttpError('VALIDATION_FAILED', '올릴 기록이 없어요');
  return { events, wake };
}

/** 키 주인(userId)의 기록을 씀. 같은 요청을 다시 보내도 같은 결과 (번호 충돌 무시 · 빈 칸만 채움) */
export async function recordDeviceEvents(service: Db, userId: string, raw: unknown): Promise<DeviceEventsResult> {
  const { events, wake } = parse(raw);
  const ids = [...new Set([...events.map((e) => e.alarm_id), ...(wake ? [wake.alarm_id] : [])])];
  const mine = new Map(
    must<{ alarm_id: string; alarm_type: string }[]>('device alarms', await service.from('alarms').select('alarm_id, alarm_type').eq('user_id', userId).in('alarm_id', ids)).map((a) => [a.alarm_id, a.alarm_type]),
  );

  let wakeRecorded = false;
  if (wake && mine.get(wake.alarm_id) === 'WAKE') {
    await fillDailyRecord(service, userId, wake);
    wakeRecorded = true;
  }
  const owned = events.filter((e) => mine.has(e.alarm_id));
  const rows: EventRow[] = owned.filter((e) => deviceEventAllowed(e.event_type, e.input_source, mine.get(e.alarm_id)!)).map((e) => ({ ...e, user_id: userId }));
  if (rows.length) {
    must('device events', await service.from('alarm_events').upsert(rows, { onConflict: 'client_event_id', ignoreDuplicates: true }));
  }
  return { stored: rows.length, skipped: events.length - owned.length, wake_recorded: wakeRecorded };
}

// 그날 기록의 빈 칸만 채움 — 이미 있는 값은 덮지 않음 (앱 realWake.ts writeDailyRecord와 같음)
async function fillDailyRecord(service: Db, userId: string, wake: Wake): Promise<void> {
  type Row = { wake_confirmed_at: string | null; wake_reported_at: string | null };
  const read = async () =>
    must<Row | null>(
      'device daily record',
      await service.from('daily_records').select('wake_confirmed_at, wake_reported_at').eq('user_id', userId).eq('record_date', wake.record_date).maybeSingle(),
    );
  let record = await read();
  if (!record) {
    const inserted = await service
      .from('daily_records')
      .insert({ user_id: userId, record_date: wake.record_date, wake_confirmed_at: wake.wake_confirmed_at, wake_reported_at: wake.wake_reported_at, data_source: 'ALARM' });
    if (!inserted.error) return;
    if (inserted.error.code !== '23505') must('device daily record insert', inserted);
    record = await read(); // 그 사이 다른 곳이 만들었으면 그 줄을 다시 읽어 빈 칸만 채움 (처음 읽은 빈 값으로 덮지 않게)
  }
  const patch = {
    ...(record?.wake_confirmed_at ? {} : { wake_confirmed_at: wake.wake_confirmed_at }),
    ...(record?.wake_reported_at || !wake.wake_reported_at ? {} : { wake_reported_at: wake.wake_reported_at }),
  };
  if (!Object.keys(patch).length) return;
  must('device daily record update', await service.from('daily_records').update(patch).eq('user_id', userId).eq('record_date', wake.record_date));
}
