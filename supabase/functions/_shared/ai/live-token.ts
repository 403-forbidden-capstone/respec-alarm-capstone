// Gemini Live 1회용 토큰 만들기 — voice-live-token 함수와 로컬 점검 스크립트(tools/gemini-smoke)가 같은 코드를 씀
//   순수 TS (fetch를 넣어 줄 수 있음) — node --test · 로컬 스크립트에서 그대로 돎
import { HttpError } from '../errors.ts';
import { lifeDate } from './turn-core.ts';
import { addDays } from './view.ts';

export const LIVE_MODEL = 'gemini-3.8-live';
export const LIVE_TOKEN_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
// 음성 대화 한 번의 최대 길이 — 토큰 만료로 서버가 막고, 앱(useLiveVoice)도 같은 시간에 끊음 (비용 상한)
export const LIVE_SESSION_MS = 10 * 60_000;

// 언어는 고정하지 않음 — 사용자가 지금 말하는 언어로 답하고, 바꿔 달라고 하면 바꿈
export const LIVE_SYSTEM = [
  'You are the friendly voice assistant of the Re:Spec Alarm app, chatting with a university student before sleep about their day and tomorrow.',
  'Language rule: always reply in the same language the user is speaking in their latest turn (for example Korean, Japanese, English or any other).',
  'Do not default to a fixed language. If the user asks you to speak in another language, switch to it and keep using it until they speak or ask otherwise.',
  'Keep replies short and natural for spoken conversation (one to three sentences), and ask one follow-up question when it helps.',
  // 카드는 앱이 대화 글에서 따로 만들고 저장은 사용자가 카드 버튼으로 함 — Live는 카드가 생겼는지 · 저장됐는지 모르므로 상태를 말하지 않게 (11/7 웹 시험)
  'When the user mentions a plan or schedule, the app picks it up from the transcript on its own and may show a confirmation card on screen a little later.',
  'You cannot see whether a card was created or saved, so never say a card or schedule was created, added or saved, and never ask the user to save or press a button; just acknowledge the plan naturally and continue the conversation.',
  // 11/8 웹 시험 — '화면에 일정을 띄웠어요'라고 말함
  'Also never say you showed, displayed or put anything on the screen. If the date or time of a plan is unclear, ask the user for it briefly.',
  // 앱이 서버 추출 결과(되물을 것)를 Live 연결에 글로 넣음 (mobile live.ts 'ask') — 사용자 말이 아니라는 것 · 소리 내 읽지 않을 것
  'A text message starting with [APP NOTE] comes from the app, not the user: it lists what is still missing for a plan the user just mentioned. Ask the user only for that, in one short natural question in the language of the conversation, and never read the note aloud.',
  // 하루 기록 선택 질문 — 글 대화 T1.v1.6 FOLLOW_UP과 같은 규칙
  'Optional follow-up questions: the day record is written from what the user already said, so answering is never required and you must never say it is needed to save.',
  'You may ask at most one short follow-up per topic to make the day record richer (for example why they were tired, or what to bring for a plan they mentioned). Never ask the same thing twice.',
  // 글 대화 T1.v1.6 · guards MAX_REFLECT_BEFORE_SLEEP와 같은 상한 — 말이 없으면 앱이 30초 뒤 연결을 끝냄(mobile idle.ts)
  'Across the whole chat ask at most three day-review questions in total (for example how the day was, one follow-up, and plans for tomorrow). If the user stays silent, do not repeat or rephrase the question; the app ends the call by itself after 30 seconds of silence.',
  'If the user says they have nothing to add, does not know, wants to skip (for example 없어, 모르겠어, 넘어가, 패스, 그냥 저장해) or ignores the question, drop that topic, acknowledge briefly and move on without guessing feelings, reasons or scores.',
  'If the user wants to finish (for example 잘게, 그만, 그냥 저장해), ask nothing more and say a short good night. When a plan still needs its time or AM/PM, that question comes first; do not add a day-review question in the same turn.',
].join(' ');

