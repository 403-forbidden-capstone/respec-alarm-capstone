// 시나리오 S14 ~ S20 — 출발 · 도착: 원탭 버튼 · 위치 감지 · 정정
//   서버가 출발 · 도착 기록에 반응하는 일(친구 화면 '이동 중' · 지각 계산)은 supabase 시나리오가 보고, 여기는 폰 쪽: 앱이 쓴 것 · 폰 알람 · 알림창 · 폰 기억
import './testkit/install';

import { describe, expect } from '@jest/globals';

import { applyFix } from '@/features/voice/fixes';
import { eraseDetection, undoErase } from '@/features/location/fix';
import { loadState } from '@/features/location/store';
import type { RejectSnapshot } from '@/features/location/api';

import { db } from './testkit/fakeDb';
import { phone } from './testkit/phone';
import { scenario, useWorld } from './testkit/scenario';
import { alarmIdOf, app, clock, detectTray, participantIdOf, regionIds, seedAppointment, seedHome, settle } from './testkit/world';

const PART = participantIdOf('t');
const PREPARE = alarmIdOf('t', 'PREPARE');
const DEPARTURE = alarmIdOf('t', 'DEPARTURE');

const noticeIds = () => phone.trayIds().filter((id) => id.startsWith('notice:'));
const participant = () => db.rows('appointment_participants').find((r) => r.participant_id === PART)!;

// 집에서 약속(10:00)이 있는 날. 앱을 열어 폰 알람을 걸고 지오펜스를 등록한 뒤 앱을 닫음 (위치 신호는 앱 없이 헤드리스 작업이 받음)
async function startTrip(alarms: Parameters<typeof seedAppointment>[0]['alarms'], options: { deviceKey?: boolean; keepOpen?: boolean } = {}) {
  seedHome();
  seedAppointment({ key: 't', at: '10:00', alarms });
  phone.deviceKey = options.deviceKey ?? false;
  await app.open();
  const regions = regionIds();
  if (!options.keepOpen) await app.kill();
  return regions;
}

// 집을 나서 목적지에 도착한 하루 — 위치 신호만으로 출발(08:20) · 도착(08:55)이 서버에 기록됨
async function leaveAndArrive(regions: { home: string; dest: string }) {
  clock.set('08:20');
  await phone.geofence('EXIT', regions.home);
  clock.set('08:55');
  await phone.geofence('ENTER', regions.dest);
  await settle();
}

describe('S14 앱 꺼진 채 [출발했어요]', () => {
  useWorld();
  const tapped = (deviceKey: boolean) =>
    scenario('S14 앱 꺼진 채 출발했어요')
      .at('07:55')
      .given(() => startTrip({ PREPARE: '08:05', DEPARTURE: '08:40', ARRIVE: '10:00' }, { deviceKey }))
      .do(() => {
        clock.set('08:40');
        phone.fireDue();
        clock.set('08:41');
        phone.tapOneTap(DEPARTURE);
      });

  tapped(true).variant('기기 키 있음 — 폰이 앱 없이 서버에 바로 올리고 알림이 사라짐').expect({
    nativeWrites: ['alarm_events.insert(ACKNOWLEDGED/BUTTON)'],
    noWrites: ['alarm_events', 'appointment_participants'],
    tray: [`notice:${PREPARE}`],
  });

  tapped(false).variant('기기 키 없음 — 서버에는 앱을 열 때 올라감').limit('앱 열림만').expect({ noNativeWrites: ['alarm_events'], noWrites: ['alarm_events'], tray: [`notice:${PREPARE}`] });

  tapped(true)
    .variant('앱을 열면 출발 시각이 참여 기록에 반영되고 폰 알람이 정리됨')
    .do(async () => {
      await app.open();
    })
    .expect({ writes: ['appointment_participants.update(departed_at'], phoneAlarms: ['ARRIVE@10:00'], check: () => expect(participant().departed_source).toBe('BUTTON') });
});

