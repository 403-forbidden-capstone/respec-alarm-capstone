// 시나리오 S01 ~ S13 — 기상: 알람이 울린 뒤 해제 · 확인 알림 · 먼저 깼어요 · 미루기 · 놓침 · 재부팅
//   정답지 = 원인분석_시나리오계획.md 3절 + 사건_부수효과_점검.md 표 (사건 × 폰 알람 · 알림창 · 폰 기억 · 서버 기록 · 본인 화면 · 푸시)
//   서버 쪽 계산(놓침 판정 · 친구 화면)은 supabase 시나리오가 보고, 여기는 폰 쪽: 앱이 무엇을 쓰고 · 다시 읽고 · 폰 알람과 알림창을 어떻게 바꿨는지
import './testkit/install';

import { describe, expect } from '@jest/globals';

import { cancelSnooze, confirmEarlyWake, confirmWake, correctAutoWake, getAutoWake, getEarlyWake, getWakeCheck, snoozeRing } from '@/features/alarm/realWake';
import { updateAppointment } from '@/features/alarm/realEdit';
import { applyFix } from '@/features/voice/fixes';

import { db } from './testkit/fakeDb';
import { phone } from './testkit/phone';
import { navLog } from './testkit/nav';
import { scenario, useWorld } from './testkit/scenario';
import { alarmIdOf, app, appointmentIdOf, clock, participantIdOf, ringPackage, seedAppointment, syncPhone, ME, usageAuto } from './testkit/world';

const WAKE = alarmIdOf('a', 'WAKE');
const PREPARE = alarmIdOf('a', 'PREPARE');
const DEPARTURE = alarmIdOf('a', 'DEPARTURE');

// 하루 — 기상 07:30, 약속 10:30
const seedDay = () => seedAppointment({ key: 'a', at: '10:30', alarms: { WAKE: '07:30', PREPARE: '09:00', DEPARTURE: '09:20', ARRIVE: '10:30' } });
const FULL = ['WAKE@07:30', 'PREPARE@09:00', 'DEPARTURE@09:20', 'ARRIVE@10:30'];
const AFTER_WAKE = ['PREPARE@09:00', 'DEPARTURE@09:20', 'ARRIVE@10:30'];

async function startDay(options: { deviceKey?: boolean; usage?: 'none' | 'auto' | 'denied'; appOpen?: boolean } = {}) {
  seedDay();
  phone.deviceKey = options.deviceKey ?? true;
  phone.usageAccess = options.usage !== 'denied';
  await app.open();
  await syncPhone();
  if (options.appOpen === false) await app.kill();
}

// 알람이 울리고 사용자가 끔
function ringAndDismiss(ringAt = '07:30', dismissAt = '07:31') {
  clock.set(ringAt);
  phone.fireDue();
  clock.set(dismissAt);
  phone.dismiss();
}

// 해제 + 10분 2초 — 폰 안 판정이 도는 시각
function judgeTime(dismissAt = '07:31') {
  const [h, m] = dismissAt.split(':').map(Number);
  clock.set(`${String(h).padStart(2, '0')}:${String(m + 10).padStart(2, '0')}:03`);
  phone.runJudges();
}

describe('S01 자동 판정(누워서 폰), 앱 꺼짐', () => {
  useWorld();
  const flow = (deviceKey: boolean) =>
    scenario('S01 자동 판정 · 앱 꺼짐')
      .at('07:00')
      .given(() => startDay({ deviceKey, appOpen: false }))
      .do(() => {
        ringAndDismiss();
        phone.usageSpans = usageAuto(clock.ms('07:31'));
        judgeTime();
      });

  flow(true)
    .variant('기기 키 있음 — 폰이 앱 없이 서버에 확정')
    .expect({
      nativeWrites: ['alarm_events.insert(DISMISSED/BUTTON)', 'alarm_events.insert(WAKE_CONFIRMED/USAGE)', 'daily_records.insert('],
      noWrites: ['alarm_events', 'daily_records'], // 앱은 꺼져 있어 쓴 것이 없음
      tray: [], // 확인 알림 없음
      nativeLog: [`judge:${WAKE}:AUTO`],
    });

  flow(false)
    .variant('기기 키 없음 — 앱 열 때까지 서버 확정 없음')
    .limit('앱 열림만')
    .expect({ noNativeWrites: ['alarm_events.insert(WAKE_CONFIRMED', 'daily_records'], noWrites: ['alarm_events'], tray: [], check: () => expect(db.rows('alarm_events')).toHaveLength(0) });

  flow(false)
    .variant('기기 키 없음 — 앱을 열면 다시 판정해 확정하고 알림 정리')
    .do(async () => {
      clock.set('07:50');
      await app.open();
    })
    .expect({ writes: ['alarm_events.upsert(', /WAKE_CONFIRMED\/USAGE/], tray: [], nativeLog: [`dismissWakePrompt:${WAKE}`] });
});

