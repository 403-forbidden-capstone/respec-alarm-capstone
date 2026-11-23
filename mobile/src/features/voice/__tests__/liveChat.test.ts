import { describe, expect, it } from '@jest/globals';

import { addLiveChunk, askPrompt, closeLive, heardSchedule, isNearBottom, mergeLive, mightBeSchedule, takeTurn, type LiveLine } from '../liveChat';
import type { ChatMessage } from '../types';

const t = (min: number) => new Date(2026, 10, 6, 21, min);

describe('liveChat', () => {
  it('같은 사람의 조각은 한 말풍선에 이어 붙임 (조각마다 새 말풍선 아님)', () => {
    let lines: LiveLine[] = [];
    lines = addLiveChunk(lines, 'me', '내일 ', t(0));
    lines = addLiveChunk(lines, 'me', '산책해', t(1));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ who: 'me', text: '내일 산책해', at: t(0), done: false });
  });

  it('상대가 말을 시작하면 앞 말풍선은 확정, AI 차례 끝(closeLive)이면 모두 확정', () => {
    let lines = addLiveChunk([], 'me', '안녕', t(0));
    lines = addLiveChunk(lines, 'ai', '안녕하세요', t(1));
    expect(lines.map((l) => l.done)).toEqual([true, false]);
    lines = closeLive(lines);
    expect(lines.every((l) => l.done)).toBe(true);
    // 확정 뒤 같은 사람이 다시 말하면 새 말풍선
    lines = addLiveChunk(lines, 'ai', '또', t(2));
    expect(lines).toHaveLength(3);
    expect(new Set(lines.map((l) => l.id)).size).toBe(3);
  });

  it('빈 조각으로는 말풍선을 만들지 않음', () => {
    expect(addLiveChunk([], 'ai', '  ', t(0))).toEqual([]);
  });

  it('서버 대화와 시각 순서로 합치고, 임시 글은 interim', () => {
    const messages: ChatMessage[] = [
      { id: 'a', who: 'ai', text: '오늘 어땠어요?', at: t(0) },
      { id: 'b', who: 'me', text: '좋았어', at: t(5) },
    ];
    const lines = addLiveChunk(closeLive(addLiveChunk([], 'me', ' 내일 산책 ', t(3))), 'ai', '좋아요', t(6));
    const rows = mergeLive(messages, lines);
    expect(rows.map((r) => r.text)).toEqual(['오늘 어땠어요?', '내일 산책', '좋았어', '좋아요']);
    expect(rows.map((r) => r.interim ?? false)).toEqual([false, false, false, true]);
    expect(mergeLive(messages, [])).toBe(messages);
  });

  it('맨 아래 근처일 때만 자동 스크롤', () => {
    const at = (y: number) => ({ contentOffset: { y }, layoutMeasurement: { height: 500 }, contentSize: { height: 1000 } });
    expect(isNearBottom(at(500))).toBe(true);
    expect(isNearBottom(at(430))).toBe(true);
    expect(isNearBottom(at(200))).toBe(false);
  });

  it('takeTurn: 확정된 새 줄만 한 차례로 — 내 말 · AI 답을 각각 이어 붙이고, 넘긴 줄 · 임시 줄은 뺌', () => {
    let lines: LiveLine[] = [];
    lines = addLiveChunk(lines, 'me', '내일 9시', t(0));
    lines = addLiveChunk(lines, 'ai', '네, ', t(1));
    lines = addLiveChunk(lines, 'ai', '수업이군요', t(1));
    expect(takeTurn(lines)).toMatchObject({ me: '내일 9시', ai: '' }); // AI 줄은 아직 임시
    lines = closeLive(lines);
    const turn = takeTurn(lines);
    expect(turn).toEqual({ ids: lines.map((l) => l.id), me: '내일 9시', ai: '네, 수업이군요' });
    expect(takeTurn(lines.map((l) => ({ ...l, sent: true })))).toBeNull(); // 넘긴 줄은 다시 안 보냄
  });

  it('mergeLive: 이미 대화에 들어간 확정 음성 줄은 빼서 두 번 안 보임 (임시 줄은 그대로)', () => {
    const msgs: ChatMessage[] = [{ id: 'm1', who: 'me', text: '내일 9시 수업', at: t(0) }];
    const lines: LiveLine[] = [
      { id: 'l1', who: 'me', text: '내일 9시 수업 ', at: t(0), done: true },
      { id: 'l2', who: 'ai', text: '네', at: t(1), done: false },
    ];
    expect(mergeLive(msgs, lines).map((r) => r.id)).toEqual(['m1', 'l2']);
  });

  it('mightBeSchedule: 날짜 · 시각 · 일정 낱말이 있으면 일정일 수도 있는 말 (일반 대화는 아님)', () => {
    for (const t of ['내일 2시에 초롱이랑 산책 있어.', '모레 오전 9시 수업', '금요일에 발표해', '다음 주 약속 잡혔어', '세 시에 만나기로 했어', '10월 3일 병원', '장소는 세종대학교야'])
      expect(mightBeSchedule(t)).toBe(true);
    for (const t of ['안녕', '오늘 좀 피곤했어', '저녁에 친구 만났어', '운동하고 왔어', '고마워 잘 자']) expect(mightBeSchedule(t)).toBe(false);
  });

  it('heardSchedule: Live 답이 시작돼 내 말이 확정되면(차례 끝 전) 바로 — 일정일 수도 있는 말만, 넘긴 줄은 아님', () => {
    let lines: LiveLine[] = addLiveChunk([], 'me', '초롱이랑 2시에 산책 약속 있어', t(0));
    expect(heardSchedule(lines)).toBe(false); // 아직 듣는 중
    lines = addLiveChunk(lines, 'ai', '산책', t(1)); // Live 답 시작 → 내 말 확정
    expect(heardSchedule(lines)).toBe(true);
    expect(heardSchedule(lines.map((l) => ({ ...l, sent: true })))).toBe(false); // 넘긴 뒤는 보내는 쪽(drafting)이 이어받음
    expect(heardSchedule(addLiveChunk(addLiveChunk([], 'me', '오늘 좀 피곤했어', t(0)), 'ai', '네', t(1)))).toBe(false); // 일반 대화
  });

  it('askPrompt: 서버가 찾은 되물을 것을 [APP NOTE]로 — Live 지침이 사용자 말이 아닌 앱 메모로 알아봄', () => {
    const p = askPrompt(["'산책'의 정확한 날짜", '장소']);
    expect(p.startsWith('[APP NOTE]')).toBe(true);
    expect(p).toContain("'산책'의 정확한 날짜, 장소");
  });
});
