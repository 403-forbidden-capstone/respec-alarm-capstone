// 실시간 음성 대화(Gemini Live) 글을 AI 대화 말풍선으로 — 순수 함수 (화면 · 연결 코드 없음, 시험은 __tests__/liveChat.test.ts)
//   Live는 말을 글로 바꾼 조각(델타)을 차례로 보냄 → 같은 사람의 조각은 차례가 끝날 때까지 한 말풍선에 이어 붙임 (조각마다 새 말풍선 = 중복 표시)
//   차례가 끝나기 전(done false)은 임시 글 — 화면이 흐리게 보임. 상대가 말을 시작하거나 turn(AI 차례 끝) · 연결 끝이면 확정
//   이 글은 서버(voice-turn) · DB에 남지 않고 이 화면에만 있음 (DB 스키마는 그대로)
import type { ChatMessage } from './types';

export type LiveLine = { id: string; who: 'me' | 'ai'; text: string; at: Date; done: boolean };

// 말풍선 한 줄 — 서버 대화(ChatMessage)와 같은 모양 + 임시 표시
export type ChatRow = ChatMessage & { interim?: boolean };

// 조각 하나를 더함. 빈 조각으로 새 말풍선을 만들지는 않음
export function addLiveChunk(lines: LiveLine[], who: 'me' | 'ai', text: string, at: Date): LiveLine[] {
  const last = lines[lines.length - 1];
  if (last && last.who === who && !last.done) return [...lines.slice(0, -1), { ...last, text: last.text + text }];
  if (!text.trim()) return lines;
  return [...closeLive(lines), { id: `live-${lines.length}-${at.getTime()}`, who, text, at, done: false }];
}

// 모두 확정 (AI 차례 끝 · 연결 끝)
export function closeLive(lines: LiveLine[]): LiveLine[] {
  return lines.some((l) => !l.done) ? lines.map((l) => (l.done ? l : { ...l, done: true })) : lines;
}

// 서버 대화 + 음성 말풍선을 시각 순서로 한 목록에. 같은 시각이면 서버 대화 먼저 (정렬은 안정)
export function mergeLive(messages: ChatMessage[], lines: LiveLine[]): ChatRow[] {
  const live: ChatRow[] = lines
    .filter((l) => l.text.trim())
    .map((l) => ({ id: l.id, who: l.who, text: l.text.trim(), at: l.at, interim: !l.done }));
  if (live.length === 0) return messages;
  return [...messages, ...live].sort((a, b) => a.at.getTime() - b.at.getTime());
}

// 맨 아래 근처를 보고 있는지 — 이때만 새 말에 맞춰 자동으로 내림 (위를 읽는 중이면 그대로 둠)
export const NEAR_BOTTOM_PX = 80;
export function isNearBottom(e: { contentOffset: { y: number }; layoutMeasurement: { height: number }; contentSize: { height: number } }): boolean {
  return e.contentOffset.y + e.layoutMeasurement.height >= e.contentSize.height - NEAR_BOTTOM_PX;
}
