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
} from '../api';

const WAKE = 'a1:WAKE'; // 팀 주간회의 기상 오전 8:00
const morning = kst(22, 475); // 오전 7:55
const me = () => memberState('me', morning).text;
const labels = () => db.events.map((e) => `${formatTime(e.at)} ${e.label}`);

afterEach(() => {
  db.wake = { alarmId: null, phase: 'idle', ringAt: null, dismissedAt: null };
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

  it('미루면 울리는 중 표시만 지움', async () => {
    await startRing(WAKE, kst(22, 480));
    await snoozeRing(WAKE);
    expect(me()).toBe('취침 중 · 알람 8:00');
    expect(db.events).toHaveLength(0);
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
    const check = await getWakeCheck(WAKE);
    expect([check!.phase, formatTime(check!.dismissedAt)]).toEqual(['observing', '오전 8:00']);
  });
});
