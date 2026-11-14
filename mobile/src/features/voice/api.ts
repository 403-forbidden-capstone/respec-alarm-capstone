// ③ 수면 전후 음성 AI — 데이터 접근은 이 파일에서만 합니다.
// 가짜 데이터 모드는 src/mocks의 대본(mocks/ai.ts)대로 흘러가고, 실데이터 모드면 함수 맨 앞에서 real.ts(서버 함수 voice-session · voice-turn)로 넘김 (docs/screen-data-map.md "실데이터 연결 규칙")
//   읽기 · 쓰기 위치는 docs/screen-data-map.md (A02 AI 대화 · A03 하루 기록)
// 실데이터 대화는 텍스트만 (설계: L4_자기전_설계메모.md) — 마이크 · 음성 합성 없음. 하루 기록(일기)은 아직 AI 대기
import { createAppointment, draftAt, estimateAppointment } from '@/features/alarm/api';
import type { AppointmentDraft, Estimate, SavedAppointment } from '@/features/alarm/types';
import { now } from '@/lib/clock';
import { callEdge } from '@/lib/edge';
import { dateParts, dayKey } from '@/lib/format';
import { isMock } from '@/lib/mode';
import {
  aiDb,
  aiTurn,
  FOUND_DRAFT,
  FOUND_QUESTION,
  nextLine,
  rejectedReply,
  resolveFound,
  savedReply,
  startChat,
  userTurn,
  writeJournal,
  type MockChat,
} from '@/mocks/ai';
import { db, kst, TODAY } from '@/mocks/data';
import { UserError } from '@/lib/errors';

import * as real from './real';
import type { ChatMessage, Conversation, ConversationCard } from './types';

// AI 탭을 처음 열면 대화가 시작됨 (conversation_sessions 한 줄, session_type = BEFORE_SLEEP)
function chat(): MockChat {
  aiDb.chat ??= startChat(now());
  return aiDb.chat;
}

// 목업의 찾은 일정 카드 한 장 — 상태는 PENDING = 준비(READY) · APPLIED = 저장 · REJECTED = 저장 안 함
const MOCK_CARD_ID = 'c1';
const MOCK_STATUS = { PENDING: 'READY', APPLIED: 'SAVED', REJECTED: 'REJECTED' } as const;

function cardsOf(c: MockChat): ConversationCard[] {
  if (!c.found) return [];
  return [
    {
      id: MOCK_CARD_ID,
      kind: 'APPT_NEW',
      status: MOCK_STATUS[c.found],
      firstOfDay: true,
      highlight: false,
      summary: '',
      title: FOUND_DRAFT.title,
      at: draftAt(FOUND_DRAFT.date, FOUND_DRAFT.time), // H05 계산과 같은 함수 (틀린 시간은 14:00)
      place: FOUND_DRAFT.place,
      importance: FOUND_DRAFT.importance,
      items: FOUND_DRAFT.items
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      alarms: [],
      question: FOUND_QUESTION,
      error: null,
      appointmentId: null,
    },
  ];
}

function toConversation(c: MockChat): Conversation {
  const line = nextLine(c);
  return {
    source: 'MOCK',
    messages: c.messages.map((m, i): ChatMessage => ({ id: `m${i}`, ...m, ...(m.who === 'card' ? { cardId: MOCK_CARD_ID } : {}) })),
    next: !line ? null : line.who === 'me' ? { who: 'me', text: line.text } : { who: 'ai' },
    cards: cardsOf(c),
    limits: null,
    unavailable: null,
  };
}

// A02 대화 — 지금까지 주고받은 말 · 다음 차례 · 찾은 카드들 (실데이터는 서버 대화 — 오늘 안 끝난 세션이 있으면 이어서)
export async function getConversation(): Promise<Conversation> {
  if (!isMock()) return real.getConversation();
  return toConversation(chat());
}

// 개발용: PC 토큰 서버(tools/live-token-server.ts) 주소 — 운영 voice-live-token 배포 전 로컬에서 Live만 시험. 출시 빌드(__DEV__ false)는 무시
const LOCAL_LIVE_TOKEN_URL = __DEV__ ? process.env.EXPO_PUBLIC_LIVE_TOKEN_URL : undefined;