describe('S02 사용 기록 끔 → 10분 뒤 확인 알림 → [일어났어요]', () => {
  useWorld();
  const prompted = () =>
    scenario('S02 확인 알림')
      .at('07:00')
      .given(() => startDay({ usage: 'denied' }))
      .do(() => {
        ringAndDismiss();
        judgeTime();
      });

  prompted().variant('해제 10분 뒤 알림이 뜸').expect({ tray: [`wakeprompt:${WAKE}`], nativeLog: [`judge:${WAKE}:PROMPT`] });

  prompted()
    .variant('알림을 눌러 H08에서 확정 — 눌렀을 때 닫히고 서버에 기록')
    .do(async () => {
      phone.tapWakePrompt(WAKE);
      await app.foreground();
      await app.js(async () => {
        const check = await getWakeCheck(WAKE);
        expect(check?.phase).toBe('prompt');
        await confirmWake(WAKE, 'self');
      });
    })
    .expect({ tray: [], writes: ['alarm_events.upsert(', /WAKE_CONFIRMED\/BUTTON/, 'daily_records.insert('], nativeLog: [`dismissWakePrompt:${WAKE}`] });

  prompted()
    .variant('앱 아이콘으로 열어 확정 — 확정 뒤 알림이 거둬짐')
    .do(async () => {
      await app.foreground();
      await app.js(async () => {
        await getWakeCheck(WAKE);
        await confirmWake(WAKE, 'self');
      });
    })
    .expect({ tray: [], nativeLog: [`dismissWakePrompt:${WAKE}`], writes: [/WAKE_CONFIRMED\/BUTTON/] });
});

describe('S03 S02 + 오프라인', () => {
  useWorld();
  const offline = () =>
    scenario('S03 오프라인 확인')
      .at('07:00')
      .given(() => startDay({ usage: 'denied', deviceKey: false }))
      .do(() => {
        db.offline = true;
        phone.online = false;
        ringAndDismiss();
        judgeTime();
      });

  offline().variant('알림은 뜸 (폰 안에서 판정)').expect({ tray: [`wakeprompt:${WAKE}`], check: () => expect(phone.events.some((e) => e.eventType === 'DISMISSED')).toBe(true) });

  offline()
    .variant('오프라인 확정은 실패하고 바뀐 것 없음 — 알림은 그대로')
    .do(async () => {
      await app.foreground();
      await expect(app.js(() => confirmWake(WAKE, 'self'))).rejects.toBeDefined();
    })
    .expect({
      tray: [`wakeprompt:${WAKE}`],
      noWrites: [/WAKE_CONFIRMED/],
      check: () => expect(db.rows('alarm_events').filter((e) => e.event_type === 'WAKE_CONFIRMED')).toHaveLength(0),
    });

  offline()
    .variant('온라인이 되어 다시 누르면 올라가고 알림 정리')
    .do(async () => {
      await app.foreground();
      await expect(app.js(() => confirmWake(WAKE, 'self'))).rejects.toBeDefined();
      db.offline = false;
      phone.online = true;
      await app.js(async () => {
        await getWakeCheck(WAKE); // 폰에 남은 해제 기록을 먼저 올림
        await confirmWake(WAKE, 'self');
      });
    })
    .expect({ tray: [], writes: [/WAKE_CONFIRMED\/BUTTON/], nativeLog: [`dismissWakePrompt:${WAKE}`] });
});

