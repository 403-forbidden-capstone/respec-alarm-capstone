// Gemini Live 로컬 토큰 서버 — 운영 voice-live-token을 배포하기 전에 PC에서 앱(웹 미리보기)과 Live를 이어 시험
//   node tools/live-token-server.ts        → http://127.0.0.1:8787 (POST 하나만)
//   앱: mobile/.env에 EXPO_PUBLIC_LIVE_TOKEN_URL=http://127.0.0.1:8787 → expo 다시 시작. 개발 빌드(__DEV__)에서만 이 주소를 씀
// 토큰은 서버 함수와 같은 코드(_shared/ai/live-token.ts)로 만듦 — 모델 · 지침도 같음. 부르는 Google API는 Live 토큰 발급 하나뿐
// 키: supabase/functions/.env의 GEMINI_API_KEY
// shortcut: 로그인 확인 · 횟수 한도 없음(이 PC의 127.0.0.1에서만, Expo 웹 주소에서 온 요청만 받음) — 폰 · 다른 PC에서 쓰려면 로그인 토큰 확인을 넣은 뒤 주소를 열 것
// 운영과 무관: 출시 빌드(웹 미리보기 · APK)는 EXPO_PUBLIC_LIVE_TOKEN_URL을 무시하고 서버 함수 voice-live-token만 부름 (features/voice/api.ts)
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

import { createLiveToken } from '../supabase/functions/_shared/ai/live-token.ts';

const PORT = Number(process.env.PORT ?? 8787);
const env = readFileSync(new URL('../supabase/functions/.env', import.meta.url), 'utf8');
const key = /^GEMINI_API_KEY=(.+)$/m.exec(env)?.[1]?.trim().replace(/^"|"$/g, '');
if (!key) throw new Error('supabase/functions/.env에 GEMINI_API_KEY가 없어요');

// 다른 웹 페이지가 이 PC의 서버에서 토큰을 받아 가지 못하게 — Expo 웹 주소(기본 8081)만. 바꾸려면 ORIGINS=http://localhost:8082 처럼
const ORIGINS = (process.env.ORIGINS ?? 'http://localhost:8081,http://127.0.0.1:8081').split(',');

const corsFor = (origin: string) => ({
  'Access-Control-Allow-Origin': origin,
  Vary: 'Origin',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
});

createServer(async (req, res) => {
  const origin = req.headers.origin ?? '';
  if (!ORIGINS.includes(origin)) return res.writeHead(403).end(); // Origin이 없는 요청(curl 등)도 거절
  const cors = corsFor(origin);
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  if (req.method !== 'POST') return res.writeHead(405, cors).end();
  try {
    const r = await createLiveToken(key);
    console.log(`${new Date().toLocaleTimeString()} 토큰 발급 (${r.model})`);
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(r));
  } catch (e) {
    console.error('토큰 발급 실패', e instanceof Error ? e.message : e);
    res.writeHead(502, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'VOICE_UNAVAILABLE' } }));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Live 토큰 서버: http://127.0.0.1:${PORT}`));
