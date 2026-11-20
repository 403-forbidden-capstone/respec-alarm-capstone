// 시나리오 S21 · S25 · S26 — 공유 · 관계: 출발 · 도착 공유 스위치, 그룹 나가기, 내보내짐
//   서버 트리거(나가면 참여 · 알람을 지움, 공유 스위치 연쇄)는 서버 시나리오가 보고, 여기서는 "서버가 그렇게 바꾼 뒤" 폰이 어떻게 되는지를 봄 — 시나리오가 서버 효과를 직접 만듦
import './testkit/install';

import { describe, expect } from '@jest/globals';

import { setTripShareOptIn, setWakeShareOptIn, leaveGroup } from '@/features/social/real/groups';

import { db } from './testkit/fakeDb';
import { phone } from './testkit/phone';
import { scenario, useWorld } from './testkit/scenario';
import { alarmIdOf, app, clock, ME, seedAppointment, seedGroup, uid } from './testkit/world';

const myMember = () => db.rows('group_members').find((r) => r.user_id === ME)!;

describe('S21 출발 · 도착 공유를 끈 사람', () => {
  useWorld();
  const shared = () =>
    scenario('S21 출발 · 도착 공유')
      .at('07:00')
      .given(async () => {
        seedGroup('g', { wake: true, trip: false });
        await app.open();
      });

  shared()
    .variant('출발 · 도착 공유는 기본 끔, 켜면 그 값만 서버에 씀')
    .do(() => app.js(() => setTripShareOptIn(uid('group:g'), true)))
    .expect({ writes: ['group_members.update(trip_share_opt_in)'], check: () => expect(myMember().trip_share_opt_in).toBe(true) });

  shared()
    .variant('기상 공유를 끄면 출발 · 도착 공유도 같이 꺼서 씀')
    .do(async () => {
      await app.js(() => setTripShareOptIn(uid('group:g'), true));
      await app.js(() => setWakeShareOptIn(uid('group:g'), false));
    })
    .expect({ check: () => expect([myMember().wake_share_opt_in, myMember().trip_share_opt_in]).toEqual([false, false]) });
});

describe('S25 그룹 나가기', () => {
  useWorld();
  // 공동 약속(그룹 g) — 준비 08:05는 이미 울리는 중(11/19부터 알람), 출발 08:40 · 도착 10:00은 폰에 걸려 있음
  //   alarms로 도착 알림이 이미 울려 알림창에 남은 변형도 만듦 (도착 확인은 알림 — 알람이 아님)
  const left = (alarms: { PREPARE?: string; DEPARTURE: string; ARRIVE: string } = { PREPARE: '08:05', DEPARTURE: '08:40', ARRIVE: '10:00' }, ringAt = '08:10') =>
    scenario('S25 그룹 나가기')
      .at('07:55')
      .given(async () => {
        seedGroup('g');
        seedAppointment({ key: 'g1', at: '10:00', group: 'g', alarms });
        await app.open();
        clock.set(ringAt);
        phone.fireDue(); // 시각이 지난 알람이 울림 (준비) · 알림창에 뜸 (도착 확인)
        // 서버 트리거(M-grp): 내 멤버 줄이 LEFT가 되는 쓰기와 같은 순간 서버가 나간 그룹의 공동 약속 참여 · 알람을 지움
        //   앱이 나간 직후 맞추기를 하도록 고쳐지면 그 맞추기가 이미 지워진 서버를 읽게 하려고 쓰기 안에서 일으킴
        db.afterWrite = (write) => {
          if (write.table === 'group_members' && write.op === 'update' && (write.payload as { invite_status?: string }).invite_status === 'LEFT') {
            db.remove('alarms', { participant_id: uid('part:g1:user-me') });
            db.remove('appointment_participants', { participant_id: uid('part:g1:user-me') });
          }
        };
      })
      .do(async () => {
        await app.js(() => leaveGroup(uid('group:g')));
      });

  left().variant('나가기는 내 멤버 줄만 LEFT로 씀').expect({ writes: ['group_members.update(invite_status)'], check: () => expect(myMember().invite_status).toBe('LEFT') });

  left().variant('앱을 연 채 나가면 나간 그룹 약속의 폰 알람이 바로 정리돼야 함').expect({ phoneAlarms: [] });

  left()
    .limit('앱 열림만')
    .variant('앱이 다시 앞에 오면 폰 알람이 정리됨')
    .do(async () => {
      app.background();
      await app.foreground();
    })
    .expect({ phoneAlarms: [] });

  left()
    .variant('울리는 중이던 준비 알람은 앱이 다시 앞에 오면 함께 멈춤 (서버에 켜진 행이 없다고 확인됨)')
    .do(async () => {
      app.background();
      await app.foreground();
    })
    .expect({ check: () => expect([phone.ringing, phone.store.size]).toEqual([null, 0]) });

  // 도착 확인 알림(10:00)이 이미 울려 알림창에 남아 있는 때 — 출발 09:20은 울렸다가 해제함
  left({ DEPARTURE: '09:20', ARRIVE: '10:00' }, '10:05')
    .variant('이미 울려 알림창에 남은 도착 확인 알림도 나간 직후 정리됨 (앱이 다시 앞에 오기 전에)')
    .expect({ tray: [] });

  left({ DEPARTURE: '09:20', ARRIVE: '10:00' }, '10:05')
    .variant('앱이 다시 앞에 와도 그대로 정리돼 있음')
    .do(async () => {
      app.background();
      await app.foreground();
    })
    .expect({ tray: [] });
});

describe('S26 내보내짐', () => {
  useWorld();
  const removed = () =>
    scenario('S26 내보내짐')
      .at('07:55')
      .given(async () => {
        seedGroup('g');
        seedAppointment({ key: 'g1', at: '10:00', group: 'g', alarms: { PREPARE: '08:05', DEPARTURE: '08:40', ARRIVE: '10:00' } });
        await app.open();
        await app.kill();
      })
      .do(() => {
        // 다른 멤버가 나를 내보냄 — 서버 트리거가 내 참여 · 알람을 지움. 폰은 모름 (알림 없음이 설계)
        db.remove('group_members', { user_id: ME });
        db.remove('alarms', { participant_id: uid('part:g1:user-me') });
        db.remove('appointment_participants', { participant_id: uid('part:g1:user-me') });
      });

  removed().variant('앱이 꺼져 있으면 폰 알람은 그대로 — 알림도 없음').limit('앱 열림만').expect({ phoneAlarms: ['PREPARE@08:05', 'DEPARTURE@08:40', 'ARRIVE@10:00'], tray: [] });

  removed()
    .variant('앱을 열면 폰 알람이 정리됨')
    .do(async () => {
      await app.open();
    })
    .expect({ phoneAlarms: [] });

  removed()
    .variant('08:05에 준비 알람이 울리는 중에 열면 울림도 함께 멈춤 (울리는 중은 저장소에 있어 맞추기가 지움)')
    .do(async () => {
      clock.set('08:06');
      phone.fireDue();
      await app.open();
    })
    .expect({ phoneAlarms: [], tray: [], check: () => expect(phone.ringing).toBeNull() });

  removed()
    .variant('10:01에 도착 확인 알림이 울린 뒤 열면 그 알림은 남음 (저장소 밖이라 맞추기가 못 거둠)')
    .do(async () => {
      clock.set('10:01');
      phone.fireDue();
      await app.open();
    })
    .limit('알림창은 맞추기 대상 밖')
    .expect({ phoneAlarms: [], tray: [`notice:${alarmIdOf('g1', 'ARRIVE')}`] });
});
