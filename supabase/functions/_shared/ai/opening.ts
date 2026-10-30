// 서버 템플릿 글 — 첫 마디(설계 메모 4.4) · 상한 안내. LLM을 부르지 않는다(ai_calls 0줄). 순수 TS.
//   첫 마디 세 경우: ① 읽어 줄 기록이 있음 → 요약 한 번 + "틀린 게 있으면 말해 주세요." ② 기록 없음 · 서버 질문 → 질문 글 그대로 ③ 둘 다 없음 → "오늘 하루는 어땠어요?"
//   시각은 말로(오전 8시 12분), 지각은 말하지 않는다(DB 판정을 대화가 다시 재지 않음, 설계 메모 4.2 #6 — 지각 사실은 LATE로 따로 있어서 여기서 안 읽음).
//   조사는 "{제목} 일정이 있어서"로 받침 걱정 없앰(설계 판단).
import type { Act, Context, Fact, ServerQuestion } from './types.ts';
import { spokenTime } from './view.ts';

/** 대화당 사용자 말 상한 · 하루 대화 수 · 하루 AI 호출 수 (설계 메모 0절 · 3절) */
export const MAX_USER_TURNS = 20;
export const MAX_SESSIONS_PER_DAY = 5;
export const MAX_AI_CALLS_PER_DAY = 300;

export const LIMIT_TURN_TEXT = '오늘 대화는 여기까지예요. [완료]를 누르면 정리할게요.';
export const LIMIT_DAY_TEXT = '오늘 대화는 여기까지예요.';

/** 첫 마디가 한 번에 읽는 기록 상한 (기상 1 + 출발 · 앞 출발 · 도착 합쳐 최대 5개) — 되묻는 후보(확인할 기록)는 따로 3개 상한 */
export const OPENING_FACTS_MAX = 5;

const spoken = (hhmm: string): string => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return spokenTime(h, m);
};

/** 첫 마디가 읽어 줄 기록 — 자동으로 잡은(확인 전) 기상 · 출발 · 앞 출발 · 도착. 원탭 · 직접 값은 사용자가 이미 준 값이라 읽지 않음 */
export function openingFacts(ctx: Context): Fact[] {
  return ctx.today.facts.filter((f) => !f.confirmed && f.time !== null && (f.kind === 'WAKE' || f.kind === 'DEPART' || f.kind === 'ARRIVE')).slice(0, OPENING_FACTS_MAX);
}

// 한 줄 이어 말하기: 이어지는 꼴(…고)과 끝 꼴(…어요)
function clause(f: Fact, next: Fact | undefined, last: boolean): string {
  const t = spoken(f.time as string);
  if (f.kind === 'WAKE') return `${t}에 ${last ? '일어났어요' : '일어났고'}`;
  if (f.kind === 'ARRIVE') return `${t}에 ${last ? '도착했어요' : '도착했고'}`;
  if (f.earlier === true) return `${t}에 ${last ? '잠깐 나갔다 들어왔어요' : '잠깐 나갔다 들어왔고'}`;
  if (last) return `${t}에 출발했어요`;
  return `${t}에 ${next?.kind === 'ARRIVE' ? '출발해서' : '출발했고'}`;
}

/** "오늘 오전 8시 12분에 일어났고 오전 10시 7분에 도착했어요." */
export function summarySentence(facts: Fact[]): string {
  return `오늘 ${facts.map((f, i) => clause(f, facts[i + 1], i === facts.length - 1)).join(' ')}.`;
}

/** 내일 기상 한 줄 — 내일 가장 이른 켜진 기상 알람. 일정에 딸렸으면 그 일정을 말함. 없으면 null */
export function tomorrowSentence(ctx: Context): string | null {
  const wakes = ctx.tomorrow.alarms.filter((a) => a.owner === 'u0' && a.type === 'WAKE' && a.enabled).sort((x, y) => (x.date + x.time < y.date + y.time ? -1 : 1));
  const wake = wakes[0];
  if (wake === undefined) return null;
  const level = wake.intensity === 'STRONG' ? '강하게 ' : wake.intensity === 'SOFT' ? '약하게 ' : '';
  const appt = wake.appointment_ref === null ? undefined : ctx.tomorrow.appointments.find((a) => a.ref === wake.appointment_ref);
  if (appt === undefined) return `내일은 ${spoken(wake.time)}에 ${level}깨워요.`;
  return `내일은 ${spoken(appt.time)} ${appt.title} 일정이 있어서 ${spoken(wake.time)}에 ${level}깨워요.`;
}

export interface OpeningMessage {
  text: string;
  acts: Act[];
  /** 서버 질문을 이 글로 물었는지 — true면 질문 기록(user_questions)을 남김 */
  asksQuestion: boolean;
}

export function openingMessage(ctx: Context, question: ServerQuestion | null): OpeningMessage {
  const facts = openingFacts(ctx);
  const tomorrow = tomorrowSentence(ctx);
  if (facts.length > 0) {
    return { text: [summarySentence(facts), tomorrow, '틀린 게 있으면 말해 주세요.'].filter((s): s is string => s !== null).join(' '), acts: [], asksQuestion: false };
  }
  if (question !== null) return { text: question.text, acts: [{ type: 'SERVER_Q', ref: question.id }], asksQuestion: true };
  return { text: [tomorrow, '오늘 하루는 어땠어요?'].filter((s): s is string => s !== null).join(' '), acts: [{ type: 'REFLECT', ref: null }], asksQuestion: false };
}