describe('S04 먼저 깼어요', () => {
  useWorld();
  const early = () =>
    scenario('S04 먼저 깼어요')
      .at('07:00')
      .given(async () => {
        await startDay();
        clock.set('07:10'); // 기상 알람 60분 전부터 눌러짐
      })
      .do(() =>
        app.js(async () => {
          const found = await getEarlyWake();
          await confirmEarlyWake(found!.alarmId);
        }),
      );

  early().variant('정상 — 기상 알람은 폰에서 빠지고 준비 · 출발 · 도착은 남음').expect({
    phoneAlarms: AFTER_WAKE,
    tray: [],
    writes: ['alarm_events.upsert(', /WAKE_CONFIRMED\/BUTTON/, 'daily_records.insert('],
  });

  early()
    .variant('확정 뒤 준비 · 출발 알람은 제때 울림(알람 화면 — 11/19부터 알림이 아님), 기상 확인 알림은 없음')
    .do(() => {
      clock.set('09:21');
      phone.fireDue();
      phone.runJudges();
    })
    .expect({
      tray: [],
      check: () => {
        expect(phone.events.filter((e) => e.eventType === 'TRIGGERED').map((e) => e.alarmId)).toEqual([PREPARE, DEPARTURE]);
        expect(phone.ringing).toBe(DEPARTURE); // 마지막으로 울린 알람이 지금 울리는 중
      },
    });

  early()
    .variant('앱이 앞에 다시 올 때도 기상 알람이 되살아나지 않음')
    .do(async () => {
      await app.foreground();
    })
    .expect({ phoneAlarms: AFTER_WAKE });

  scenario('S04 먼저 깼어요')
    .variant('오프라인 — 확정이 실패하고 알람은 그대로 울림')
    .at('07:00')
    .given(async () => {
      await startDay();
      clock.set('07:10');
      db.offline = true;
    })
    .do(async () => {
      await expect(app.js(() => confirmEarlyWake(WAKE))).rejects.toBeDefined();
    })
    .expect({ phoneAlarms: FULL, noWrites: ['alarm_events.upsert(', 'daily_records'], tray: [] });
});

describe('S05 먼저 깬 뒤 같은 날 시각 변경 / 하루 넘게 변경', () => {
  useWorld();
  const edited = (newWake: string, others: Record<string, string>) =>
    scenario('S05 먼저 깬 뒤 시각 변경')
      .at('07:00')
      .given(async () => {
        await startDay();
        clock.set('07:10');
        await app.js(() => confirmEarlyWake(WAKE));
      })
      .do(async () => {
        db.edgeHandlers['appointment-edit'] = () => {
          // 서버가 일정을 고치고 바뀐 알람 시각을 돌려줌 (계산은 서버 몫 — 여기서는 응답만)
          db.patch('alarms', { alarm_id: WAKE }, { scheduled_at: clock.iso(newWake) });
          for (const [type, time] of Object.entries(others)) db.patch('alarms', { alarm_id: alarmIdOf('a', type as 'PREPARE') }, { scheduled_at: clock.iso(time) });
          return {
            saved: true,
            needs_confirm: false,
            changes: [],
            ring_packages: [ringPackage(WAKE, 'WAKE', newWake), ...Object.entries(others).map(([type, time]) => ringPackage(alarmIdOf('a', type as 'PREPARE'), type as 'PREPARE', time))],
            canceled_alarm_ids: [],
          };
        };
        await app.js(() => updateAppointment(appointmentIdOf('a'), { at: new Date(clock.ms('10:50')) }, 'this'));
      });

  edited('07:45', { PREPARE: '09:10', DEPARTURE: '09:30', ARRIVE: '10:50' })
    .variant('같은 날 변경 — 기상 알람은 계속 빠져 있음 (이미 확인함)')
    .expect({ phoneAlarms: ['PREPARE@09:10', 'DEPARTURE@09:30', 'ARRIVE@10:50'] });

  edited('07:45+2', { PREPARE: '09:10', DEPARTURE: '09:30', ARRIVE: '10:50' })
    .variant('이틀 뒤로 변경 — 확정 기록이 24시간 밖이라 기상 알람이 다시 걸림')
    .expect({ phoneAlarms: ['PREPARE@09:10', 'DEPARTURE@09:30', 'ARRIVE@10:50', 'WAKE@07:45'] });
});

