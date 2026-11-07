// 실시간 음성 대화(Gemini Live) 글을 AI 대화 말풍선으로 — 순수 함수 (화면 · 연결 코드 없음, 시험은 __tests__/liveChat.test.ts)
//   Live는 말을 글로 바꾼 조각(델타)을 차례로 보냄 → 같은 사람의 조각은 차례가 끝날 때까지 한 말풍선에 이어 붙임 (조각마다 새 말풍선 = 중복 표시)
//   차례가 끝나기 전(done false)은 임시 글 — 화면이 흐리게 보임. 상대가 말을 시작하거나 turn(AI 차례 끝) · 연결 끝이면 확정
//   차례가 끝나면(turn · 연결 끝) 그 차례의 내 말 + AI 답을 서버 대화(voice-turn spoken_reply)에 남기고, 남긴 말풍선은 화면에서 내림 — 서버 대화로 다시 보임
//   못 남긴 말풍선(대화가 막힘 · 오류)은 화면에만 남음
import type { ChatMessage } from './types';

// sent = 서버 대화에 넘김(남기는 중 · 못 남김) — 다시 보내지 않음
export type LiveLine = { id: string; who: 'me' | 'ai'; text: string; at: Date; done: boolean; sent?: boolean };

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

// 일정일 수도 있는 말인지 — 날짜 · 시각 · 일정 낱말이 있으면 true. 서버가 추출(T2F)하기 전에 "일정 카드를 생성하고 있어요..."를 먼저 띄울지만 정함
//   자기 전 대화에 흔한 '오늘 · 저녁 · 운동했어 · 만났어'는 넣지 않음 (일반 대화마다 뜨지 않게). 틀려도 괜찮은 어림 — 일정이 아니면 추출 결과가 오는 대로 말풍선을 내리고, 놓친 일정은 추출 뒤 카드 자리의 임시 말풍선으로 보임
const SCHEDULE_HINT =
  /내일|모레|글피|이번\s*주|다음\s*주|주말|[월화수목금토일]요일|\d+\s*(?:시|분|일|월)|(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|열한|열두)\s*시|오전|오후|약속|일정|수업|강의|시험|회의|미팅|발표|면접|예약|알람|깨워|출발|모임|만나기로|만날|산책|병원|마감/u;
export const mightBeSchedule = (text: string): boolean => SCHEDULE_HINT.test(text);

// 아직 서버에 보내지 않은 확정 줄을 한 차례로 — 내 말 · AI 답을 각각 이어 붙임. 보낼 게 없으면 null
export function takeTurn(lines: LiveLine[]): { ids: string[]; me: string; ai: string } | null {
  const fresh = lines.filter((l) => l.done && !l.sent);
  if (fresh.length === 0) return null;
  const join = (who: LiveLine['who']) => fresh.filter((l) => l.who === who).map((l) => l.text.trim()).filter(Boolean).join(' ');
  return { ids: fresh.map((l) => l.id), me: join('me'), ai: join('ai') };
}

// 서버가 찾은 되물을 것(voice-turn ask)을 Live에 넣을 글 — Live 지침의 [APP NOTE] 규칙대로 사용자에게 소리로 한 번 물음 (소리 내 읽지 않음)
export const askPrompt = (items: string[]): string =>
  `[APP NOTE] 사용자가 방금 말한 일정에서 아직 모르는 것: ${items.join(', ')}. 이것만 짧게 한 번 물어봐 줘. 카드나 저장 이야기는 하지 마.`;

// 확정됐지만 아직 서버에 안 넘긴 내 말이 일정일 수도 있는지 — Live 답이 시작돼 내 말이 확정된 순간부터(차례 끝 전) "일정 카드를 생성하고 있어요..."
export const heardSchedule = (lines: LiveLine[]): boolean => lines.some((l) => l.who === 'me' && l.done && !l.sent && mightBeSchedule(l.text));

// 서버 대화 + 음성 말풍선을 시각 순서로 한 목록에. 같은 시각이면 서버 대화 먼저 (정렬은 안정)
//   대화에 이미 들어간 확정 줄(보내는 중 · 처리 도중 화면)은 빼서 두 번 보이지 않게
export function mergeLive(messages: ChatMessage[], lines: LiveLine[]): ChatRow[] {
  const inChat = new Set(messages.map((m) => `${m.who}\n${m.text}`));
  const live: ChatRow[] = lines
    .filter((l) => l.text.trim() && !(l.done && inChat.has(`${l.who}\n${l.text.trim()}`)))
    .map((l) => ({ id: l.id, who: l.who, text: l.text.trim(), at: l.at, interim: !l.done }));
  if (live.length === 0) return messages;
  return [...messages, ...live].sort((a, b) => a.at.getTime() - b.at.getTime());
}

// 맨 아래 근처를 보고 있는지 — 이때만 새 말에 맞춰 자동으로 내림 (위를 읽는 중이면 그대로 둠)
export const NEAR_BOTTOM_PX = 80;
export function isNearBottom(e: { contentOffset: { y: number }; layoutMeasurement: { height: number }; contentSize: { height: number } }): boolean {
  return e.contentOffset.y + e.layoutMeasurement.height >= e.contentSize.height - NEAR_BOTTOM_PX;
}