// 실시간 음성 대화(Gemini Live) 1회용 토큰 — 서버(voice-live-token)가 GEMINI_API_KEY로 만들어 줌. 키는 앱에 오지 않음
export async function getLiveToken(): Promise<{ token: string; model: string }> {
  if (isMock()) throw new UserError('실시간 음성 대화는 실데이터 모드에서만 쓸 수 있어요');
  if (LOCAL_LIVE_TOKEN_URL) {
    const res = await fetch(LOCAL_LIVE_TOKEN_URL, { method: 'POST' }).catch(() => null);
    if (!res?.ok) throw new UserError('로컬 음성 토큰 서버에 연결하지 못했어요. tools/live-token-server.ts가 켜져 있는지 확인해 주세요');
    return (await res.json()) as { token: string; model: string };
  }
  const sessionId = await real.beginLive(); // 기준일이 바뀌었으면 새 방으로 옮긴 뒤, 통화가 끝날 때까지 그 방을 붙잡음
  return callEdge<{ token: string; model: string }>('voice-live-token', sessionId ? { session_id: sessionId } : undefined);
}

// Live 통화가 끝남 — 붙잡은 대화방을 놓음 (새벽 4시가 지났으면 다음 읽기부터 새 기준일 방)
export async function endLiveVoice(): Promise<void> {
  if (!isMock()) await real.endLive();
}

// 실시간 음성 한 차례(내 말 + Live 답)를 같은 대화에 남김 — 일정이면 글과 같은 카드 흐름. 목업은 음성이 없어 남기지 않음
export async function sayVoice(heard: string, spoken: string, onProgress?: (c: Conversation) => void): Promise<real.VoiceKept> {
  if (isMock()) return { kept: false };
  return real.sayVoice(heard, spoken, onProgress);
}

// 목업만: AI가 정리하는 척 기다리는 시간 (목업 userSay → aiTurn 0.8초). 실데이터는 Gemini Live 답을 기다림. 테스트는 0
export const mockTiming = { replyMs: 800 };
const pause = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

// 내 차례에 말하고 AI 답까지 받아 같이 돌려줌 — text가 없거나 비면 대본 문장 (말하기 버튼). 내 차례가 아니면 그대로
// 실데이터는 글을 voice-turn으로 보내고 AI 답(카드 계산이 있으면 앱 일을 한 뒤 마지막 답)까지 받음. 서버가 답하지 못하면 던지지 않고 Conversation.unavailable
export async function say(text?: string, onProgress?: (c: Conversation) => void): Promise<Conversation> {
  if (!isMock()) return real.say(text, onProgress); // onProgress — 처리 도중의 대화 (카드 계산 중 · 끝). 목업은 한 번에 끝나서 안 부름
  const c = chat();
  if (!userTurn(c, now(), text)) return toConversation(c);
  await pause(mockTiming.replyMs);
  aiReply(c);
  return toConversation(c);
}

// AI 차례 — 대본의 다음 말. 일정을 찾으면 카드를 띄우고 준비물은 바로 준비물 목록에 넣음
function aiReply(c: MockChat) {
  if (aiTurn(c, now()) === 'card') {
    const found = cardsOf(c)[0];
    const day = found?.at ? dateParts(found.at).day : TODAY + 1;
    for (const title of found?.items ?? []) {
      if (db.todos.some((t) => t.title === title && t.day === day)) continue;
      db.todos.push({ id: `t${db.todos.length + 1}`, title, day, done: false });
      db.events.push({ at: now(), label: `준비물 저장 · ${title}`, source: 'AI 대화' });
    }
  }
}

// 찾은 일정의 새 일정 입력값 — "수정"으로 H05를 열 때 채움 (카드가 아직 안 나왔으면 null)
export function foundScheduleDraft(): AppointmentDraft | null {
  if (!isMock()) return null; // 실데이터 카드는 [수정] 없이 말로 고침 (카드 값을 H05로 넘기는 길은 아직 없음)
  return aiDb.chat?.found === 'PENDING' ? { ...FOUND_DRAFT } : null;
}

