// Gemini 로컬 점검 — 운영 Supabase를 거치지 않고 서버와 같은 코드로 Google에 바로 붙어 봄
//   실제 Google API를 부르므로(비용 · 한도 사용) --real을 붙여야만 돎. 평소 시험은 Mock(npm/deno test)
//   node tools/gemini-smoke.ts --real            글(T1 · T2F) + Live 둘 다
//   node tools/gemini-smoke.ts text|live --real  하나만 · GEMINI_TEXT_MODEL=gemini-3.5-flash node … 로 모델만 바꿔 보기
// 키: supabase/functions/.env의 GEMINI_API_KEY (커밋 안 됨). 모델: GEMINI_TEXT_MODEL(선택)
// 확인하는 것: 모델 이름이 맞는지 · 우리 JSON 스키마를 Gemini가 받는지 · 지연이 지점 제한 시간 안인지 · Live 토큰 발급 → WebSocket 연결 → 한 턴 답
import { readFileSync } from 'node:fs';

import { createGeminiClient, GEMINI_DEFAULT_MODEL } from '../supabase/functions/_shared/ai/gemini.ts';
import { createLiveToken } from '../supabase/functions/_shared/ai/live-token.ts';
import { callLlm } from '../supabase/functions/_shared/ai/llm.ts';
import { schemaOf } from '../supabase/functions/_shared/ai/schemas/index.ts';
import { POINTS } from '../supabase/functions/_shared/prompts/index.ts';

if (!process.argv.includes('--real')) {
  console.log('실제 Gemini API를 부르는 점검이에요. 정말 부르려면 --real을 붙이세요 (예: node tools/gemini-smoke.ts text --real)');
  process.exit(0);
}

const env: Record<string, string> = {};
for (const line of readFileSync(new URL('../supabase/functions/.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && m[2]) env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const key = env.GEMINI_API_KEY;
if (!key) throw new Error('supabase/functions/.env에 GEMINI_API_KEY가 없어요');
const textModel = process.env.GEMINI_TEXT_MODEL || env.GEMINI_TEXT_MODEL || GEMINI_DEFAULT_MODEL; // 셸 값이 .env보다 먼저
const which = process.argv.slice(2).find((a) => a !== '--real') ?? 'all';
let failed = false;

// 글 대화 — 실제 프롬프트 · 스키마로 한 번씩. 제한 시간은 넉넉히(30초) 잡고, 운영 제한(timeoutMs)을 넘었는지 따로 표시
async function text() {
  const client = createGeminiClient(key);
  const user = '### 지금까지 대화\nAI: 오늘 하루는 어땠어요?\n사용자: 내일은 2시에 초롱이랑 산책 약속이 있어\n\n위 대화에 이어질 AI의 다음 답을 써 줘.';
  for (const id of ['T1', 'T2F'] as const) {
    const p = POINTS[id];
    const r = await callLlm(client, {
      point: id, promptId: p.prompt.id, promptVersion: p.prompt.version, model: textModel,
      system: p.prompt.system, user, schema: schemaOf(p.schema), effort: p.effort, maxTokens: p.maxTokens,
      thinking: p.thinking, timeoutMs: 30_000, retryOnTimeout: false,
    });
    const ms = r.call.latency_ms;
    const slow = ms > p.timeoutMs ? ` ⚠ 운영 제한 ${p.timeoutMs}ms 넘음` : '';
    if (r.ok) console.log(`✔ 글 ${id} (${textModel}) ${ms}ms${slow}\n  ${JSON.stringify(r.data).slice(0, 300)}`);
    else {
      failed = true;
      console.log(`✘ 글 ${id} (${textModel}) ${r.code}: ${r.reason}`);
    }
  }
}

const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

// Live — 앱과 같은 순서: 토큰 → WebSocket(access_token) → setup → setupComplete. 마이크 대신 글 한 턴을 보내 AI 답(글 · 소리)을 받음
async function live() {
  const { token, model } = await createLiveToken(key, { log: (...a) => console.log('  ', ...a) });
  console.log(`✔ Live 토큰 발급 (${model})`);
  await new Promise<void>((resolve) => {
    const ws = new WebSocket(`${LIVE_URL}?access_token=${encodeURIComponent(token)}`);
    let said = '';
    let audioBytes = 0;
    let finished = false;
    const done = (ok: boolean, msg: string) => {
      if (finished) return; // 끝낸 뒤 오는 close는 무시
      finished = true;
      if (!ok) failed = true;
      console.log(`${ok ? '✔' : '✘'} ${msg}`);
      try { ws.close(); } catch { /* 이미 닫힘 */ }
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => done(false, 'Live 20초 안에 답이 없음'), 20_000);
    ws.onopen = () => ws.send(JSON.stringify({ setup: { model: `models/${model}` } }));
    ws.onmessage = async (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : await (ev.data as Blob).text());
      if (m.setupComplete) {
        console.log('✔ Live 연결 (setupComplete)');
        ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: '내일 2시에 초롱이랑 산책해' }] }], turnComplete: true } }));
        return;
      }
      const c = m.serverContent;
      if (c?.outputTranscription?.text) said += c.outputTranscription.text;
      for (const p of c?.modelTurn?.parts ?? []) if (p.inlineData?.data) audioBytes += Math.floor((p.inlineData.data.length * 3) / 4);
      if (c?.turnComplete) done(audioBytes > 0, `Live 답 — 소리 ${audioBytes}바이트, 글: ${said || '(없음)'}`);
    };
    ws.onerror = () => done(false, 'Live WebSocket 오류');
    ws.onclose = (e) => done(false, `Live 연결 끊김 code=${e.code} ${e.reason}`);
  });
}

if (which === 'all' || which === 'text') await text().catch((e) => { failed = true; console.log('✘ 글:', e.message); });
if (which === 'all' || which === 'live') await live().catch((e) => { failed = true; console.log('✘ Live:', e.message); });
process.exitCode = failed ? 1 : 0;
