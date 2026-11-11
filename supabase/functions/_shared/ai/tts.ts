// Gemini TTS 한 번 — 문장 하나를 정한 목소리 · 발화 지시로 WAV(24kHz · 모노 · 16비트)로 받음. 알람 음성 브리핑(alarm-briefing)만 씀
//   Interactions API (POST /v1beta/interactions, aistudio.google.com/docs/speech-generation 11/10 확인):
//     input[].content[] 글 조각의 annotations에 speech_metadata.style(감정 · 속도 · 억양 지시), generation_config.speech_config[].voice, response_format audio
//     응답 steps[] 중 model_output의 content[] audio 조각 data(base64)
//   gemini.ts처럼 SDK 없이 fetch만 — 시험은 가짜 fetch로 (tts.test.ts). 실제 API 응답 모양은 미검증 (실키로 한 번 확인 필요)
//   소리 크기는 모델이 아니라 폰의 알람 볼륨(울림 계획 volumePercent)이 정함
import { kindOfStatus } from './gemini.ts';
import { LlmClientError } from './llm.ts';

const URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';
export const TTS_TIMEOUT_MS = 30_000;

export type TtsRequest = { model: string; text: string; voice: string; style: string };
export type TtsAudio = { mime: string; data: string }; // data = base64

export function ttsBody(req: TtsRequest): Record<string, unknown> {
  return {
    model: req.model,
    input: [{ type: 'user_input', content: [{ type: 'text', text: req.text, annotations: [{ type: 'speech_metadata', style: req.style }] }] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice: req.voice }] },
  };
}

type Part = { type?: string; data?: string; mime_type?: string };
type Body = { steps?: { type?: string; content?: Part[] }[] };

/** 응답에서 마지막 오디오 조각. 없으면 null */
export function audioOf(body: Body): TtsAudio | null {
  const parts = (body.steps ?? []).filter((s) => s.type === 'model_output').flatMap((s) => s.content ?? []);
  const audio = parts.filter((p) => p.type === 'audio' && typeof p.data === 'string' && p.data.length > 0).at(-1);
  return audio ? { mime: audio.mime_type ?? 'audio/wav', data: audio.data as string } : null;
}

export type Tts = (req: TtsRequest) => Promise<TtsAudio>;

export function createTts(apiKey: string, fetchFn: typeof fetch = fetch, timeoutMs = TTS_TIMEOUT_MS): Tts {
  return async (req) => {
    let res: Response;
    try {
      res = await fetchFn(URL, {
        method: 'POST',
        headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(ttsBody(req)),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const aborted = e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
      throw new LlmClientError(aborted ? 'timeout' : 'connection', e instanceof Error ? e.message : String(e), { cause: e });
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LlmClientError(kindOfStatus(res.status, text), text.slice(0, 300), { status: res.status });
    }
    const audio = audioOf((await res.json()) as Body);
    if (!audio) throw new LlmClientError('unknown', '응답에 음성이 없어요');
    return audio;
  };
}
