import { afterEach, describe, expect, it } from '@jest/globals';

import { formatTime } from '@/lib/format';
import { memberState } from '@/mocks/calc';
import { db, kst } from '@/mocks/data';

import {
  confirmWake,
  dismissRing,
  draftAt,
  getRing,
  getWakeCheck,
  missWake,
  promptWake,
  snoozeRing,
  startRing,
  stopRing,
} from '../api';

const WAKE = 'a1:WAKE'; // 팀 주간회의 기상 오전 8:00
const morning = kst(22, 475); // 오전 7:55
const me = () => memberState('me', morning).text;
const labels = () => db.events.map((e) => `${formatTime(e.at)} ${e.label}`);

afterEach(() => {
  db.wake = { alarmId: null, phase: 'idle', ringAt: null, dismissedAt: null, usage: 0, recent: 0 };
  db.events.length = 0;
  db.me.wakeAt = null;
  for (const id of Object.keys(db.wakeConfirmations)) delete db.wakeConfirmations[id];
});

describe('H05 시간 칸', () => {
  it('고른 시각을 그날 시각으로', () => {
    expect(formatTime(draftAt(kst(23, 0), '14:00'))).toBe('오후 2:00');
    expect(formatTime(draftAt(kst(23, 0), '9:05'))).toBe('오전 9:05');
  });

  it('비었거나 틀리면 목업처럼 14:00', () => {
    expect(formatTime(draftAt(kst(23, 0), ''))).toBe('오후 2:00');
    expect(formatTime(draftAt(kst(23, 0), '25:99'))).toBe('오후 2:00');
  });
});

describe('H07 · H08 기상 알람 → 해제 → 확인 알림 → 다시 울림', () => {
  it('울림 · 해제 · 확인 중이 내 상태에 보이고, 다시 울린 시각부터 다시 판정', async () => {
    const first = await getRing(WAKE);
    expect(formatTime(first!.at)).toBe('오전 8:00');
    await startRing(WAKE, first!.at);
    expect(me()).toBe('알람 울리는 중');

    await dismissRing(WAKE, first!.at);
    expect(me()).toBe('알람 해제 · 기상 확인 중');
    let check = await getWakeCheck(WAKE);
    expect([check!.phase, formatTime(check!.dismissedAt)]).toEqual(['observing', '오전 8:00']);

    await promptWake(WAKE, kst(22, 490));
    expect(me()).toBe('알람 해제 · 기상 확인 중');
    check = await getWakeCheck();
    expect([check!.phase, formatTime(check!.dismissedAt)]).toEqual(['prompt', '오전 8:00']);

    await missWake(WAKE, kst(22, 495));
    expect(me()).toBe('알람 울리는 중');
    const again = await getRing(WAKE, true);
    expect(formatTime(again!.at)).toBe('오전 8:15');

    await dismissRing(WAKE, again!.at);
    check = await getWakeCheck(WAKE);
    expect([check!.phase, formatTime(check!.dismissedAt)]).toEqual(['observing', '오전 8:15']);

    await confirmWake(WAKE, 'self', kst(22, 505));
    expect(me()).toBe('기상 완료 · 오전 8:25');
    expect(db.wake.phase).toBe('confirmed');
    expect(labels()).toEqual([
      '오전 8:00 기상 알람 해제',
      '오전 8:10 확인 알림 발송',
      '오전 8:15 재알람',
      '오전 8:15 기상 알람 해제',
      '오전 8:25 기상 확인',
    ]);
  });

  it('미루면 울리는 중 표시를 지우고 미루기를 기록 (목업 A.snooze)', async () => {
    await startRing(WAKE, kst(22, 480));
    await snoozeRing(WAKE, 10, kst(22, 480));
    expect(me()).toBe('취침 중 · 알람 8:00');
    expect(labels()).toEqual(['오전 8:00 기상 알람 10분 미루기']);
  });

  it('미루기 · 해제 없이 나가면 울리는 중 표시만 지우고 기록은 없음', async () => {
    await startRing(WAKE, kst(22, 480));
    await stopRing(WAKE);
    expect(me()).toBe('취침 중 · 알람 8:00');
    expect(db.wake.phase).toBe('idle');
    expect(db.events).toHaveLength(0);
  });

  it('again은 기상 알람만 — 준비 · 출발은 원래 시각과 문장', async () => {
    const prepare = await getRing('a1:PREPARE', true);
    expect(formatTime(prepare!.at)).toBe('오전 8:30');
    expect(prepare!.voiceLine).toBe((await getRing('a1:PREPARE'))!.voiceLine);
    const depart = await getRing('a1:DEPARTURE', true);
    expect(depart!.at).toEqual((await getRing('a1:DEPARTURE'))!.at);
  });

  it('기상 확정한 알람은 다시 울려도 판정 · 기록을 그대로 둠', async () => {
    await startRing(WAKE, kst(22, 480));
    await dismissRing(WAKE, kst(22, 480));
    await confirmWake(WAKE, 'auto', kst(22, 490));
    await startRing(WAKE, kst(22, 495));
    expect(db.wake.phase).toBe('confirmed');
    await dismissRing(WAKE, kst(22, 495));
    await snoozeRing(WAKE, 5, kst(22, 495)); // 확정 뒤에 미뤄도 기록이 붙지 않음
    expect(db.wake.phase).toBe('confirmed');
    expect(me()).toBe('기상 완료 · 오전 8:10');
    expect(labels()).toEqual(['오전 8:00 기상 알람 해제', '오전 8:10 기상 확인']);
  });

  it('준비 · 출발 알람은 해제만 기록하고 기상 판정은 그대로', async () => {
    await startRing('a1:PREPARE', kst(22, 510));
    await dismissRing('a1:PREPARE', kst(22, 510));
    expect(db.wake.phase).toBe('idle');
    expect(labels()).toEqual(['오전 8:30 준비 알람 해제']);
  });

  it('주소로 바로 연 다시 울림은 알람 + 관찰 10분 + 응답 없음 5분', async () => {
    const again = await getRing(WAKE, true);
    expect(formatTime(again!.at)).toBe('오전 8:15');
  });
});