describe('S06 다시 잠(해제 · 사용 없음 · 무응답) → 놓침', () => {
  useWorld();
  const missed = () =>
    scenario('S06 다시 잠 → 놓침')
      .at('07:00')
      .given(() => startDay({ usage: 'denied', appOpen: false }))
      .do(async () => {
        ringAndDismiss();
        judgeTime();
        // 30분 지나도 응답 없음 — 서버 배치가 놓침을 적고 본인에게 푸시 (서버 계산 · 푸시 발송은 서버 시나리오)
        clock.set('08:05');
        db.seed('alarm_events', [{ user_id: ME, alarm_id: WAKE, event_type: 'MISSED', event_at: clock.iso('08:00'), client_event_id: 'missed-1', input_source: 'SYSTEM' }]);
        phone.receivePush({ kind: 'WAKE_MISSED', recipientUserId: ME, path: '/wake' }, 'missed-push');
      });

  missed().variant('폰은 놓침을 기록하지 않고, 확인 알림은 계속 떠 있음').expect({ tray: [`wakeprompt:${WAKE}`, 'expo:missed-push'], noWrites: ['alarm_events'], noNativeWrites: ['alarm_events.insert(MISSED'] });

  missed()
    .variant('푸시를 눌러 H08을 열면 [일어났어요]로 확인할 수 있음 (해제를 했던 경우)')
    .do(async () => {
      phone.tapNotification('missed-push');
      await app.open();
      await app.js(async () => {
        const check = await getWakeCheck();
        expect(check?.alarmId).toBe(WAKE);
        expect(check?.phase).toBe('prompt');
        await confirmWake(WAKE, 'self');
      });
    })
    .expect({ writes: [/WAKE_CONFIRMED\/BUTTON/], tray: [], check: () => expect(navLog).toContain('push /wake') });
});

describe('S07 끄지 않고 울림 끝', () => {
  useWorld();
  const ringEnd = () =>
    scenario('S07 끄지 않고 울림 끝')
      .at('07:00')
      .given(() => startDay({ appOpen: false }))
      .do(() => {
        // 기본 강도는 첫 울림 뒤 8분 · 16분에 다시 울림 — 마지막 울림(07:46)과 한 번 울림 최대 시간(3분)이 지난 뒤에야 저장소에서 지워짐
        for (const time of ['07:30', '07:38', '07:46']) {
          clock.set(time);
          phone.fireDue();
        }
        clock.set('07:50');
        phone.letRingEnd();
        clock.set('08:05');
        db.seed('alarm_events', [{ user_id: ME, alarm_id: WAKE, event_type: 'MISSED', event_at: clock.iso('08:00'), client_event_id: 'missed-2', input_source: 'SYSTEM' }]);
        phone.receivePush({ kind: 'WAKE_MISSED', recipientUserId: ME, path: '/wake' }, 'missed-push');
      });

  ringEnd().variant('폰은 저장소에서 지우고 해제 기록은 안 남김, 푸시가 알림창에 뜸').expect({
    phoneAlarms: AFTER_WAKE,
    tray: ['expo:missed-push'],
    check: () => expect(phone.events.map((e) => e.eventType)).toEqual(['TRIGGERED', 'TRIGGERED', 'TRIGGERED']),
  });

  ringEnd()
    .variant('푸시를 누르면 /wake로 열림')
    .do(async () => {
      phone.tapNotification('missed-push');
      await app.open();
    })
    .expect({ check: () => expect(navLog).toContain('push /wake') });

  ringEnd()
    .variant('푸시로 연 H08에서 [일어났어요]를 누를 길이 있음 — 해제 기록이 없어도 울린 기록 · 놓침이 있으면 확인 화면 (G1)')
    .do(async () => {
      phone.tapNotification('missed-push');
      await app.open();
    })
    .expect({
      check: async () => {
        const check = await app.js(() => getWakeCheck());
        expect(check).not.toBeNull();
        expect([check?.alarmId, check?.phase, check?.confirmed]).toEqual([WAKE, 'prompt', null]);
      },
    });

  ringEnd()
    .variant('[일어났어요]를 누르면 기상 확인이 서버에 기록됨 (BUTTON) — 해제를 안 했어도')
    .do(async () => {
      phone.tapNotification('missed-push');
      await app.open();
      await app.js(async () => {
        await getWakeCheck();
        await confirmWake(WAKE, 'self');
      });
    })
    .expect({ writes: [/WAKE_CONFIRMED\/BUTTON/, 'daily_records.insert('], tray: [] });

  ringEnd()
    .variant('울린 기록 · 놓침이 아직 폰에만 있어도(앱을 열기 전 푸시) 확인 화면이 열림')
    .do(async () => {
      db.remove('alarm_events', { event_type: 'MISSED' }); // 서버에는 놓침도 아직 없는 때 — 폰의 울림 기록(TRIGGERED, 올리기 전)만
      await app.open();
    })
    .expect({
      check: async () => {
        const check = await app.js(() => getWakeCheck());
        expect(check?.alarmId).toBe(WAKE);
      },
    });
});

