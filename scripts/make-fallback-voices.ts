// 알람 3 · 4단계 기본 예비 음성(앱에 넣는 WAV)을 Gemini TTS로 한 번 만듦 — 개발자가 손으로 한 번만 돌림 (빌드 · 재생 때는 안 부름)
//   서버와 같은 요청(_shared/ai/tts.ts createTts) · 같은 목소리 · 지시(_shared/briefing.ts GEMINI_STAGE) · 대사(GEMINI_FALLBACK_TEXT)
//   이미 파일이 있으면 그 단계는 건너뜀 (한도를 아끼려고). 다시 만들려면 --force
//   실행 (키는 커밋 안 하는 supabase/functions/.env에서): npx deno run --allow-net --allow-read --allow-write --env-file=supabase/functions/.env scripts/make-fallback-voices.ts [3] [4] [--force]
import { createTts } from '../supabase/functions/_shared/ai/tts.ts';
import { GEMINI_FALLBACK_FILE, GEMINI_FALLBACK_TEXT, GEMINI_STAGE, TTS_MODEL, type GeminiLevel } from '../supabase/functions/_shared/briefing.ts';

const OUT = new URL('../mobile/modules/alarm-core/android/src/main/res/raw/', import.meta.url);
const RATE = 24_000; // 앱 음성 형식: 24kHz · 모노 · 16비트 PCM

const ascii = (b: Uint8Array, at: number) => String.fromCharCode(...b.subarray(at, at + 4));

/** RIFF/WAVE 헤더가 있으면 그대로, 헤더 없는 16비트 PCM(audio/l16)이면 헤더를 붙임 */
export function toWav(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 12 && ascii(bytes, 0) === 'RIFF' && ascii(bytes, 8) === 'WAVE') return bytes;
  const out = new Uint8Array(44 + bytes.length);
  const v = new DataView(out.buffer);
  const put = (at: number, s: string) => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  put(0, 'RIFF');
  v.setUint32(4, 36 + bytes.length, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // 모노
  v.setUint32(24, RATE, true);
  v.setUint32(28, RATE * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  put(36, 'data');
  v.setUint32(40, bytes.length, true);
  out.set(bytes, 44);
  return out;
}

/** 형식 확인 — 24kHz · 모노 · 16비트 PCM이 아니면 던짐. 재생 시간(초)을 돌려줌 */
export function checkWav(b: Uint8Array): number {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (ascii(b, 0) !== 'RIFF' || ascii(b, 8) !== 'WAVE') throw new Error('WAV가 아님');
  let at = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (at + 8 <= b.length) {
    const id = ascii(b, at);
    const size = v.getUint32(at + 4, true);
    if (id === 'fmt ') fmt = { format: v.getUint16(at + 8, true), channels: v.getUint16(at + 10, true), rate: v.getUint32(at + 12, true), bits: v.getUint16(at + 22, true) };
    if (id === 'data') {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== RATE || fmt.bits !== 16) throw new Error(`형식이 다름: ${JSON.stringify(fmt)}`);
      const len = Math.min(size, b.length - at - 8);
      if (len <= RATE) throw new Error('소리가 너무 짧음');
      return len / (RATE * 2);
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('data 조각이 없음');
}

if (import.meta.main) {
  const key = Deno.env.get('GEMINI_API_KEY');
  if (!key) throw new Error('GEMINI_API_KEY가 없어요 (supabase/functions/.env)');
  const force = Deno.args.includes('--force');
  const levels = (Deno.args.filter((a) => a === '3' || a === '4').map(Number) as GeminiLevel[]);
  const tts = createTts(key, fetch, 120_000);
  for (const level of levels.length ? levels : ([3, 4] as const)) {
    const file = new URL(GEMINI_FALLBACK_FILE[level], OUT);
    const exists = await Deno.stat(file).then(() => true, () => false);
    if (exists && !force) {
      console.log(`${level}단계: 이미 있어 건너뜀 (${file.pathname})`);
      continue;
    }
    const { voice, style } = GEMINI_STAGE[level];
    const audio = await tts({ model: TTS_MODEL, text: GEMINI_FALLBACK_TEXT[level], voice, style }); // 실패하면 던짐 — 가짜 파일을 안 남김
    const raw = Uint8Array.from(atob(audio.data), (c) => c.charCodeAt(0));
    const wav = toWav(raw);
    let seconds: number;
    try {
      seconds = checkWav(wav);
    } catch (e) {
      // 앱 폴더에는 안 넣고, 받은 그대로 임시 파일에 남겨 다시 부르지 않고 살펴볼 수 있게
      const tmp = await Deno.makeTempFile({ suffix: `-stage${level}.bin` });
      await Deno.writeFile(tmp, raw);
      throw new Error(`${level}단계 응답 형식 확인 실패(${e instanceof Error ? e.message : e}) — 받은 내용: ${tmp}`);
    }
    await Deno.writeFile(file, wav);
    console.log(`${level}단계 ${voice}: ${audio.mime} ${raw.length}바이트${wav === raw ? '' : ' (헤더 붙임)'} → ${seconds.toFixed(2)}초 저장`);
  }
}
