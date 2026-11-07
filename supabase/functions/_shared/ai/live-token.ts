// Gemini Live 1회용 토큰 만들기 — voice-live-token 함수와 로컬 점검 스크립트(tools/gemini-smoke)가 같은 코드를 씀
//   순수 TS (fetch를 넣어 줄 수 있음) — node --test · 로컬 스크립트에서 그대로 돎
import { HttpError } from '../errors.ts';

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
].join(' ');

// 토큰 요청 본문 — 모델 · 응답 형식 · 지침을 토큰에 잠가서 앱이 바꿀 수 없게 함
export function liveTokenBody(now: number, model = LIVE_MODEL): Record<string, unknown> {
  return {
    // uses는 생략하면 1회 (REST에서는 설정과 함께 보내지 않음)
    expireTime: new Date(now + LIVE_SESSION_MS).toISOString(), // 대화 한 번의 최대 길이
    newSessionExpireTime: new Date(now + 60_000).toISOString(), // 1분 안에 연결해야 함
    bidiGenerateContentSetup: {
      model: `models/${model}`,
      generationConfig: { responseModalities: ['AUDIO'] },
      systemInstruction: { parts: [{ text: LIVE_SYSTEM }] },
      inputAudioTranscription: {}, // 내 말 · AI 말을 글로도 받아 화면에 보여 줌
      outputAudioTranscription: {},
    },
  };
}

// 실패하면 VOICE_UNAVAILABLE. 원인(상태 · 본문)은 서버 로그(log)에만 남김
export async function createLiveToken(
  apiKey: string,
  opts: { fetchFn?: typeof fetch; now?: number; model?: string; log?: (...a: unknown[]) => void } = {},
): Promise<{ token: string; model: string }> {
  const { fetchFn = fetch, now = Date.now(), model = LIVE_MODEL, log = console.error } = opts;
  const res = await fetchFn(LIVE_TOKEN_URL, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify(liveTokenBody(now, model)),
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