describe('S08 앱 안 열고 미루기 2번', () => {
  useWorld();
  const snoozed = (deviceKey = true) =>
    scenario('S08 앱 안 열고 미루기 2번')
      .at('07:00')
      .given(() => startDay({ appOpen: false, deviceKey }))
      .do(async () => {
        clock.set('07:30');
        phone.fireDue();
        clock.set('07:31');
        await phone.native.snooze(10);
        clock.set('07:41');
        phone.fireDue();
        clock.set('07:42');
        await phone.native.snooze(10);
      });

  snoozed(false).variant('기기 키 없음 — 미룬 기록은 폰에만 쌓이고 서버에는 앱을 열 때 올라감').limit('앱 열림만').expect({
    noNativeWrites: ['alarm_events.insert(SNOOZED'],
    noWrites: ['alarm_events'],
    check: () => expect(phone.events.filter((e) => e.eventType === 'SNOOZED')).toHaveLength(2),
  });

  snoozed(false)
    .variant('기기 키 없음 — 앱을 열면 미룬 기록이 올라감')
    .do(async () => {
      await app.open();
    })
    .expect({ writes: ['alarm_events.upsert(', /SNOOZED/] });

  snoozed()
    .variant('앱을 안 열어도 울림 · 미룬 기록이 서버로 가서 서버 놓침 계산이 밀림 · 친구에게 알람 울리는 중 (G12)')
    .expect({
      nativeWrites: ['alarm_events.insert(TRIGGERED/BUTTON)', 'alarm_events.insert(SNOOZED/BUTTON)'],
      noWrites: ['alarm_events'], // 앱은 꺼져 있어 쓴 것이 없음
      check: () => {
        const rows = db.rows('alarm_events');
        expect(rows.filter((r) => r.event_type === 'TRIGGERED')).toHaveLength(2);
        expect(rows.filter((r) => r.event_type === 'SNOOZED').map((r) => r.snooze_minutes)).toEqual([10, 10]);
      },
    });
});

describe('S09 홈에서 미루기 취소', () => {
  useWorld();
  const cancelled = () =>
    scenario('S09 미루기 취소')
      .at('07:00')
      .given(async () => {
        await startDay();
        clock.set('07:30');
        phone.fireDue();
        clock.set('07:31');
        await app.js(() => snoozeRing(WAKE, 10));
        clock.set('07:35');
      })
      .do(() => app.js(() => cancelSnooze(WAKE)));

  cancelled().variant('해제로 서버에 쓰고 폰 예약을 지움').expect({ phoneAlarms: AFTER_WAKE, writes: ['alarm_events.upsert(', /DISMISSED\/MANUAL/] });
  cancelled().variant('해제 + 10분 판정 · 확인 알림이 폰에 걸려야 함').expect({ check: () => expect(phone.judges.map((j) => j.alarmId)).toContain(WAKE) });
});

