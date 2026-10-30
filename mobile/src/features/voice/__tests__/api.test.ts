import { beforeAll, describe, expect, it } from '@jest/globals';

import { declineRoutineSuggestion, editJournal, getJournal, getRoutine, saveRoutine } from '@/features/routine/api';
import { formatTime } from '@/lib/format';
import { db } from '@/mocks/data';

import { finishConversation, foundScheduleDraft, getConversation, mockTiming, rejectFoundSchedule, saveFoundSchedule, say } from '../api';

// A02 → A03 → A04 한 바퀴 — 목업에서 말하기 두 번 · 저장 · 완료 · 루틴 만들기를 누른 것과 같은 결과인지
// (테스트 파일마다 목업 데이터가 새로 읽혀서 다른 테스트에 남지 않음)
describe('AI 대화 → 하루 기록 → 루틴', () => {
  beforeAll(() => {
    mockTiming.replyMs = 0; // AI가 정리하는 척 기다리는 시간 없이
  });

  it('대본대로 주고받으면 찾은 일정 카드가 뜨고 준비물이 바로 들어감', async () => {
    const start = await getConversation();
    expect(start.messages.map((m) => m.who)).toEqual(['ai']);
    expect(start.next?.who).toBe('me');
    expect(foundScheduleDraft()).toBeNull();

    const first = await say(); // 내 말 + AI 답을 한 번에
    expect(first.messages.map((m) => m.who)).toEqual(['ai', 'me', 'ai']);
    expect(first.next?.who).toBe('me');
    const c = await say();

    expect(c.messages.map((m) => m.who)).toEqual(['ai', 'me', 'ai', 'me', 'card']);
    expect(c.next).toBeNull();
    expect(c.cards).toHaveLength(1);
    expect(c.cards[0]).toMatchObject({ id: 'c1', kind: 'APPT_NEW', title: '스터디', place: '학교 도서관', items: ['노트북 충전기'], status: 'READY', firstOfDay: true });
    expect(formatTime(c.cards[0].at!)).toBe('오후 2:00');
    expect(db.todos.filter((t) => t.title === '노트북 충전기' && t.day === 23)).toHaveLength(1);
    expect(db.events.map((e) => `${e.label} · ${e.source}`)).toContain('준비물 저장 · 노트북 충전기 · AI 대화');
    expect(foundScheduleDraft()?.title).toBe('스터디');

    await say(); // 대본이 끝나면 아무 일 없음
    expect((await getConversation()).messages).toHaveLength(5);
  });

  it('저장하면 알람을 맞추고 준비 · 출발 시각으로 답함 (같은 날 수업 기상이 있어 외출 준비만)', async () => {
    const saved = await saveFoundSchedule();
    expect(saved.title).toBe('스터디');
    // 같은 날 두 번째 일정은 개인 보정 없이 공통 15분 그대로 (학습 루프 기초 2절 2 버그 수정) — 예전에는 가짜 기록 보정 +10분이 붙어 준비 25분, 준비 알람이 12:40이었음
    expect(saved.alarms.map((x) => `${x.kind} ${formatTime(x.at)}`)).toEqual([
      'PREPARE 오후 12:50',
      'DEPARTURE 오후 1:05',
      'ARRIVE 오후 1:50',
    ]);
    const c = await getConversation();
    expect(c.cards[0]?.status).toBe('SAVED');
    expect(c.messages[c.messages.length - 1].text).toBe(
      '저장했어요. 내일 오후 12:50 준비, 오후 1:05 출발 알람을 맞춰 둘게요. 오늘 대화는 여기까지 할까요?',
    );
    expect(db.events.map((e) => `${e.label} · ${e.source}`)).toContain('일정 저장 · 스터디 · AI 대화 · 확인함');

    // 이미 확인한 카드는 다시 저장되지 않음 (두 번 누르기 · H05 다시 열기)
    await expect(saveFoundSchedule()).rejects.toThrow('이미 확인한 일정이에요');
    await rejectFoundSchedule();
    expect((await getConversation()).cards[0]?.status).toBe('SAVED');
    expect(foundScheduleDraft()).toBeNull();
  });

  it('대화를 마치면 그날 일기가 생기고, 고친 글은 다시 만들어도 남음', async () => {
    expect(await getJournal('2025-05-22')).toBeNull();
    const { recordDate } = await finishConversation();
    expect(recordDate).toBe('2025-05-22');
    expect(db.journalWritten).toBe(true);

    const j = await getJournal(recordDate!);
    expect(j?.text).toBe('오늘은 기록이 많지 않아 짧게 남겨요. 회의 자료를 챙기느라 샤워 시간을 줄인 게 아쉬웠다고 했어요.');
    // 시나리오 시각이 멈춰 있어 모두 같은 시각 — 기록된 순서, 대화에서 한 말은 맨 뒤
    expect(j?.facts.map((f) => f.label)).toEqual([
      '준비물 저장 · 노트북 충전기',
      '일정 저장 · 스터디',
      '회고 · 회의 자료 때문에 샤워 시간을 줄임',
    ]);
    expect(j?.suggestion.status).toBe('PENDING');
    expect(j?.routineId).toBeNull();

    await editJournal(recordDate!, '고친 일기');
    await finishConversation();
    const again = await getJournal(recordDate!);
    expect(again?.text).toBe('고친 일기');
    expect(again?.edited).toBe(true);
  });

  it('루틴 제안 초안을 저장하면 제안이 수락으로 바뀌고 저장한 루틴을 다시 열 수 있음', async () => {
    const draft = await getRoutine('new', '2025-05-22');
    expect(draft).toMatchObject({ id: null, title: '회의 전날 준비', days: ['수'], sourceJournal: '2025-05-22' });

    const saved = await saveRoutine({ ...draft!, steps: [...draft!.steps, { id: 's4', name: '  ', minutes: 5, alarm: false }] });
    expect(saved.id).toBe('r2');
    expect(saved.steps[3].name).toBe('새 단계'); // 이름을 비우면 새 단계
    expect((await getJournal('2025-05-22'))?.suggestion.status).toBe('APPLIED');
    expect((await getJournal('2025-05-22'))?.routineId).toBe('r2'); // 일기에서 만든 루틴 열기
    expect((await getRoutine('r2'))?.steps).toHaveLength(4);
    expect(await getRoutine('r1')).toBeNull(); // 아침 루틴은 단계 이름만 있어 편집 대상 아님

    await declineRoutineSuggestion('2025-05-22'); // 이미 수락했으면 그대로
    expect((await getJournal('2025-05-22'))?.suggestion.status).toBe('APPLIED');
  });
});
