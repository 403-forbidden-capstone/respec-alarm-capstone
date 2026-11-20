// 시나리오 시험의 "세계" — 가짜 서버(db) · 가짜 폰(phone) · 앱(app) · 시계(clock)를 묶고, 시드를 만들고, 결과를 읽기 쉬운 글자로 바꿔 줌
//   앱 모듈은 실제 것을 그대로 씀. 앱 상태는 실제 루트가 거는 훅(useAlarmSync · useWakeRecheck · useLocationSync · useOneTapFollowUp · usePushLinks)을 그려서 만듦
//     앞 = 훅이 도는 중 · 뒤 = 훅은 그대로(AppState 신호만 'background') · 꺼짐 = 훅을 내림(JS 화면 경로가 안 돎, 지오펜스 작업 같은 헤드리스 작업만 폰이 깨움)
import AsyncStorage from '@react-native-async-storage/async-storage';
import { jest } from '@jest/globals';
import { createElement } from 'react';
import { AppState, PermissionsAndroid } from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { useOneTapFollowUp } from '@/features/alarm/hooks/useOneTapFollowUp';
import { useWakeRecheck } from '@/features/alarm/hooks/useWakeRecheck';
import { currentUserId } from '@/lib/user';
import type { RingPackage } from '@capstone/alarm-core';
import '@/features/push/backgroundTask'; // 앱 진입 파일(index.js)이 먼저 불러 헤드리스 푸시 작업을 정의하는 것과 같음
import { usePushLinks, resetPushLinks } from '@/features/push/usePushLinks';
import { bumpEpoch } from '@/features/location/lock';
import { useLocationSync } from '@/features/location/useLocationSync';
import { setSigningOut, syncNow } from '@/lib/alarmSync';
import { useAlarmSync } from '@/lib/alarmSync/useAlarmSync';
import { setRealTime } from '@/lib/clock';
import { stableUuid } from '@/lib/uuid';

import { db } from './fakeDb';
import { navLog, resetNav } from './nav';
import { phone } from './phone';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export const ME = 'user-me';
export const FRIEND = 'user-friend';
const HOUR = 3_600_000;
const MIN = 60_000;
const KST = 9 * HOUR;

// 이 시험이 도는 날 — 시험마다 하루씩 뒤로 옮겨 앞 시험의 시각 기억(5분 제한 등)에 안 걸리게
let dayCounter = 0;
const BASE_DAY = Date.parse('2026-11-20T00:00:00+09:00');