describe('S15 위치 출발(정상)', () => {
  useWorld();
  const leftEarly = () =>
    scenario('S15 위치 출발')
      .at('07:55')
      .given(async () => {
        const regions = await startTrip({ DEPARTURE: '08:40', ARRIVE: '10:00' });
        clock.set('08:20');
        await phone.geofence('EXIT', regions.home);
      });

  leftEarly()
    .variant('집 이탈 → 감지 안내 알림이 뜨고 서버에는 아직 안 씀 (5분 대기)')
    .expect({ noWrites: ['appointment_participants'], check: () => expect(detectTray().some((id) => id.startsWith('expo:detect-DEPART-'))).toBe(true) });

  leftEarly()
    .variant('출발 알람 시각(08:40)이 되면 알람 알림이 울림 — 이미 나섰는데도')
    .do(() => {
      clock.set('08:41');
      phone.fireDue();
    })
    .limit('위치 출발은 확정 전')
    .expect({ check: () => expect(noticeIds()).toEqual([`notice:${DEPARTURE}`]) });

  leftEarly()
    .gap('G3')
    .variant('일찍 나선 날 "곧 출발하세요" 알림이 울리면 안 됨')
    .do(() => {
      clock.set('08:41');
      phone.fireDue();
    })
    .expect({ check: () => expect(noticeIds()).toEqual([]) });
});

describe('S16 부팅 직후 이른 위치 출발', () => {
  useWorld();
  // 약속 10:00, 출발 알람 09:20 → 위치 출발을 받는 창은 08:20부터. 05:30에 폰이 켜지고 05:35에 앱을 엶
  const booted = () =>
    scenario('S16 부팅 직후 이른 위치 출발')
      .at('05:00')
      .given(async () => {
        await startTrip({ DEPARTURE: '09:20', ARRIVE: '10:00' }, { keepOpen: true });
        await app.kill();
        clock.set('05:30');
        phone.reboot();
        clock.set('05:35');
        await app.open();
      });

  booted()
    .variant('앱을 열자마자(10분 안) 이미 밖이라는 첫 신호는 상태만 — 알림도 기록도 없음')
    .do(async () => {
      clock.set('05:40');
      await phone.geofence('EXIT', regionIds().home);
    })
    .expect({ noWrites: ['appointment_participants', 'alarm_events'], check: () => expect(detectTray()).toEqual([]) });

  booted()
    .variant('창이 열리기 전(06:10) 이탈은 서버에 안 씀')
    .do(async () => {
      await app.kill();
      clock.set('06:10');
      await phone.geofence('EXIT', regionIds().home);
      clock.set('06:20');
      await app.open(); // 대기 중인 출발을 확정하려 함 — 앱이 이른 출발은 거름
    })
    .expect({ noWrites: ['appointment_participants.update', 'alarm_events.upsert(ACKNOWLEDGED/LOCATION)'], check: () => expect(participant().departed_at).toBeNull() });

  booted()
    .news(2)
    .variant('서버에 안 쓸 이른 이탈에는 "출발 감지" 안내도 안 떠야 함 — 지금은 이탈 순간 안내가 먼저 뜸')
    .do(async () => {
      await app.kill();
      clock.set('06:10');
      await phone.geofence('EXIT', regionIds().home);
    })
    .expect({ check: () => expect(detectTray()).toEqual([]) });
});

describe('S17 감지 [아니에요] → 되돌리기', () => {
  useWorld();
  const detected = () =>
    scenario('S17 감지 정정')
      .at('07:55')
      .given(async () => {
        const regions = await startTrip({ ARRIVE: '10:00' });
        await leaveAndArrive(regions);
        clock.set('08:56');
        await app.open(); // 앞에 오면 폰 알람이 정리됨 (도착 기록이 있는 도착 목표 알람은 뺌)
        clock.set('08:57');
      });
  const erase = () => app.js(() => eraseDetection({ participantId: PART, kind: 'ARRIVE', at: clock.ms('08:55') }, 'H01'));

  detected()
    .variant('앞에 오면 도착 알람은 이미 폰에서 빠져 있음')
    .expect({ phoneAlarms: [] });

  detected()
    .variant('[아니에요] — 서버 값을 지우고 감지 안내를 거둠 · 폰 기억에 지운 판정으로 두고 · 도착 알람이 폰에 되돌아옴')
    .do(async () => {
      await erase();
    })
    .expect({
      writes: ['user_edit_logs.insert(', 'appointment_participants.update('],
      phoneAlarms: ['ARRIVE@10:00'],
      check: async () => {
        expect(participant().arrived_at).toBeNull();
        expect(detectTray().some((id) => id.startsWith('expo:detect-ARRIVE-'))).toBe(false);
        expect((await loadState()).voided.map((v) => v.kind)).toContain('ARRIVE');
      },
    });

  detected()
    .variant('5초 안에 되돌리면 서버 값 · 폰 기억 · 폰 알람이 원래대로')
    .do(async () => {
      const erased = await erase();
      expect(erased?.snapshot).toBeTruthy();
      await app.js(() => undoErase(erased!.snapshot as RejectSnapshot));
    })
    .expect({
      phoneAlarms: [],
      check: async () => {
        expect(participant().arrived_at).not.toBeNull();
        expect((await loadState()).voided).toEqual([]);
      },
    });
});

