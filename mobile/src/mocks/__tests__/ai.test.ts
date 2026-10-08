import { describe, expect, it } from '@jest/globals';

import { formatTime } from '@/lib/format';

import {
  aiTurn,
  nextLine,
  rejectedReply,
  resolveFound,
  savedReply,
  SCRIPT,
  startChat,
  userTurn,
  writeJournal,
  type JournalInput,
} from '../ai';
import { kst, TODAY } from '../data';

const at = kst(TODAY, 1350); // 밤 10:30

// 목업 SCRIPT · userSay · aiTurn · chatResolve와 같은 순서로 흐르는지
describe('AI 대화 대본', () => {
  it('AI 첫 말 → 내 말 → AI 답 → 내 말 → 찾은 일정 카드 → 끝', () => {
    const chat = startChat(at);
    expect(chat.messages.map((m) => m.who)).toEqual(['ai']);
    expect(nextLine(chat)?.who).toBe('me');

    expect(aiTurn(chat, at)).toBeNull(); // 내 차례에는 AI가 답하지 않음
    expect(userTurn(chat, at)).toBe(true);
    expect(userTurn(chat, at)).toBe(false); // AI 차례에는 내 말이 안 들어감
    expect(aiTurn(chat, at)).toBe('ai');
    expect(userTurn(chat, at)).toBe(true);
    expect(chat.found).toBeNull();
    expect(aiTurn(chat, at)).toBe('card');
    expect(chat.found).toBe('PENDING');

    expect(nextLine(chat)).toBeNull();
    expect(chat.messages.map((m) => m.who)).toEqual(['ai', 'me', 'ai', 'me', 'card']);
    expect(chat.messages.length).toBe(SCRIPT.length);
  });

  it('글로 고쳐 보내면 그 글, 비어 있으면 대본 문장', () => {
    const edited = startChat(at);
    userTurn(edited, at, '  샤워를 못 했어요  ');
    expect(edited.messages[1].text).toBe('샤워를 못 했어요');

    const blank = startChat(at);
    userTurn(blank, at, '   ');
    expect(blank.messages[1].text).toBe('맞아요. 회의 자료를 챙기느라 샤워 시간을 줄였어요.');
  });

  it('찾은 일정은 한 번만 저장 · 저장 안 함, AI가 한마디 덧붙임', () => {
    const chat = startChat(at);
    userTurn(chat, at);
    aiTurn(chat, at);
    userTurn(chat, at);
    expect(resolveFound(chat, 'APPLIED', '저장', at)).toBe(false); // 카드 전
    aiTurn(chat, at);
    expect(resolveFound(chat, 'REJECTED', rejectedReply('스터디'), at)).toBe(true);
    expect(resolveFound(chat, 'APPLIED', '저장', at)).toBe(false); // 이미 고름
    expect(chat.found).toBe('REJECTED');
    expect(chat.messages[chat.messages.length - 1].text).toBe('알겠어요. 스터디는 저장하지 않았어요. 오늘 대화는 여기까지 할까요?');
  });

  it('저장 답은 준비 · 출발 알람 시각, 내일이면 "내일"', () => {
    const study = kst(TODAY + 1, 840);
    expect(savedReply(study, kst(TODAY + 1, 735), kst(TODAY + 1, 780))).toBe(
      '저장했어요. 내일 오후 12:15 준비, 오후 1:00 출발 알람을 맞춰 둘게요. 오늘 대화는 여기까지 할까요?',
    );
    expect(savedReply(kst(TODAY + 2, 840), kst(TODAY + 2, 735), kst(TODAY + 2, 780))).toMatch(/^저장했어요\. 5월 24일 /);
  });
});

