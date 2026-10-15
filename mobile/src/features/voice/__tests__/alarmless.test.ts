import { beforeAll, describe, expect, it } from '@jest/globals';

import { estimateAppointment, listAppointments } from '@/features/alarm/api';
import { db } from '@/mocks/data';

import { foundScheduleDraft, getConversation, mockTiming, saveFoundSchedule, say } from '../api';

// A02 → H05 "수정"에서 알람 종류를 모두 끄고 저장 (D46) — 맞춰 둘 알람 시각이 없어도 대화가 깨지지 않고 알람 없이 저장했다고 답함
// (테스트 파일마다 목업 데이터가 새로 읽혀서 api.test.ts의 저장과 섞이지 않음)
describe('AI 대화 → H05 수정 → 알람 없이 저장', () => {
  beforeAll(() => {
    mockTiming.replyMs = 0;
  });

  it('알람이 없는 일정으로 저장되고 AI는 알람 시각 대신 알람 없이 저장했다고 답함', async () => {
    await getConversation();
    await say();
    await say(); // 찾은 일정 카드
    const draft = foundScheduleDraft()!;
    const estimate = await estimateAppointment({ ...draft, alarms: { WAKE: false, PREPARE: false, DEPARTURE: false } });

    const saved = await saveFoundSchedule(estimate);
    expect(saved.alarms).toEqual([]);
    expect((await listAppointments()).map((a) => a.id)).not.toContain(saved.id); // 알람 목록에는 없음
    expect(db.appointments.some((a) => a.id === saved.id)).toBe(true); // 일정으로는 있음

    const c = await getConversation();
    expect(c.found?.status).toBe('APPLIED');
    expect(c.messages[c.messages.length - 1].text).toBe('저장했어요. 내일 일정은 알람 없이 저장해 둘게요. 오늘 대화는 여기까지 할까요?');
    expect(db.events.map((e) => `${e.label} · ${e.source}`)).toContain('일정 저장 · 스터디 · AI 대화 · 수정함');
  });
});