describe('S18 도착 감지', () => {
  useWorld();
  const arrived = () =>
    scenario('S18 도착 감지')
      .at('07:55')
      .given(async () => {
        const regions = await startTrip({ ARRIVE: '10:00' });
        await leaveAndArrive(regions);
      });

  arrived().variant('도착이 서버에 기록되고 "도착 감지" 안내가 뜸').expect({
    writes: ['appointment_participants.update(departed_at', 'appointment_participants.update(arrived_at', 'alarm_events.upsert(ARRIVAL_CONFIRMED/LOCATION'],
    check: () => {
      expect(detectTray().some((id) => id.startsWith('expo:detect-ARRIVE-'))).toBe(true);
      expect(participant().arrived_source).toBe('LOCATION');
    },
  });

  arrived()
    .limit('앱 열림만')
    .variant('앱을 열면 도착 목표 알람이 폰에서 빠짐')
    .do(async () => {
      clock.set('08:56');
      await app.open();
    })
    .expect({ phoneAlarms: [] });

  arrived()
    .gap('G3')
    .variant('이미 도착했는데 10시에 "도착했어요?" 알림이 울리면 안 됨')
    .do(() => {
      clock.set('10:01');
      phone.fireDue();
    })
    .expect({ check: () => expect(noticeIds()).toEqual([]) });
});

describe('S19 도착 감지 놓침', () => {
  useWorld();
  scenario('S19 도착 감지 놓침')
    .variant('앱이 도착을 지어내지 않음 — 약속 60분 뒤 앱을 열어도 도착 칸은 비어 있고 출발만 남음')
    .at('07:55')
    .given(async () => {
      const regions = await startTrip({ DEPARTURE: '08:40', ARRIVE: '10:00' });
      clock.set('08:20');
      await phone.geofence('EXIT', regions.home); // 목적지 진입 신호는 오지 않음
    })
    .do(async () => {
      clock.set('11:05');
      await app.open();
    })
    .expect({
      writes: ['appointment_participants.update(departed_at'],
      noWrites: ['appointment_participants.update(arrived_at'],
      check: () => {
        expect(participant().arrived_at).toBeNull();
        expect(participant().departed_source).toBe('LOCATION');
      },
    });
});

describe('S20 대화로 시각 정정', () => {
  useWorld();
  const corrected = () =>
    scenario('S20 대화로 시각 정정')
      .at('07:55')
      .given(async () => {
        const regions = await startTrip({ ARRIVE: '10:00' });
        await leaveAndArrive(regions);
        clock.set('09:00');
      })
      .do(async () => {
        await app.open();
        const result = await app.js(() => applyFix({ id: 'x1', kind: 'ARRIVE', participantId: PART, action: 'CORRECT', to: new Date(clock.ms('08:50')) }));
        expect(result.ok).toBe(true);
      });

  corrected().variant('위치 값을 직접 입력 값으로 덮어 서버에 기록').expect({ writes: ['appointment_participants.update(arrived_at'], check: () => expect(participant().arrived_source).toBe('MANUAL') });
  corrected().gap('G10').variant('알림창의 "도착 감지" 안내도 거둬져야 함 — 지금은 옛 안내가 그대로').expect({ check: () => expect(detectTray().some((id) => id.startsWith('expo:detect-ARRIVE-'))).toBe(false) });
});