describe('H08 기상 확인 화면 데이터', () => {
  it('확정 전인데 아직 안 껐으면(울리기 전 · 울리는 중) 목업 빈 화면처럼 null', async () => {
    expect(await getWakeCheck(WAKE)).toBeNull();
    expect(await getWakeCheck()).toBeNull();
    await startRing(WAKE, kst(22, 480));
    expect(await getWakeCheck(WAKE)).toBeNull();
    await stopRing(WAKE);
    expect(await getWakeCheck()).toBeNull();
    await dismissRing(WAKE, kst(22, 480));
    expect((await getWakeCheck())!.phase).toBe('observing');
  });

  it('사용 시간은 db.wake에서 — 해제 0 · 확인 알림 0.4/0 · 직접 응답은 그대로', async () => {
    const use = async () => {
      const c = await getWakeCheck(WAKE);
      return [c!.usage, c!.recent];
    };
    await dismissRing(WAKE, kst(22, 480));
    expect(await use()).toEqual([0, 0]);
    await promptWake(WAKE, kst(22, 490));
    expect(await use()).toEqual([0.4, 0]);
    await confirmWake(WAKE, 'self', kst(22, 491));
    expect(await use()).toEqual([0.4, 0]);
    expect((await getWakeCheck(WAKE))!.confirmed!.how).toBe('self');
  });

  it('자동 판정은 폰을 보며 일어난 값 3.2/1.4', async () => {
    await dismissRing(WAKE, kst(22, 480));
    await confirmWake(WAKE, 'auto', kst(22, 490));
    const check = await getWakeCheck(WAKE);
    expect([check!.usage, check!.recent, formatTime(check!.confirmed!.at)]).toEqual([3.2, 1.4, '오전 8:10']);
  });

  it('확정한 판정의 사용 시간은 다른 기상 알람이 울려도 그대로', async () => {
    await dismissRing(WAKE, kst(22, 480));
    await confirmWake(WAKE, 'auto', kst(22, 490));
    db.wake = { ...db.wake, alarmId: 'other:WAKE', phase: 'ringing', usage: 0, recent: 0 }; // 다른 기상 알람이 울림
    const check = await getWakeCheck(WAKE);
    expect([check!.usage, check!.recent, check!.confirmed!.how]).toEqual([3.2, 1.4, 'auto']);
  });
});
