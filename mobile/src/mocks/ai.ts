// ③ · ⑥ 목업 — 자기 전 AI 대화 대본 · 하루 기록(일기) · 루틴 제안 (AI 대기)
// mockup.html의 SCRIPT · cardMsg · chatResolve · genJournal · rAccept를 옮김. 실제는 Gemini (voice-* · journal-* Edge, #42 · #48)
// 화면은 이 파일을 직접 읽지 않고 features/voice/api.ts · features/routine/api.ts를 거침. 바꾼 값은 앱을 다시 열 때까지만 남음
import type { AppointmentDraft } from '@/features/alarm/types';
import type { ApplyStatus, JournalFact, Routine } from '@/features/routine/types';
import { dateParts, formatTime, isSameDay, josa, minutesBetween } from '@/lib/format';

import { kst, TODAY } from './data';

type ScriptLine = { who: 'ai' | 'me'; text: string } | { who: 'card' };

// 자기 전 대화 대본 — 내 차례에 말하기를 누르면 이 문장을 말한 것으로 침, card = 찾은 일정 카드
export const SCRIPT: readonly ScriptLine[] = [
  { who: 'ai', text: '오늘 아침 준비는 어땠나요? 평소보다 조금 서두른 것 같아요.' },
  { who: 'me', text: '맞아요. 회의 자료를 챙기느라 샤워 시간을 줄였어요.' },
  {
    who: 'ai',
    text: '이번 주에만 세 번째로 아침이 바빴어요. 회의 전날 밤에 미리 챙기는 루틴을 일기와 함께 제안해 드릴게요. 내일 일정도 있나요?',
  },
  { who: 'me', text: '내일 오후 2시에 학교 도서관에서 스터디 있어요. 노트북 충전기도 챙겨야 해요.' },
  { who: 'card' },
];

// 대본 마지막 말에서 찾은 일정 (cardMsg · chatDraft) — 새 일정(H05) 입력값 모양 그대로
export const FOUND_DRAFT: AppointmentDraft = {
  title: '스터디',
  date: kst(TODAY + 1, 0),
  time: '14:00',
  repeat: [],
  place: '학교 도서관',
  transport: 'TRANSIT',
  importance: 'LOW',
  items: '노트북 충전기',
};
export const FOUND_QUESTION = '내일 오후 2시 스터디로 저장할까요?';

export type MockMessage = { who: 'ai' | 'me' | 'card'; text: string; at: Date };
export type MockChat = {
  messages: MockMessage[];
  step: number; // 다음 대본 줄
  found: ApplyStatus | null; // 찾은 일정 카드 — 아직 안 나왔으면 null
};

const lineText = (line: ScriptLine) => ('text' in line ? line.text : '');

// 대화 시작 — AI가 첫 말을 건넴
export function startChat(at: Date): MockChat {
  return { messages: [{ who: 'ai', text: lineText(SCRIPT[0]), at }], step: 1, found: null };
}

// 다음 차례의 대본 줄 — 대본이 끝났으면 null
export function nextLine(chat: MockChat): ScriptLine | null {
  return SCRIPT[chat.step] ?? null;
}

// 내 차례 — 글로 고쳐 보냈으면 그 글, 비어 있으면 대본 문장. 내 차례가 아니면 false
export function userTurn(chat: MockChat, at: Date, text?: string): boolean {
  const line = nextLine(chat);
  if (line?.who !== 'me') return false;
  chat.messages.push({ who: 'me', text: text?.trim() || line.text, at });
  chat.step++;
  return true;
}

// AI 차례 — 대본의 AI 말, 또는 찾은 일정 카드(저장 대기). AI 차례가 아니면 null
export function aiTurn(chat: MockChat, at: Date): 'ai' | 'card' | null {
  const line = nextLine(chat);
  if (!line || line.who === 'me') return null;
  if (line.who === 'card') {
    chat.found = 'PENDING';
    chat.messages.push({ who: 'card', text: '', at });
  } else {
    chat.messages.push({ who: 'ai', text: line.text, at });
  }
  chat.step++;
  return line.who;
}

// 찾은 일정 저장 · 저장 안 함 — 카드가 기다릴 때만, AI가 한마디 덧붙임 (chatResolve)
export function resolveFound(chat: MockChat, status: 'APPLIED' | 'REJECTED', reply: string, at: Date): boolean {
  if (chat.found !== 'PENDING') return false;
  chat.found = status;
  chat.messages.push({ who: 'ai', text: reply, at });
  return true;
}

// 시나리오의 오늘 기준 오늘 · 내일, 그 밖은 날짜 (목업은 늘 '내일' — 찾은 일정을 H05에서 다른 날로 고쳤을 때만 다름)
export function dayWord(at: Date) {
  if (isSameDay(at, kst(TODAY, 0))) return '오늘';
  if (isSameDay(at, kst(TODAY + 1, 0))) return '내일';
  const { month, day } = dateParts(at);
  return `${month}월 ${day}일`;
}

// 저장했을 때 AI 답 — 준비(없으면 첫 알람) · 출발 알람 시각
export function savedReply(at: Date, prepare: Date, depart: Date) {
  return `저장했어요. ${dayWord(at)} ${formatTime(prepare)} 준비, ${formatTime(depart)} 출발 알람을 맞춰 둘게요. 오늘 대화는 여기까지 할까요?`;
}