describe('S10 해제 직후 재부팅', () => {
  useWorld();
  const rebooted = () =>
    scenario('S10 해제 직후 재부팅')
      .at('07:00')
      .given(() => startDay({ usage: 'auto', appOpen: false }))
      .do(() => {
        ringAndDismiss();
        phone.usageSpans = usageAuto(clock.ms('07:31'));
        clock.set('07:35');
        phone.reboot();
      });

  rebooted().variant('재부팅 뒤에도 남은 알람 예약은 되살아남').expect({ phoneAlarms: AFTER_WAKE });

  rebooted()
    .variant('앱을 열면 다시 판정해 확정')
    .do(async () => {
      clock.set('07:50');
      await app.open();
    })
    .expect({ writes: [/WAKE_CONFIRMED\/USAGE/] });

  rebooted()
    .variant('재부팅 뒤에도 해제 + 10분 판정이 돌아 앱 없이 확정 (G7)')
    .do(() => {
      clock.set('07:42:30');
      phone.runJudges();
    })
    .expect({ nativeWrites: [/WAKE_CONFIRMED\/USAGE/], noWrites: ['alarm_events', 'daily_records'], tray: [] });

  // 꺼져 있는 사이 판정 시각(07:41:02)이 지났으면 켜질 때 바로 한 번 판정
  rebooted()
    .variant('판정 시각이 재부팅 중에 지났으면 켜지자마자 한 번 판정해 확정 (G7)')
    .do(() => {
      clock.set('07:50');
      phone.reboot();
    })
    .expect({ nativeWrites: [/WAKE_CONFIRMED\/USAGE/], nativeLog: ['reboot', `judge:${WAKE}:AUTO`] });

  // 사용 기록이 없으면 확인 알림이 켜질 때 뜸
  scenario('S10 해제 직후 재부팅')
    .variant('사용 기록이 없으면 재부팅 뒤 판정 시각에 확인 알림이 뜸 (G7)')
    .at('07:00')
    .given(() => startDay({ usage: 'denied', appOpen: false }))
    .do(() => {
      ringAndDismiss();
      clock.set('07:35');
      phone.reboot();
      clock.set('07:42:30');
      phone.runJudges();
    })
    .expect({ tray: [`wakeprompt:${WAKE}`] });
});

describe('S11 23:50 알람 · 00:10 확인', () => {
  useWorld();
  const midnight = () =>
    scenario('S11 자정 넘겨 확인')
      .at('23:00')
      .given(async () => {
        seedAppointment({ key: 'a', at: '00:40+1', alarms: { WAKE: '23:50' } });
        phone.usageAccess = false;
        await app.open();
        await syncPhone();
        clock.set('23:50');
        phone.fireDue();
        clock.set('23:51');
        phone.dismiss();
      })
      .do(async () => {
        clock.set('00:10+1');
        await app.js(async () => {
          await getWakeCheck(WAKE);
          await confirmWake(WAKE, 'self');
        });
      });

  const dayOf = (offset: number) => new Date(clock.day + offset * 24 * 3_600_000 + 9 * 3_600_000).toISOString().slice(0, 10);
  midnight().variant('자정 넘겨 확인해도 기록은 남음').expect({ writes: [/WAKE_CONFIRMED\/BUTTON/, 'daily_records.insert('] });
  midnight().variant('하루 기록은 알람이 울린 날 한 곳이어야 함 — 앱은 확인한 시각의 날짜로 씀').expect({ check: () => expect(db.rows('daily_records').map((r) => r.record_date)).toEqual([dayOf(0)]) });
});