export const uid = (name: string): string => stableUuid('scenario', name);
export const settle = async (turns = 40) => {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

export const hhmm = (ms: number): string => {
  const d = new Date(ms + KST);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

type AppMode = 'off' | 'foreground' | 'background';

function Root({ userId }: { userId: string | null }) {
  useOneTapFollowUp(); // useAlarmSync보다 먼저 (루트 레이아웃과 같은 순서)
  useAlarmSync({ active: true, userId, timeZone: 'Asia/Seoul' });
  useWakeRecheck({ active: true, userId });
  useLocationSync({ active: true, userId });
  usePushLinks({ active: true, userId });
  return null;
}

class App {
  state: AppMode = 'off';
  private tree: ReactTestRenderer | null = null;
  private appStateListeners = new Set<(s: string) => void>();
  private spy: ReturnType<typeof jest.spyOn> | null = null;
  private permissionSpy: ReturnType<typeof jest.spyOn> | null = null;

  install() {
    this.spy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((_type: string, handler: (s: string) => void) => {
      this.appStateListeners.add(handler);
      return { remove: () => void this.appStateListeners.delete(handler) };
    }) as never);
    // 알림 권한은 폰이 정함 (PermissionsAndroid.check) — 읽기만 가짜
    this.permissionSpy = jest.spyOn(PermissionsAndroid, 'check').mockImplementation((async () => phone.notificationsGranted) as never);
  }

  uninstall() {
    this.spy?.mockRestore();
    this.permissionSpy?.mockRestore();
    this.spy = null;
    this.permissionSpy = null;
  }

  // 앱을 처음부터 엶 (꺼져 있다가 아이콘을 누르거나 알림을 눌러서) — 로그인 직후 · 앞에 올 때 하는 일이 한 번 돎
  async open(): Promise<void> {
    if (this.state !== 'off') return this.foreground();
    const userId = await currentUserId();
    await act(async () => {
      this.tree = create(createElement(Root, { userId }));
      await settle();
    });
    this.state = 'foreground';
  }

  // 뒤에 있던 앱이 앞에 옴 (AppState active) — 꺼져 있으면 처음부터 엶
  async foreground(): Promise<void> {
    if (this.state === 'off') return this.open();
    await act(async () => {
      this.appStateListeners.forEach((l) => l('active'));
      await settle();
    });
    this.state = 'foreground';
  }

  background() {
    if (this.state === 'off') return;
    this.appStateListeners.forEach((l) => l('background'));
    this.state = 'background';
  }

  // 최근 앱에서 밀어 닫음 · 시스템이 종료 — JS가 안 돎. 폰 알람 · 지오펜스 작업 · 네이티브 업로드는 그대로 돎
  async kill() {
    if (this.state === 'off') return;
    await act(async () => {
      this.tree?.unmount();
    });
    this.tree = null;
    this.state = 'off';
  }

  // 앱이 꺼져 있으면 JS 경로를 부르지 않게 막는 안전장치 — 시나리오가 JS 함수를 부를 때 감쌈
  async js<T>(task: () => Promise<T>): Promise<T> {
    if (this.state === 'off') throw new Error('앱이 꺼져 있어서 JS 경로를 부를 수 없음');
    let result!: T;
    await act(async () => {
      result = await task();
      await settle();
    });
    return result;
  }
}

export const app = new App();

export const clock = {
  day: BASE_DAY,
  // 오늘(시험이 도는 날)의 한국 시각 'HH:mm'으로 시계를 옮김 — 'HH:mm+1' 처럼 날짜 덧붙임도 가능
  set(time: string) {
    jest.setSystemTime(this.ms(time));
  },
  ms(time: string): number {
    const [clockPart, plus] = time.split('+');
    const [h, m, sec = 0] = clockPart.split(':').map(Number);
    return this.day + (plus ? Number(plus) : 0) * 24 * HOUR + h * HOUR + m * MIN + sec * 1000;
  },
  iso(time: string): string {
    return new Date(this.ms(time)).toISOString();
  },
  now: () => Date.now(),
  advance(minutes: number) {
    jest.setSystemTime(Date.now() + minutes * MIN);
  },
};

// 시험마다 부름 — 가짜 서버 · 폰 · 앱 · 시계 · 폰 저장소를 처음 상태로
export async function resetWorld() {
  await app.kill();
  dayCounter += 1;
  clock.day = BASE_DAY + dayCounter * 24 * HOUR;
  jest.useFakeTimers({
    doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    now: clock.day,
  });
  setRealTime(true);
  db.reset();
  db.userId = ME;
  db.clock = () => Date.now();
  phone.reset();
  phone.now = () => Date.now();
  phone.jsReceivesPush = () => app.state !== 'off'; // 받음 리스너는 앱 프로세스가 살아 있으면(앞 · 뒤) 불림, 꺼지면 없음 (usePushLinks는 앱 상태를 안 봄)
  db.nativeWrites = [];
  resetNav();
  resetPushLinks();
  setSigningOut(true);
  setSigningOut(false);
  bumpEpoch();
  await AsyncStorage.clear();
  app.uninstall();
  app.install();
}

export async function endWorld() {
  await app.kill();
  app.uninstall();
  jest.useRealTimers();
}

// ---------------------------------------------------------------------------
// 시드 — 서버에 이미 있는 상태를 만듦
// ---------------------------------------------------------------------------

export type AlarmTimes = Partial<Record<'WAKE' | 'PREPARE' | 'DEPARTURE' | 'ARRIVE', string>>;

export type SeedAppointment = {
  key: string; // 시험에서 부르는 이름 → uid(key)
  at: string; // 약속 시각 'HH:mm' (오늘, 'HH:mm+1'이면 내일)
  alarms: AlarmTimes;
  group?: string; // 그룹 이름 키 — 있으면 공동 약속
  user?: string;
  title?: string;
  travel?: number;
};

const ALARM_TYPES = ['WAKE', 'PREPARE', 'DEPARTURE', 'ARRIVE'] as const;

// 약속 하나(약속 · 내 참여 · 알람들)를 서버 표에 넣음. 돌려주는 값은 시험이 쓰는 id들
export function seedAppointment(s: SeedAppointment) {
  const user = s.user ?? ME;
  const appointmentId = uid(`appt:${s.key}`);
  const participantId = uid(`part:${s.key}:${user}`);
  db.seed('appointments', [
    {
      appointment_id: appointmentId,
      title: s.title ?? `약속 ${s.key}`,
      appointment_at: clock.iso(s.at),
      dest_name: '강남역',
      dest_lat: 37.4979,
      dest_lng: 127.0276,
      dest_radius_m: 150,
      group_id: s.group ? uid(`group:${s.group}`) : null,
      exception_kind: null,
    },
  ]);
  db.seed('appointment_participants', [
    {
      participant_id: participantId,
      appointment_id: appointmentId,
      user_id: user,
      est_travel_minutes: s.travel ?? 40,
      buffer_minutes: 10,
      departed_at: null,
      departed_source: null,
      arrived_at: null,
      arrived_source: null,
      actual_travel_minutes: null,
      origin_lat: 37.5011,
      origin_lng: 127.0123,
    },
  ]);
  const alarmIds: Record<string, string> = {};
  for (const type of ALARM_TYPES) {
    const time = s.alarms[type];
    if (!time) continue;
    alarmIds[type] = uid(`alarm:${s.key}:${type}:${user}`);
    db.seed('alarms', [
      {
        alarm_id: alarmIds[type],
        user_id: user,
        alarm_type: type,
        scheduled_at: clock.iso(time),
        intensity: 'NORMAL',
        voice_tone: null,
        sound_key: null,
        vibration: null,
        snooze_limit: 3,
        is_enabled: true,
        participant_id: participantId,
        routine_id: null,
      },
    ]);
  }
  return { appointmentId, participantId, alarmIds };
}

// 서버에 있는 알람을 폰에 걸어 둔 상태로 — 앱이 앞에 와서 맞춘 것과 같음
export async function syncPhone() {
  await act(async () => {
    await syncNow();
    await settle();
  });
}

// ---------------------------------------------------------------------------
// 읽기 — 시험이 확인하는 값을 글자로
// ---------------------------------------------------------------------------

export async function phoneAlarms(): Promise<string[]> {
  return (await phone.native.list()).map((a) => `${a.type}@${hhmm(a.atMillis)}`);
}

const describeWrite = (w: { table: string; op: string; payload: unknown }): string => {
  const rows = (Array.isArray(w.payload) ? w.payload : [w.payload]) as Record<string, unknown>[];
  const tags = rows
    .map((row) => (row && typeof row === 'object' ? (typeof row.event_type === 'string' ? `${row.event_type}${row.input_source ? `/${String(row.input_source)}` : ''}` : Object.keys(row).join('+')) : ''))
    .filter(Boolean)
    .join(',');
  return `${w.table}.${w.op}(${tags})`;
};

export const writeLines = (): string[] => db.writes.filter((w) => w.matched > 0 || w.op === 'insert' || w.op === 'upsert').map(describeWrite);
export const nativeWriteLines = (): string[] => db.nativeWrites.map(describeWrite);
export const rpcLines = (): string[] => db.rpcs.map((r) => r.name);
export { navLog };

// ---------------------------------------------------------------------------
// 그 밖의 시드 · 도우미
// ---------------------------------------------------------------------------

// 서버가 서버 함수 응답에 싣는 폰 꾸러미 한 개
export const ringPackage = (alarmId: string, type: RingPackage['type'], time: string, title = '약속'): RingPackage => ({
  alarmId,
  type,
  atMillis: clock.ms(time),
  title,
  intensity: 'NORMAL',
  snoozeLimit: 3,
});

// 그룹 · 내 참여 행 — 공유 스위치(F03) · 나가기 시험용
export function seedGroup(key: string, options: { wake?: boolean; trip?: boolean } = {}) {
  const groupId = uid(`group:${key}`);
  db.seed('groups', [{ group_id: groupId, group_name: `그룹 ${key}` }]);
  db.seed('group_members', [
    { group_member_id: uid(`gm:${key}:${ME}`), group_id: groupId, user_id: ME, invite_status: 'JOINED', wake_share_opt_in: options.wake ?? true, trip_share_opt_in: options.trip ?? false, notifications_off: false },
    { group_member_id: uid(`gm:${key}:${FRIEND}`), group_id: groupId, user_id: FRIEND, invite_status: 'JOINED', wake_share_opt_in: true, trip_share_opt_in: false, notifications_off: false },
  ]);
  return groupId;
}

// 위치 감지 시드 — 집 좌표 (감지 영역 계획이 읽음). 감지 스위치 · 권한은 기본이 켬
export function seedHome() {
  db.seed('profiles', [{ user_id: ME, home_lat: 37.5011, home_lng: 127.0123, home_radius_m: 200, timezone: 'Asia/Seoul' }]);
}

// 앱이 등록한 지오펜스에서 집 · 약속 도착지 영역 id를 읽음 (영역 id는 좌표로 정해지는 값이라 등록 뒤에 읽어야 함)
export function regionIds(): { home: string; dest: string } {
  const regions = (phone.geofenceRegions ?? []) as { identifier: string }[];
  const home = regions.find((r) => r.identifier === 'home')?.identifier;
  const dest = regions.find((r) => r.identifier !== 'home')?.identifier;
  if (!home || !dest) throw new Error(`지오펜스가 등록되지 않음: ${JSON.stringify(regions)}`);
  return { home, dest };
}

// 폰 알림창의 감지 안내 id들 (expo:detect-DEPART-… · expo:detect-ARRIVE-…)
export const detectTray = (): string[] => phone.trayIds().filter((id) => id.startsWith('expo:detect-'));

export const alarmIdOf = (key: string, type: 'WAKE' | 'PREPARE' | 'DEPARTURE' | 'ARRIVE', user: string = ME): string => uid(`alarm:${key}:${type}:${user}`);
export const participantIdOf = (key: string, user: string = ME): string => uid(`part:${key}:${user}`);
export const appointmentIdOf = (key: string): string => uid(`appt:${key}`);

// 해제 시각(ms)에서 10분 안에 폰을 쓴 구간 — 기상 자동 판정이 서는 모양 (누적 1분 넘게 + 뒤쪽 5분 사이에도 사용)
export const usageAuto = (dismissedMs: number) => [
  { startMillis: dismissedMs + 30_000, endMillis: dismissedMs + 2 * MIN },
  { startMillis: dismissedMs + 6 * MIN, endMillis: dismissedMs + 7 * MIN },
];