export function rejectedReply(title: string) {
  return `알겠어요. ${josa(title, '은', '는')} 저장하지 않았어요. 오늘 대화는 여기까지 할까요?`;
}

// ---------- 하루 기록 · 일기 (genJournal) ----------

export const COACHING = '이번 주 세 번, 회의가 있는 날 아침 준비가 바빴어요. 전날 밤에 자료와 가방을 챙기면 아침 준비가 줄어들어요.';

export const ROUTINE_SUGGESTION = {
  title: '회의 전날 준비',
  reason: '같은 문제가 최근 7일 중 3일',
  summary: '수요일 밤 9:30부터 3단계 · 아침 알람은 앞당기지 않아요',
};

// 일기에 넣는 사실 — 기상 · 출발 · 도착 · 다시 울림 · 저장한 것 · 미루기 (알람 울림 · 해제 같은 자동 기록은 뺌)
const FACT = /^(기상 확인|집 출발|도착|재알람|일정 저장|준비물 저장)|미루기/;

// 대화에서 내가 한 말 — 대본이라 고정 (실제는 Gemini가 대화를 요약)
const SAID = {
  fact: '회고 · 회의 자료 때문에 샤워 시간을 줄임',
  text: '회의 자료를 챙기느라 샤워 시간을 줄인 게 아쉬웠다고 했어요.',
};

export type MockJournal = {
  date: Date;
  aiText: string;
  text: string;
  edited: boolean;
  facts: JournalFact[];
  coaching: string;
  encouragement: string;
  suggestion: ApplyStatus;
};

export type JournalInput = {
  date: Date; // 일기 날짜 (그날 0시)
  me: { wakeAt: Date | null; departAt: Date | null; arriveAt: Date | null };
  appointment: { title: string; place: string; at: Date } | null; // 그날 아침 약속 (도착 · 지각)
  events: JournalFact[]; // 그날 일어난 일
  saidAt: Date | null; // 대화에서 내가 처음 말한 시각 — 말 안 했으면 null
  prev: MockJournal | null; // 다시 만들 때 앞 일기 — 고친 글 · 루틴 제안 응답은 그대로 둠
};

// 기록된 사실만으로 일기를 씀 — 숫자 · 시각은 기록에서 그대로 가져옴
export function writeJournal({ date, me, appointment: a, events, saidAt, prev }: JournalInput): MockJournal {
  const snoozes = events.filter((e) => e.label.includes('미루기')).length;
  const late = me.arriveAt && a ? Math.max(0, minutesBetween(a.at, me.arriveAt)) : null;

  const parts: string[] = [];
  if (me.wakeAt) parts.push(`${snoozes ? `알람을 ${snoozes}번 미룬 뒤 ` : ''}${formatTime(me.wakeAt)}에 일어났어요.`);
  if (me.departAt && me.arriveAt && a) {
    parts.push(
      `${formatTime(me.departAt)}에 집을 나서 ${formatTime(me.arriveAt)}에 ${a.place}에 도착했고, ${a.title}에 ${late ? `${late}분 늦었어요` : '늦지 않았어요'}.`,
    );
  } else if (me.arriveAt && a) {
    parts.push(`${formatTime(me.arriveAt)}에 ${a.place}에 도착했어요.`);
  }
  if (saidAt) parts.push(SAID.text);

  let text = parts.join(' ');
  if (!text) text = '오늘은 남은 기록이 많지 않아 짧게 적어요. 내일은 기상 확인부터 남겨 봐요.';
  else if (!me.wakeAt && !me.arriveAt) text = `오늘은 기록이 많지 않아 짧게 남겨요. ${text}`;

  const facts = events.filter((e) => FACT.test(e.label)).map((e) => ({ ...e }));
  if (saidAt) facts.push({ at: saidAt, label: SAID.fact, source: 'AI 대화' });
  facts.sort((x, y) => x.at.getTime() - y.at.getTime());

  return {
    date,
    aiText: text,
    text: prev?.edited ? prev.text : text,
    edited: prev?.edited ?? false,
    facts,
    coaching: COACHING,
    encouragement: me.arriveAt && !late ? '오늘도 약속 시간 안에 도착했어요. 이 흐름을 이어가요.' : '내일은 조금 더 여유 있게 시작해 봐요.',
    suggestion: prev?.suggestion ?? 'PENDING',
  };
}

// 루틴 제안으로 만든 초안 (rAccept) — 수요일 21:30부터 3단계
export function suggestedRoutine(sourceJournal: string | null): Routine {
  return {
    id: null,
    title: ROUTINE_SUGGESTION.title,
    goal: '여유로운 아침',
    days: ['수'],
    startMinute: 21 * 60 + 30,
    steps: [
      { id: 's1', name: '회의 자료 확인', minutes: 5, alarm: true },
      { id: 's2', name: '노트북 충전', minutes: 2, alarm: false },
      { id: 's3', name: '가방에 준비물 넣기', minutes: 3, alarm: false },
    ],
    active: true,
    sourceJournal,
  };
}

// 바뀌는 값 — api.ts만 읽고 씀
export const aiDb = {
  chat: null as MockChat | null, // AI 탭을 처음 열 때 시작
  journals: {} as Record<string, MockJournal>, // 날짜(2025-05-22)별
  routines: [] as Routine[], // 저장한 루틴 (저녁 루틴)
};
