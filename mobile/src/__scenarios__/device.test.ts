// 시나리오 S31 ~ S34 — 권한 · 기기: 알림 권한 끔 · 위치 권한 끔 · 로그아웃 → 다른 계정 · 정확 알람 권한 끔
import './testkit/install';

import { describe, expect } from '@jest/globals';

import { getWakeCheck } from '@/features/alarm/realWake';
import { bannerLines } from '@/features/permissions/banner';
import { readPermissions } from '@/features/permissions/read';
import { failedAlarmCount } from '@/lib/alarmSync';
import { signOutAndCleanup } from '@/lib/session';
import { loadActions, loadPlan, loadRegions, loadState } from '@/features/location/store';

import { db } from './testkit/fakeDb';
import { phone } from './testkit/phone';
import { scenario, useWorld } from './testkit/scenario';
import { alarmIdOf, app, clock, detectTray, regionIds, seedAppointment, seedHome, settle, syncPhone } from './testkit/world';

const WAKE = alarmIdOf('a', 'WAKE');
const DEPARTURE_T = alarmIdOf('t', 'DEPARTURE');

describe('S31 알림 권한 끔', () => {
  useWorld();
  const denied = () =>
    scenario('S31 알림 권한 끔')
      .at('07:00')
      .given(async () => {
        seedAppointment({ key: 'a', at: '10:30', alarms: { WAKE: '07:30', PREPARE: '09:00', DEPARTURE: '09:20', ARRIVE: '10:30' } });
        phone.usageAccess = false;
        phone.deviceKey = true;
        await app.open();
        await syncPhone();
        phone.notificationsGranted = false;
      });

  denied()
    .variant('해제 10분 뒤 확인 알림이 안 뜸 (OS가 막음) — 판정은 폰 안에서 돌았음')
    .do(() => {
      clock.set('07:30');
      phone.fireDue();
      clock.set('07:31');
      phone.dismiss();
      clock.set('07:41:03');
      phone.runJudges();
    })
    .expect({ tray: [], nativeLog: [`judge:${WAKE}:PROMPT`] });

  denied()
    .variant('앱 안에서는 알림이 꺼졌다는 안내(홈 빨간 줄)가 보임')
    .do(async () => {
      await app.foreground();
    })
    .expect({
      check: async () => {
        const snapshot = await readPermissions();
        expect(snapshot.notifications).toBe('off');
        expect(bannerLines(snapshot, { failedCount: failedAlarmCount(), hasAlarm: true }).map((l) => l.key)).toContain('notifications');
      },
    });

  denied()
    .variant('준비 알림도 안 뜸 — 알람 예약과 기록은 그대로')
    .do(() => {
      clock.set('09:01');
      phone.fireDue();
    })
    .expect({ tray: [], check: () => expect(phone.events.some((e) => e.eventType === 'TRIGGERED' && e.alarmType === 'PREPARE')).toBe(true) });
});

describe('S32 위치 권한 끔', () => {
  useWorld();
  const noLocation = () =>
    scenario('S32 위치 권한 끔')
      .at('07:55')
      .given(async () => {
        seedHome();
        seedAppointment({ key: 't', at: '10:00', alarms: { DEPARTURE: '08:40', ARRIVE: '10:00' } });
        phone.deviceKey = true;
        await app.open(); // 권한이 있을 때 등록됨
        regionIds();
        phone.revokeBackgroundLocation();
        await app.kill();
        clock.set('08:00');
        await app.open();
      });

  noLocation()
    .variant('앱을 열면 감시 목록을 비우고 등록을 안 함 — 이탈 신호가 와도 감지 없음')
    .do(async () => {
      clock.set('08:20');
      const delivered = await phone.geofence('EXIT', 'home');
      expect(delivered).toBe(false);
    })
    .expect({
      noWrites: ['appointment_participants'],
      check: async () => {
        expect(phone.geofenceRegions).toBeNull();
        expect(await loadRegions()).toEqual([]);
        expect(detectTray()).toEqual([]);
      },
    });

  noLocation()
    .variant('[출발했어요] 버튼으로는 그대로 기록됨')
    .do(async () => {
      await app.kill();
      clock.set('08:40');
      phone.fireDue();
      phone.tapOneTap(DEPARTURE_T);
      await app.open();
    })
    .expect({ nativeWrites: ['alarm_events.insert(ACKNOWLEDGED/BUTTON)'], writes: ['appointment_participants.update(departed_at'], phoneAlarms: ['ARRIVE@10:00'] });
});

