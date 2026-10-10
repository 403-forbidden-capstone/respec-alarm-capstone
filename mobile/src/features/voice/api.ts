// ③ 수면 전후 음성 AI — 데이터 접근은 이 파일에서만 합니다.
// 지금은 src/mocks의 가짜 데이터를 돌려주고, Supabase가 붙으면 이 파일 안에서만 바꿉니다.
//   읽기 · 쓰기 위치는 docs/screen-data-map.md (A02 AI 대화 · A03 하루 기록)
// AI 대기 — 대화는 목업 대본(mocks/ai.ts)대로 흘러감. 마이크 · 음성 합성 · 서버 호출 없음 (실제는 voice-* Edge + Gemini, #42 · D7)
import { createAppointment, draftAt, estimateAppointment } from '@/features/alarm/api';
import type { Appointment, AppointmentDraft, Estimate } from '@/features/alarm/types';
import { now } from '@/lib/clock';
import { dateParts, dayKey } from '@/lib/format';
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

import type { Conversation, FoundSchedule } from './types';

// AI 탭을 처음 열면 대화가 시작됨 (conversation_sessions 한 줄, session_type = BEFORE_SLEEP)
function chat(): MockChat {
  aiDb.chat ??= startChat(now());
  return aiDb.chat;
}

function foundOf(c: MockChat): FoundSchedule | null {
  if (!c.found) return null;
  return {
    title: FOUND_DRAFT.title,
    at: draftAt(FOUND_DRAFT.date, FOUND_DRAFT.time), // H05 계산과 같은 함수 (틀린 시간은 14:00)
    place: FOUND_DRAFT.place,
    importance: FOUND_DRAFT.importance,
    items: FOUND_DRAFT.items
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    question: FOUND_QUESTION,
    status: c.found,
  };
}

function toConversation(c: MockChat): Conversation {
  const line = nextLine(c);
  return {
    messages: c.messages.map((m, i) => ({ id: `m${i}`, ...m })),
    next: !line ? null : line.who === 'me' ? { who: 'me', text: line.text } : { who: 'ai' },
    found: foundOf(c),
  };
}

// A02 대화 — 지금까지 주고받은 말 · 다음 차례 · 찾은 일정
export async function getConversation(): Promise<Conversation> {
  return toConversation(chat());
}

// 목업만: AI가 정리하는 척 기다리는 시간 (목업 userSay → aiTurn 0.8초). 실데이터는 Edge 응답을 기다림. 테스트는 0
export const mockTiming = { replyMs: 800 };
const pause = (ms: number) => (ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

// 내 차례에 말하고 AI 답까지 받아 같이 돌려줌 — text가 없거나 비면 대본 문장 (말하기 버튼). 내 차례가 아니면 그대로
// 실데이터(D7 A안 1턴)는 녹음 → voice-* Edge → Gemini가 내 말 · AI 답을 한 번에 주므로, 붙일 때 이 함수 안만 바뀜
export async function say(text?: string): Promise<Conversation> {
  const c = chat();
  if (!userTurn(c, now(), text)) return toConversation(c);
  await pause(mockTiming.replyMs);
  aiReply(c);
  return toConversation(c);
}

// AI 차례 — 대본의 다음 말. 일정을 찾으면 카드를 띄우고 준비물은 바로 준비물 목록에 넣음
function aiReply(c: MockChat) {
  if (aiTurn(c, now()) === 'card') {
    const found = foundOf(c);
    const day = found ? dateParts(found.at).day : TODAY + 1;
    for (const title of found?.items ?? []) {
      if (db.todos.some((t) => t.title === title && t.day === day)) continue;
      db.todos.push({ id: `t${db.todos.length + 1}`, title, day, done: false });
      db.events.push({ at: now(), label: `준비물 저장 · ${title}`, source: 'AI 대화' });
    }
  }
}

// 찾은 일정의 새 일정 입력값 — "수정"으로 H05를 열 때 채움 (카드가 아직 안 나왔으면 null)
export function foundScheduleDraft(): AppointmentDraft | null {
  return aiDb.chat?.found === 'PENDING' ? { ...FOUND_DRAFT } : null;
}

// 찾은 일정 저장 — estimate가 있으면 H05에서 고친 값. 알람을 맞추고 AI가 한마디 덧붙임
// 실데이터는 Edge가 appointments · 알람을 저장하고 apply_status = APPLIED
export async function saveFoundSchedule(estimate?: Estimate): Promise<Appointment> {
  // 이미 저장 · 저장 안 함을 고른 카드면 막음 — 두 번 누르거나 H05를 다시 열어도 일정이 두 벌 생기지 않게
  if (aiDb.chat?.found !== 'PENDING') throw new UserError('이미 확인한 일정이에요');
  const e = estimate ?? (await estimateAppointment(FOUND_DRAFT));
  const saved = await createAppointment(e, estimate ? 'AI 대화 · 수정함' : 'AI 대화 · 확인함');
  const prepare = saved.alarms.find((x) => x.kind === 'PREPARE') ?? saved.alarms[0];
  const depart = saved.alarms.find((x) => x.kind === 'DEPARTURE') ?? prepare;
  resolveFound(chat(), 'APPLIED', savedReply(saved.at, prepare.at, depart.at), now());
  return saved;
}

// 찾은 일정 저장 안 함 (apply_status = REJECTED)
export async function rejectFoundSchedule() {
  if (aiDb.chat?.found !== 'PENDING') return;
  resolveFound(chat(), 'REJECTED', rejectedReply(FOUND_DRAFT.title), now());
}

// 대화 끝 — 기록된 사실과 대화로 그날 일기를 만들고(다시 누르면 다시 만듦) 일기 날짜를 돌려줌
// 목업은 하루(5월 22일)만 있어서 일기 날짜는 시나리오의 오늘. 실데이터는 journal-* Edge
export async function finishConversation(): Promise<{ recordDate: string }> {
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