// 찾은 일정 저장 — estimate가 있으면 H05에서 고친 값. 알람을 맞추고 AI가 한마디 덧붙임
// 실데이터는 Edge가 appointments · 알람을 저장하고 apply_status = APPLIED
export async function saveFoundSchedule(estimate?: Estimate): Promise<SavedAppointment> {
  // 이미 저장 · 저장 안 함을 고른 카드면 막음 — 두 번 누르거나 H05를 다시 열어도 일정이 두 벌 생기지 않게
  if (aiDb.chat?.found !== 'PENDING') throw new UserError('이미 확인한 일정이에요');
  const e = estimate ?? (await estimateAppointment(FOUND_DRAFT));
  const saved = await createAppointment(e, estimate ? 'AI 대화 · 수정함' : 'AI 대화 · 확인함');
  // H05 "수정"에서 알람 종류를 일부만 켰으면 켠 것만 말하고, 모두 껐으면 알람 없이 저장했다고 답함 (D46)
  resolveFound(chat(), 'APPLIED', savedReply(saved.at, saved.alarms), now());
  return saved;
}

// 찾은 일정 저장 안 함 (apply_status = REJECTED)
export async function rejectFoundSchedule() {
  if (aiDb.chat?.found !== 'PENDING') return;
  resolveFound(chat(), 'REJECTED', rejectedReply(FOUND_DRAFT.title), now());
}

// 카드 [저장] · [바꾸기] — 돌려주는 글은 토스트. 목업은 찾은 일정 하나(saveFoundSchedule), 실데이터는 카드 종류대로 L1 함수로 저장한 뒤 서버에 알림
export async function saveCard(cardId: string): Promise<string> {
  if (!isMock()) return real.saveCard(cardId);
  const saved = await saveFoundSchedule();
  return `${saved.title} 알람을 맞췄어요`;
}

// 카드 [저장 안 함]
export async function rejectCard(cardId: string): Promise<void> {
  if (!isMock()) return real.rejectCard(cardId);
  await rejectFoundSchedule();
}

// 카드 [장소 고르기]로 고른 곳으로 다시 계산 — 실데이터만 (목업 카드는 장소가 늘 있음)
export async function pickCardPlace(cardId: string, place: { name: string; lat?: number; lng?: number }, onProgress?: (c: Conversation) => void): Promise<'READY' | 'NEEDS_PLACE' | 'FAILED'> {
  if (!isMock()) return real.pickCardPlace(cardId, place, onProgress);
  return 'READY';
}

// [다시 시도] — 서버가 답하지 못했을 때 같은 요청을 다시 (목업은 늘 답함)
export async function retryConversation(): Promise<Conversation> {
  if (!isMock()) return real.retry();
  return toConversation(chat());
}

// 대화 끝 — 목업: 기록된 사실과 대화로 그날 일기를 만들고(다시 누르면 다시 만듦) 일기 날짜를 돌려줌
// 목업은 하루(5월 22일)만 있어서 일기 날짜는 시나리오의 오늘.
// 실데이터: 지금 세션을 끝남으로 로컬에 적고 대화 끝 정리(서버 voice-commit — 할 일 · 준비물 · 생활 기록 · 그날 일기)를 보냄, recordDate null — 다음 [대화 시작]은 새 세션. 일기는 서버가 만든 뒤 기록 탭 · A03이 읽음
export async function finishConversation(): Promise<{ recordDate: string | null }> {
  if (!isMock()) return real.finishConversation();
  const c = chat();
  const date = kst(TODAY, 0);
  const recordDate = dayKey(date);
  const a1 = db.appointments.find((a) => a.id === 'a1'); // 그날 아침 약속 (records/api.ts와 같음)
  aiDb.journals[recordDate] = writeJournal({
    date,
    me: db.me,
    appointment: a1 ? { title: a1.title, place: a1.place, at: a1.at } : null,
    events: db.events,
    saidAt: c.messages.find((m) => m.who === 'me')?.at ?? null,
    prev: aiDb.journals[recordDate] ?? null,
  });
  db.journalWritten = true;
  db.events.push({ at: now(), label: 'AI 대화 종료', source: 'AI' });
  return { recordDate };
}