describe('S33 로그아웃 → 다른 계정', () => {
  useWorld();
  const loggedOut = () =>
    scenario('S33 로그아웃')
      .at('07:55')
      .given(async () => {
        seedHome();
        seedAppointment({ key: 't', at: '10:00', alarms: { DEPARTURE: '08:40', ARRIVE: '10:00' } });
        phone.usageAccess = false;
        phone.deviceKey = true;
        await app.open();
        const regions = regionIds();
        // 08:20 집을 나서 감지 안내가 뜨고, 08:40 출발 알림이 울림, 폰 알림 목록에 확인 알림도 떠 있는 하루
        clock.set('08:20');
        await phone.geofence('EXIT', regions.home);
        clock.set('08:40');
        phone.fireDue();
        phone.tray.set('wakeprompt:prev', { id: 'wakeprompt:prev', origin: 'native', kind: 'WAKE_PROMPT', alarmId: 'prev', alarmType: 'WAKE' });
        phone.judges.push({ alarmId: 'prev', dismissedAt: clock.ms('08:35'), at: clock.ms('08:45') });
      })
      .do(async () => {
        await app.js(() => signOutAndCleanup());
      });

  loggedOut().variant('폰 알람 · 울림 기록 · 일정 알림 · 위치 기억 · 기기 키가 정리됨').expect({
    phoneAlarms: [],
    check: async () => {
      expect(phone.events).toEqual([]);
      expect([...phone.tray.keys()].filter((id) => id.startsWith('notice:'))).toEqual([]);
      await settle();
      expect(await loadState()).toMatchObject({ pending: [], departed: [], arrived: [] });
      expect(await loadPlan()).toMatchObject({ participants: [] });
      expect(await loadActions()).toEqual([]);
      expect(phone.geofenceRegions).toBeNull();
    },
  });

  loggedOut().gap('G11').variant('앞 계정의 확인 알림 · 감지 안내가 알림창에 남으면 안 됨').expect({ tray: [] });

  loggedOut()
    .gap('G11')
    .variant('해제 + 10분 판정 예약도 지워져야 함 (다음 계정에 앞 계정 알림이 뜸)')
    .expect({ check: () => expect(phone.judges).toEqual([]) });

  loggedOut()
    .variant('다른 계정으로 들어와 앞 계정의 확인 알림을 눌러도 그 계정 데이터로는 못 엶 (빈 화면)')
    .do(async () => {
      db.userId = 'user-other';
      await app.open();
      const check = await app.js(() => getWakeCheck(alarmIdOf('a', 'WAKE')));
      expect(check).toBeNull();
    })
    .limit('G11 뒤끝')
    .expect({});
});

describe('S34 정확 알람 권한 끔(안드로이드 12)', () => {
  useWorld();
  const exactOff = () =>
    scenario('S34 정확 알람 권한 끔')
      .at('07:00')
      .given(async () => {
        seedAppointment({ key: 'a', at: '10:30', alarms: { WAKE: '07:30', PREPARE: '09:00', DEPARTURE: '09:20', ARRIVE: '10:30' } });
        await app.open();
        await syncPhone();
      })
      .do(async () => {
        // 설정에서 권한을 뺏으면 OS가 예약을 지움 — 폰 저장소 목록에는 그대로 남음
        phone.exactAlarms = false;
        phone.osAlarmsLost = true;
        await app.foreground();
      });

  exactOff()
    .variant('알람이 울리지 않음 (OS가 예약을 지움) — 목록에는 그대로 남음')
    .do(() => {
      clock.set('09:21');
      phone.fireDue();
    })
    .expect({
      phoneAlarms: ['WAKE@07:30', 'PREPARE@09:00', 'DEPARTURE@09:20', 'ARRIVE@10:30'],
      tray: [],
      check: () => expect(phone.events).toEqual([]),
    });

  // 대조: 권한이 있으면 같은 시각에 준비 · 출발 알림이 울림 (위 시험이 항상 통과하는 시험이 아님을 보임)
  scenario('S34 정확 알람 권한 끔')
    .variant('대조 — 권한이 있으면 같은 시각에 울림')
    .at('07:00')
    .given(async () => {
      seedAppointment({ key: 'a', at: '10:30', alarms: { WAKE: '07:30', PREPARE: '09:00', DEPARTURE: '09:20', ARRIVE: '10:30' } });
      await app.open();
      await syncPhone();
    })
    .do(() => {
      clock.set('09:21');
      phone.fireDue();
    })
    .expect({ tray: [`notice:${alarmIdOf('a', 'PREPARE')}`, `notice:${alarmIdOf('a', 'DEPARTURE')}`] });

  exactOff()
    .gap('G15')
    .variant('권한이 꺼졌음을 홈 빨간 줄로 알려야 함 — 지금은 목록이 저장소 기준이라 모르고 줄도 안 뜸')
    .expect({
      check: async () => {
        const snapshot = await readPermissions();
        expect(snapshot.exactAlarm).toBe('off');
        expect(bannerLines(snapshot, { failedCount: failedAlarmCount(), hasAlarm: true }).length).toBeGreaterThan(0);
      },
    });
});
