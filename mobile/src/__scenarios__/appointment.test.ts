// 시나리오 S27 ~ S29 — 약속 변화: 남이 공동 약속을 바꿈 · 취소함 · 내가 빠짐 · 내가 시각을 바꿈
//   서버가 약속을 고치고 푸시를 보내는 일(edit-run · 푸시 발송)은 서버 시나리오가 보고, 여기서는 서버가 바뀐 뒤 폰이 어떻게 되는지를 봄 — 서버 효과는 시나리오가 직접 만듦
import './testkit/install';

import { describe } from '@jest/globals';

import { leaveSharedAppointment, updateAppointment } from '@/features/alarm/realEdit';

import { db } from './testkit/fakeDb';
import { phone } from './testkit/phone';
import { scenario, useWorld } from './testkit/scenario';
import { alarmIdOf, app, appointmentIdOf, clock, ME, ringPackage, seedAppointment, seedGroup, settle, uid } from './testkit/world';

const ALARMS = { WAKE: '07:30', PREPARE: '09:00', DEPARTURE: '09:20', ARRIVE: '10:00' };
const OLD = ['WAKE@07:30', 'PREPARE@09:00', 'DEPARTURE@09:20', 'ARRIVE@10:00'];
const NEW = ['WAKE@07:45', 'PREPARE@09:15', 'DEPARTURE@09:35', 'ARRIVE@10:15'];
const g1 = (type: 'WAKE' | 'PREPARE' | 'DEPARTURE' | 'ARRIVE') => alarmIdOf('g1', type);
const ALL_IDS = [g1('WAKE'), g1('PREPARE'), g1('DEPARTURE'), g1('ARRIVE')];

// 공동 약속이 폰에 걸린 상태에서 시작
const sharedDay = async () => {
  seedGroup('g');
  seedAppointment({ key: 'g1', at: '10:00', group: 'g', alarms: ALARMS });
  await app.open();
};

// 다른 참여자가 시각을 바꿈 — 서버가 내 알람 시각도 이미 고쳐 둠 (한 시간 15분씩 뒤로)
const serverChangedTimes = () => {
  const times: Record<string, string> = { WAKE: '07:45', PREPARE: '09:15', DEPARTURE: '09:35', ARRIVE: '10:15' };
  for (const [type, time] of Object.entries(times)) db.patch('alarms', { alarm_id: g1(type as 'WAKE') }, { scheduled_at: clock.iso(time) });
};
const changedPush = () => phone.receivePush({ kind: 'GROUP_APPT_CHANGED', change: 'CHANGED', needsConfirm: false, appointmentId: appointmentIdOf('g1'), groupId: uid('group:g'), recipientUserId: ME, path: '/group' }, 'chg');

const serverCanceled = () => {
  db.remove('alarms', { participant_id: uid('part:g1:user-me') });
  db.remove('appointment_participants', { participant_id: uid('part:g1:user-me') });
};
const canceledPush = () => phone.receivePush({ kind: 'GROUP_APPT_CHANGED', change: 'CANCELED', appointmentId: appointmentIdOf('g1'), groupId: uid('group:g'), recipientUserId: ME, path: '/group' }, 'cnl');

describe('S27 남이 공동 약속 시각 변경', () => {
  useWorld();
  const changed = () =>
    scenario('S27 남이 시각 변경')
      .at('06:00')
      .given(sharedDay);

  changed()
    .variant('앱이 앞에 있을 때 푸시를 받으면 바로 폰 알람이 새 시각으로')
    .do(async () => {
      serverChangedTimes();
      await app.js(async () => {
        changedPush();
      });
    })
    .expect({ phoneAlarms: NEW });

  changed()
    .variant('앱이 꺼진 채 푸시를 눌러 열면 새 시각으로')
    .do(async () => {
      await app.kill();
      serverChangedTimes();
      changedPush();
      phone.tapNotification('chg');
      await app.open();
    })
    .expect({ phoneAlarms: NEW });

  changed()
    .variant('앱이 꺼진 채 푸시를 안 보고 지나가면 폰은 옛 시각 그대로')
    .limit('앱 열림만')
    .do(async () => {
      await app.kill();
      serverChangedTimes();
      changedPush();
    })
    .expect({ phoneAlarms: OLD });

  changed()
    .gap('G2')
    .variant('앱이 꺼진 채 푸시를 받으면(안 눌러도) 폰 알람이 새 시각으로 맞춰져야 함')
    .do(async () => {
      await app.kill();
      serverChangedTimes();
      changedPush();
    })
    .expect({ phoneAlarms: NEW });

  changed()
    .variant('앱이 뒤에 있어도 JS가 살아 있으면 받음 처리가 돌아 새 시각으로 (usePushLinks는 앱 상태를 안 봄)')
    .do(async () => {
      app.background();
      serverChangedTimes();
      changedPush();
      await settle();
    })
    .expect({ phoneAlarms: NEW });
});