// 같은 대화방의 앞 대화(글 · 음성) — 지침 끝에 붙여 Live가 이어서 답하게. 최근 줄만 · 줄마다 잘라서 토큰을 아낌
export const LIVE_HISTORY_TURNS = 20;
const LIVE_HISTORY_LINE_CHARS = 300;
export function liveHistory(turns: readonly { role: 'user' | 'ai'; text: string }[]): string {
  const lines = turns
    .filter((t) => t.text.trim())
    .slice(-LIVE_HISTORY_TURNS)
    .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.text.trim().slice(0, LIVE_HISTORY_LINE_CHARS)}`);
  return lines.length === 0 ? '' : `\n\nConversation so far in this chat room (typed or spoken). Continue naturally from it; do not repeat greetings:\n${lines.join('\n')}`;
}

// 날짜 해석 — 글 대화(view.ts 날짜 블록 · turn-core dayOf)와 같은 KST 새벽 4시 규칙. 토큰을 만드는 때(now) 기준
//   day = 이어 쓰는 대화방의 기준일 — 있으면 '오늘'은 그 날 (03:59에 연 방을 04:00 뒤에 이어 써도 글 대화처럼 그 방 기준일)
export function liveDateNote(now: number, day?: string): string {
  const iso = new Date(now).toISOString();
  const kst = new Date(now + 9 * 3_600_000).toISOString();
  const today = day ?? lifeDate(iso);
  return (
    `

Date rule (Korea time). Now: ${kst.slice(0, 10)} ${kst.slice(11, 16)}. The day changes at 4 AM, not at midnight: ` +
    `"today" (오늘) is ${today}, "yesterday" (어제) is ${addDays(today, -1)}, "tomorrow" (내일) is ${addDays(today, 1)}, "the day after tomorrow" (모레) is ${addDays(today, 2)}. ` +
    'Expressions counted from now, like "later" (이따가), "in N hours" (N시간 뒤) or "after I wake up" (자고 일어나서), use the current time. Explicit dates are used as said. ' +
    'If the date or AM/PM is unclear, or a plan would fall before now, ask the user.'
  );
}

// 토큰 요청 본문 — 모델 · 응답 형식 · 지침을 토큰에 잠가서 앱이 바꿀 수 없게 함
export function liveTokenBody(now: number, model = LIVE_MODEL, history = '', day?: string): Record<string, unknown> {
  return {
    // uses는 생략하면 1회 (REST에서는 설정과 함께 보내지 않음)
    expireTime: new Date(now + LIVE_SESSION_MS).toISOString(), // 대화 한 번의 최대 길이
    newSessionExpireTime: new Date(now + 60_000).toISOString(), // 1분 안에 연결해야 함
    bidiGenerateContentSetup: {
      model: `models/${model}`,
      generationConfig: { responseModalities: ['AUDIO'] },
      systemInstruction: { parts: [{ text: LIVE_SYSTEM + liveDateNote(now, day) + history }] },
      inputAudioTranscription: {}, // 내 말 · AI 말을 글로도 받아 화면에 보여 줌
      outputAudioTranscription: {},
    },
  };
}

// 실패하면 VOICE_UNAVAILABLE. 원인(상태 · 본문)은 서버 로그(log)에만 남김
export async function createLiveToken(
  apiKey: string,
  opts: { fetchFn?: typeof fetch; now?: number; model?: string; history?: string; day?: string; body?: Record<string, unknown>; log?: (...a: unknown[]) => void } = {},
): Promise<{ token: string; model: string }> {
  const { fetchFn = fetch, now = Date.now(), model = LIVE_MODEL, history = '', day, body, log = console.error } = opts;
  const res = await fetchFn(LIVE_TOKEN_URL, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? liveTokenBody(now, model, history, day)), // body = 다른 지침 · 도구의 토큰 (아침 루틴 routine-live.ts)
  }).catch((e) => {
    log('gemini auth_tokens fetch failed', String(e));
    return null;
  });
  if (!res?.ok) {
    log('gemini auth_tokens failed', res?.status, await res?.text().catch(() => ''));
    throw new HttpError('VOICE_UNAVAILABLE', '음성 세션을 만들지 못했어요');
  }
  const { name } = (await res.json()) as { name?: string };
  if (!name) throw new HttpError('VOICE_UNAVAILABLE', '음성 세션을 만들지 못했어요');
  return { token: name, model };
}