// 목업 genJournal과 같은 문장 · 사실이 나오는지
describe('하루 기록 · 일기', () => {
  const date = kst(TODAY, 0);
  const meeting = { title: '팀 주간회의', place: '세종대학교', at: kst(TODAY, 600) };
  const none = { wakeAt: null, departAt: null, arriveAt: null };
  const input = (over: Partial<JournalInput>): JournalInput => ({
    date,
    me: none,
    appointment: meeting,
    events: [],
    saidAt: null,
    prev: null,
    ...over,
  });

  it('기록도 대화도 없으면 짧은 안내', () => {
    const j = writeJournal(input({}));
    expect(j.text).toBe('오늘은 남은 기록이 많지 않아 짧게 적어요. 내일은 기상 확인부터 남겨 봐요.');
    expect(j.facts).toEqual([]);
    expect(j.encouragement).toBe('내일은 조금 더 여유 있게 시작해 봐요.');
    expect(j.suggestion).toBe('PENDING');
  });

  it('미루기 · 기상 · 출발 · 도착 · 대화를 이어 씀, 늦지 않았으면 격려', () => {
    const j = writeJournal(
      input({
        me: { wakeAt: kst(TODAY, 490), departAt: kst(TODAY, 543), arriveAt: kst(TODAY, 590) },
        events: [
          { at: kst(TODAY, 480), label: '기상 알람 울림', source: '자동' },
          { at: kst(TODAY, 480), label: '기상 알람 5분 미루기', source: '자동' },
          { at: kst(TODAY, 490), label: '기상 확인', source: '자동 판정' },
          { at: kst(TODAY, 543), label: '집 출발', source: '자동 · 지오펜스' },
          { at: kst(TODAY, 590), label: '도착 · 지각 아님', source: '자동 · 지오펜스' },
        ],
        saidAt: kst(TODAY, 1345),
      }),
    );
    expect(j.text).toBe(
      '알람을 1번 미룬 뒤 오전 8:10에 일어났어요. 오전 9:03에 집을 나서 오전 9:50에 세종대학교에 도착했고, 팀 주간회의에 늦지 않았어요. 회의 자료를 챙기느라 샤워 시간을 줄인 게 아쉬웠다고 했어요.',
    );
    // 알람 울림은 빼고 시각 순, 대화에서 한 말은 AI 대화 출처로
    expect(j.facts.map((f) => `${formatTime(f.at)} ${f.label} · ${f.source}`)).toEqual([
      '오전 8:00 기상 알람 5분 미루기 · 자동',
      '오전 8:10 기상 확인 · 자동 판정',
      '오전 9:03 집 출발 · 자동 · 지오펜스',
      '오전 9:50 도착 · 지각 아님 · 자동 · 지오펜스',
      '오후 10:25 회고 · 회의 자료 때문에 샤워 시간을 줄임 · AI 대화',
    ]);
    expect(j.encouragement).toBe('오늘도 약속 시간 안에 도착했어요. 이 흐름을 이어가요.');
  });

  it('늦게 도착하면 지각 분, 기상 · 도착 없이 대화만 있으면 짧게 남긴다고 먼저 말함', () => {
    const late = writeJournal(input({ me: { wakeAt: null, departAt: kst(TODAY, 560), arriveAt: kst(TODAY, 607) } }));
    expect(late.text).toBe('오전 9:20에 집을 나서 오전 10:07에 세종대학교에 도착했고, 팀 주간회의에 7분 늦었어요.');
    expect(late.encouragement).toBe('내일은 조금 더 여유 있게 시작해 봐요.');

    const talkOnly = writeJournal(input({ saidAt: at }));
    expect(talkOnly.text).toBe('오늘은 기록이 많지 않아 짧게 남겨요. 회의 자료를 챙기느라 샤워 시간을 줄인 게 아쉬웠다고 했어요.');
  });

  it('다시 만들 때 고친 글 · 루틴 제안 응답은 그대로', () => {
    const first = writeJournal(input({}));
    const prev = { ...first, text: '내가 고친 일기', edited: true, suggestion: 'REJECTED' as const };
    const again = writeJournal(input({ me: { ...none, wakeAt: kst(TODAY, 490) }, prev }));
    expect(again.aiText).toBe('오전 8:10에 일어났어요.');
    expect(again.text).toBe('내가 고친 일기');
    expect(again.edited).toBe(true);
    expect(again.suggestion).toBe('REJECTED');

    const notEdited = writeJournal(input({ me: { ...none, wakeAt: kst(TODAY, 490) }, prev: first }));
    expect(notEdited.text).toBe('오전 8:10에 일어났어요.');
  });
});
