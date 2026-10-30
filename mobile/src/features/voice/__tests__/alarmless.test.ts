import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

import { estimateAppointment, listAppointments } from '@/features/alarm/api';
import { aiDb } from '@/mocks/ai';
import { db, kst, TODAY } from '@/mocks/data';

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
    expect(c.cards[0]?.status).toBe('SAVED');
    expect(c.messages[c.messages.length - 1].text).toBe('저장했어요. 내일 일정은 알람 없이 저장해 둘게요. 오늘 대화는 여기까지 할까요?');
    expect(db.events.map((e) => `${e.label} · ${e.source}`)).toContain('일정 저장 · 스터디 · AI 대화 · 수정함');
  });
});

// A02 → H05 "수정"에서 알람 종류를 일부만 켜고 저장 (D46) — AI 답이 켠 알람 시각만 말함 (끈 알람 자리에 다른 알람 시각이 "준비 · 출발"로 나오지 않음)
// 다른 날(5월 24일, 그날 첫 일정이라 기상 알람이 만들어짐)로 고쳐 저장하고, 시험마다 앞에서 만든 일정 · 대화를 되돌리고 시작
describe('AI 대화 → H05 수정 → 알람 일부만 켜고 저장', () => {
  const baseIds = db.appointments.map((a) => a.id);

  beforeAll(() => {
    mockTiming.replyMs = 0;
  });

  beforeEach(() => {
    db.appointments = db.appointments.filter((a) => baseIds.includes(a.id));
    aiDb.chat = null;
  });

  async function saveOnly(alarms: { WAKE: boolean; PREPARE: boolean; DEPARTURE: boolean }) {
    await getConversation();
    await say();
    await say(); // 찾은 일정 카드
    const draft = foundScheduleDraft()!;
    const estimate = await estimateAppointment({ ...draft, date: kst(TODAY + 2, 0), alarms });
    const saved = await saveFoundSchedule(estimate);
    const c = await getConversation();
    return { saved, reply: c.messages[c.messages.length - 1].text };
  }
  const tail = ' 알람을 맞춰 둘게요. 오늘 대화는 여기까지 할까요?';

  it('모두 켜면 준비 · 출발 시각으로 답함 (그대로)', async () => {
    const { reply } = await saveOnly({ WAKE: true, PREPARE: true, DEPARTURE: true });
    expect(reply).toBe(`저장했어요. 5월 24일 오후 12:25 준비, 오후 1:05 출발${tail}`);
  });

  it('준비만 끄면 기상 · 출발 시각으로 답함 (기상 시각이 "준비"로 나오지 않음)', async () => {
    const { saved, reply } = await saveOnly({ WAKE: true, PREPARE: false, DEPARTURE: true });
    expect(saved.alarms.map((x) => x.kind)).toEqual(['WAKE', 'DEPARTURE', 'ARRIVE']);
    expect(reply).toBe(`저장했어요. 5월 24일 오후 12:05 기상, 오후 1:05 출발${tail}`);
  });

  it('기상만 켜면 기상 시각 하나로 답함 ("12:05 준비, 12:05 출발"로 나오지 않음)', async () => {
    const { saved, reply } = await saveOnly({ WAKE: true, PREPARE: false, DEPARTURE: false });
    expect(saved.alarms.map((x) => x.kind)).toEqual(['WAKE', 'ARRIVE']);
    expect(reply).toBe(`저장했어요. 5월 24일 오후 12:05 기상${tail}`);
  });

  it('출발만 켜면 출발 시각이 "준비"로 읽히지 않음', async () => {
    const { reply } = await saveOnly({ WAKE: false, PREPARE: false, DEPARTURE: true });
    expect(reply).toBe(`저장했어요. 5월 24일 오후 1:05 출발${tail}`);
  });
});