describe('S12 잘못 누른 기상 확인 정정', () => {
  useWorld();
  // 폰 사용으로 자동 확정된 아침 — 앱은 꺼져 있고 폰이 서버에 확정함
  const autoConfirmed = () =>
    scenario('S12 기상 정정')
      .at('07:00')
      .given(() => startDay({ usage: 'auto', appOpen: false }))
      .do(async () => {
        ringAndDismiss();
        phone.usageSpans = usageAuto(clock.ms('07:31'));
        judgeTime();
        await app.open();
        clock.set('07:45');
      });

  autoConfirmed()
    .variant('자동 확정 직후 홈에 기상 카드가 뜸 — 확정 시각과 알람 id (G9)')
    .expect({
      check: async () => {
        const auto = await app.js(() => getAutoWake());
        expect(auto?.alarmId).toBe(WAKE);
        expect(auto?.at.toISOString()).toBe(db.rows('alarm_events').find((r) => r.event_type === 'WAKE_CONFIRMED')?.event_at);
      },
    });

  autoConfirmed()
    .variant('[아니에요] — 그 날 기상 확정을 취소하고 하루 기록의 기상 칸도 비움 (G9)')
    .do(async () => {
      expect(await app.js(() => correctAutoWake(WAKE))).toBe(true);
    })
    .expect({
      check: async () => {
        expect(db.rows('alarm_events').filter((r) => r.event_type === 'WAKE_CONFIRMED')).toHaveLength(0);
        expect(db.rows('daily_records').map((r) => r.wake_confirmed_at)).toEqual([null]);
        expect(await app.js(() => getAutoWake())).toBeNull();
      },
    });

  autoConfirmed()
    .variant('[아니에요] 뒤에는 같은 해제로 다시 자동 확정되지 않고 H08 확인 알림 단계로 돌아가 [일어났어요]로 확정 (G9)')
    .do(async () => {
      await app.js(() => correctAutoWake(WAKE));
      clock.set('07:50');
      await app.open(); // 앞에 올 때 다시 판정(recheck)이 돎
    })
    .expect({
      check: async () => {
        expect(db.rows('alarm_events').filter((r) => r.event_type === 'WAKE_CONFIRMED')).toHaveLength(0);
        const check = await app.js(() => getWakeCheck(WAKE));
        expect(check?.phase).toBe('prompt');
        expect(check?.confirmed).toBeNull();
        await app.js(() => confirmWake(WAKE, 'self'));
        const rows = db.rows('alarm_events').filter((r) => r.event_type === 'WAKE_CONFIRMED');
        expect(rows.map((r) => r.input_source)).toEqual(['BUTTON']);
        expect(db.rows('daily_records').map((r) => r.wake_confirmed_at)).toEqual([rows[0].event_at]);
      },
    });

  autoConfirmed()
    .variant('대화로 "아직 안 일어났어"(WAKE · DENY)도 같은 정정')
    .do(async () => {
      const result = await app.js(() => applyFix({ id: 'x1', kind: 'WAKE', participantId: participantIdOf('a'), action: 'DENY', to: null }));
      expect(result.ok).toBe(true);
    })
    .expect({ check: () => expect(db.rows('alarm_events').filter((r) => r.event_type === 'WAKE_CONFIRMED')).toHaveLength(0) });

  scenario('S12 기상 정정')
    .variant('버튼 · 확인으로 확정한 기상은 정정 대상이 아님 — 지우지 않고 카드도 없음 (이번엔 자동 판정만)')
    .at('07:00')
    .given(() => startDay({ usage: 'denied' }))
    .do(async () => {
      ringAndDismiss();
      await app.js(async () => {
        await getWakeCheck(WAKE);
        await confirmWake(WAKE, 'self');
      });
    })
    .expect({
      check: async () => {
        expect(await app.js(() => getAutoWake())).toBeNull();
        expect(await app.js(() => correctAutoWake(WAKE))).toBe(false);
        expect(db.rows('alarm_events').filter((r) => r.event_type === 'WAKE_CONFIRMED')).toHaveLength(1);
      },
    });
});

describe('S13 친구가 깨우기 2번 → 일어남', () => {
  useWorld();
  scenario('S13 깨우기 알림 정리')
    .variant('깨우기 알림 2개가 떠 있다가 일어나 확정하면 알림창에서 정리돼야 함 — 지금은 남음')
    .at('07:00')
    .given(() => startDay({ usage: 'denied' }))
    .do(async () => {
      ringAndDismiss();
      app.background();
      phone.receivePush({ kind: 'WAKE_PING', recipientUserId: ME, path: '/wake' }, 'ping-1');
      phone.receivePush({ kind: 'WAKE_PING', recipientUserId: ME, path: '/wake' }, 'ping-2');
      await app.foreground();
      await app.js(async () => {
        await getWakeCheck(WAKE);
        await confirmWake(WAKE, 'self');
      });
    })
    .expect({ tray: [] });
});
