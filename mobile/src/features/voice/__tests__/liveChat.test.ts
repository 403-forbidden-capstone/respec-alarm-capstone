import { describe, expect, it } from '@jest/globals';

import { addLiveChunk, closeLive, isNearBottom, mergeLive, type LiveLine } from '../liveChat';
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
});