describe('S28 남이 공동 약속 취소', () => {
  useWorld();
  const canceled = () =>
    scenario('S28 남이 취소')
      .at('06:00')
      .given(sharedDay);

  canceled()
    .variant('앱이 앞에 있을 때 푸시를 받으면 폰 알람이 지워짐')
    .do(async () => {
      serverCanceled();
      await app.js(async () => {
        canceledPush();
      });
    })
    .expect({ phoneAlarms: [] });

  canceled()
    .variant('푸시를 눌러 열면 지워짐')
    .do(async () => {
      await app.kill();
      serverCanceled();
      canceledPush();
      phone.tapNotification('cnl');
      await app.open();
    })
    .expect({ phoneAlarms: [] });

  canceled()
    .variant('앱이 꺼진 채 안 보면 취소된 약속의 알람이 폰에 남음')
    .limit('앱 열림만')
    .do(async () => {
      await app.kill();
      serverCanceled();
      canceledPush();
    })
    .expect({ phoneAlarms: OLD });

  canceled()
    .gap('G2')
    .variant('앱이 꺼진 채 취소 푸시를 받으면 폰 알람이 지워져야 함 — 안 지우면 취소된 약속 알람이 울림')
    .do(async () => {
      await app.kill();
      serverCanceled();
      canceledPush();
    })
    .expect({ phoneAlarms: [] });
});

describe('S29 내가 약속에서 빠짐 · 시각을 바꿈', () => {
  useWorld();
  // 도착 확인 알림(10:00)이 이미 울려 알림창에 남아 있는 상태 (준비 · 출발은 11/19부터 알람이라 알림창이 아니라 울림 — 이미 지난 시각이라 폰에 안 걸림)
  const withNotice = () =>
    scenario('S29 약속 변경')
      .at('09:55')
      .given(async () => {
        await sharedDay();
        clock.set('10:01');
        phone.fireDue();
      });

  withNotice()
    .variant('빠지기 — 서버 응답의 지울 알람(canceled_alarm_ids)으로 폰 알람과 남은 알림이 같이 정리됨')
    .do(async () => {
      db.edgeHandlers['appointment-edit'] = () => {
        serverCanceled();
        return { left: true, ring_packages: [], canceled_alarm_ids: ALL_IDS };
      };
      await app.js(() => leaveSharedAppointment(appointmentIdOf('g1')));
    })
    .expect({ phoneAlarms: [], tray: [] });

  withNotice()
    .variant('빠지기 오프라인 — 실패하고 바뀐 것 없음')
    .do(async () => {
      db.offline = true;
      await app.js(() => leaveSharedAppointment(appointmentIdOf('g1')).catch(() => undefined));
    })
    .expect({ phoneAlarms: [], tray: [`notice:${g1('ARRIVE')}`] });

  const retimed = () =>
    withNotice().do(async () => {
      db.edgeHandlers['appointment-edit'] = () => {
        db.patch('alarms', { alarm_id: g1('ARRIVE') }, { scheduled_at: clock.iso('10:15') });
        return { saved: true, needs_confirm: false, changes: [], ring_packages: [ringPackage(g1('ARRIVE'), 'ARRIVE', '10:15')], canceled_alarm_ids: [] };
      };
      await app.js(() => updateAppointment(appointmentIdOf('g1'), { at: new Date(clock.ms('10:15')) }, 'this'));
    });

  retimed().variant('시각 변경 — 남은 알람은 새 시각으로 걸림').expect({ phoneAlarms: ['ARRIVE@10:15'] });
  retimed().gap('G5').variant('시각 변경 — 이미 울려 남은 옛 도착 확인 알림도 정리돼야 함 (응답에 지울 알람이 없어 남음)').expect({ tray: [] });
});
