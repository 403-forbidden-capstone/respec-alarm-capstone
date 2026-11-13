// Live 토큰 만들기 시험 — 가짜 fetch만 씀
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HttpError } from '../errors.ts';
import { createLiveToken, LIVE_HISTORY_TURNS, LIVE_MODEL, LIVE_SYSTEM, LIVE_TOKEN_URL, liveDateNote, liveHistory, liveTokenBody } from './live-token.ts';

describe('live-token', () => {
  it('키를 헤더로 보내고 모델 · 지침을 잠근 토큰을 돌려줌', async () => {
    let url = '';
    let init: RequestInit = {};
    const fetchFn = (async (u: string, i: RequestInit) => {
      url = u;
      init = i;
      return new Response(JSON.stringify({ name: 'auth_tokens/abc' }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await createLiveToken('k', { fetchFn, now: 0 });
    assert.deepEqual(r, { token: 'auth_tokens/abc', model: LIVE_MODEL });
    assert.equal(url, LIVE_TOKEN_URL);
    assert.equal((init.headers as Record<string, string>)['x-goog-api-key'], 'k');
    const body = JSON.parse(String(init.body));
    assert.equal(body.bidiGenerateContentSetup.model, `models/${LIVE_MODEL}`);
    assert.equal(body.newSessionExpireTime, new Date(60_000).toISOString());
  });

  it('Google이 거절하거나 연결이 안 되면 VOICE_UNAVAILABLE', async () => {
    const reject = (async () => new Response('bad', { status: 400 })) as unknown as typeof fetch;
    const offline = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    for (const fetchFn of [reject, offline]) {
      await assert.rejects(createLiveToken('k', { fetchFn, log: () => {} }), (e) => e instanceof HttpError && e.code === 'VOICE_UNAVAILABLE');
    }
  });

  it('같은 대화방의 앞 대화(글 · 음성)를 지침 끝에 붙임 — 최근 줄만, 빈 줄은 뺌, 없으면 지침 그대로', () => {
    const turns = [
      { role: 'ai' as const, text: '오늘 하루는 어땠어요?' },
      { role: 'user' as const, text: '내일 9시에 세종대에서 수업 있어' },
      { role: 'ai' as const, text: '  ' },
    ];
    const h = liveHistory(turns);
    assert.match(h, /Assistant: 오늘 하루는 어땠어요\?\nUser: 내일 9시에 세종대에서 수업 있어$/);
    const setup = liveTokenBody(0, LIVE_MODEL, h).bidiGenerateContentSetup as { systemInstruction: { parts: { text: string }[] } };
    assert.equal(setup.systemInstruction.parts[0].text, LIVE_SYSTEM + liveDateNote(0) + h);
    assert.equal(liveHistory([]), '');
    // Live는 카드 상태를 모름 — 생성 · 저장을 말하거나 저장을 요청하지 않게 지침에 적혀 있음
    assert.match(LIVE_SYSTEM, /never say a card or schedule was created, added or saved, and never ask the user to save/);
    const many = Array.from({ length: 30 }, (_, i) => ({ role: 'user' as const, text: `말${i}` }));
    assert.equal(liveHistory(many).split('\n').filter((l) => l.startsWith('User:')).length, LIVE_HISTORY_TURNS);
  });

  it('날짜 규칙(KST 새벽 4시) — 글 대화와 같은 오늘 · 어제 · 내일 · 모레, 이따가 · N시간 뒤는 지금 시각', () => {
    const at1 = Date.parse('2026-11-12T01:00:00+09:00');
    const n = liveDateNote(at1);
    assert.match(n, /Now: 2026-11-12 01:00\./);
    assert.match(n, /"today" \(오늘\) is 2026-11-11, "yesterday" \(어제\) is 2026-11-10, "tomorrow" \(내일\) is 2026-11-12, "the day after tomorrow" \(모레\) is 2026-11-13/);
    assert.match(n, /이따가.*N시간 뒤.*자고 일어나서.*use the current time/);
    assert.match(liveDateNote(Date.parse('2026-11-12T04:00:00+09:00')), /"today" \(오늘\) is 2026-11-12/);
    assert.match(liveDateNote(Date.parse('2027-01-01T03:59:00+09:00')), /"today" \(오늘\) is 2026-12-31, .* "tomorrow" \(내일\) is 2027-01-01/);
  });

  it('이어 쓰는 대화방의 기준일(day)이 있으면 04:00이 지나도 그 날이 오늘 — 토큰 지침에도 그대로', async () => {
    const at = Date.parse('2026-11-13T04:05:00+09:00');
    const n = liveDateNote(at, '2026-11-12');
    assert.match(n, /Now: 2026-11-13 04:05\./);
    assert.match(n, /"today" \(오늘\) is 2026-11-12, "yesterday" \(어제\) is 2026-11-11, "tomorrow" \(내일\) is 2026-11-13/);
    let sent = '';
    const fetchFn = (async (_u: string, init: { body: string }) => {
      sent = init.body;
      return new Response(JSON.stringify({ name: 't' }), { status: 200 });
    }) as unknown as typeof fetch;
    await createLiveToken('k', { fetchFn, now: at, day: '2026-11-12' });
    assert.ok(sent.includes('\\"today\\" (오늘) is 2026-11-12'));
  });
});
