import { describe, expect, it } from '@jest/globals';

import { livePage } from '../live';

// Gemini Live 페이지를 가짜 브라우저(마이크 · 스피커 · WebSocket)로 돌려 목소리 감지 · 끝내기를 봄 (재입력 방지 순서는 liveEcho.test.ts)
async function harness() {
  const script = livePage('test-token', 'test-model').match(/<script>([\s\S]*?)<\/script>/)?.[1] as string;
  const sent: unknown[] = [];
  const events: { type: string; muted?: boolean; active?: boolean }[] = [];
  const timers: (() => void)[] = [];
  const sources: { onended?: () => void; stopped: boolean }[] = [];
  const listeners: Record<string, ((ev: { data: string; source?: unknown }) => void)[]> = {};
  const tracks = [{ stopped: 0, stop() { this.stopped++; } }];
  const ctxClosed: number[] = [];
  let processor: { onaudioprocess?: ((e: unknown) => void) | null } = {};
  let socket: FakeWebSocket | null = null;
  const parent = { postMessage: () => {} };
  const win = {
    ReactNativeWebView: { postMessage: (text: string) => events.push(JSON.parse(text)) },
    addEventListener: (name: string, fn: (ev: { data: string }) => void) => (listeners[name] ??= []).push(fn),
    parent,
  };
  class FakeAudioContext {
    currentTime = 0;
    destination = {};
    createMediaStreamSource() { return { connect: () => {} }; }
    createScriptProcessor() {
      processor = { onaudioprocess: undefined };
      const p = processor;
      return { set onaudioprocess(fn: ((e: unknown) => void) | null) { p.onaudioprocess = fn; }, connect: () => {}, disconnect: () => {} };
    }
    createBuffer(_c: number, size: number, rate: number) { return { duration: size / rate, getChannelData: () => new Float32Array(size) }; }
    createBufferSource() {
      const s = { buffer: null, connect: () => {}, start: () => {}, stop() { this.stopped = true; }, stopped: false, onended: undefined as (() => void) | undefined };
      sources.push(s);
      return s;
    }
    resume() {}
    close() { ctxClosed.push(1); return Promise.resolve(); }
  }
  class FakeWebSocket {
    readyState = 1;
    onopen?: () => void;
    onmessage?: (ev: { data: string }) => void;
    onclose?: (ev: { code: number; reason: string }) => void;
    closes = 0;
    constructor() { socket = this; }
    send(message: string) { sent.push(JSON.parse(message)); }
    close() { this.closes++; this.readyState = 3; }
  }
  new Function('window', 'document', 'navigator', 'AudioContext', 'WebSocket', 'setTimeout', 'clearTimeout', 'btoa', 'atob', script)(
    win, { addEventListener: () => {} }, { mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) } }, FakeAudioContext, FakeWebSocket,
    (cb: () => void) => { timers.push(cb); return timers.length; }, () => {},
    (b: string) => Buffer.from(b, 'binary').toString('base64'), (b: string) => Buffer.from(b, 'base64').toString('binary'),
  );
  await Promise.resolve();
  const ws = socket as unknown as FakeWebSocket;
  ws.onopen?.();
  // 페이지는 서버 메시지를 Promise로 읽어 다음 마이크로태스크에 처리함
  const server = async (m: object) => {
    ws.onmessage?.({ data: JSON.stringify(m) });
    for (let i = 0; i < 3; i++) await Promise.resolve();
  };
  await server({ setupComplete: {} });
  const frame = (level: number) => processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(2048).fill(level) } });
  const fromApp = (m: object) => (listeners.message ?? []).forEach((fn) => fn({ data: JSON.stringify(m), source: parent }));
  const vads = () => events.filter((e) => e.type === 'vad').map((e) => e.active);
  const pcm = Buffer.alloc(8).toString('base64');
  const aiSays = () => server({ serverContent: { modelTurn: { parts: [{ inlineData: { data: pcm, mimeType: 'audio/pcm;rate=24000' } }] } } });
  return { ws, sent, events, timers, sources, tracks, ctxClosed, server, frame, fromApp, vads, aiSays, processor: () => processor };
}

describe('Gemini Live 페이지 — 목소리 감지(30초 무발화용)', () => {
  it('문턱을 넘는 소리가 0.4초(3프레임) 이어져야 켜짐 — 짧은 잡음 1~2프레임은 무시, 0.8초 조용하면 꺼짐', async () => {
    const h = await harness();
    for (let i = 0; i < 5; i++) h.frame(0.001); // 조용한 방
    h.frame(0.3);
    h.frame(0.3); // 짧은 잡음
    h.frame(0.001);
    expect(h.vads()).toEqual([]);
    for (let i = 0; i < 3; i++) h.frame(0.2);
    expect(h.vads()).toEqual([true]);
    for (let i = 0; i < 5; i++) h.frame(0.001);
    expect(h.vads()).toEqual([true]);
    h.frame(0.001);
    expect(h.vads()).toEqual([true, false]);
  });

  it('AI가 말하는 동안에는 마이크 소리를 보지 않음(재입력 방지 구간) — 말하던 중이면 꺼짐으로 알림', async () => {
    const h = await harness();
    for (let i = 0; i < 3; i++) h.frame(0.2);
    expect(h.vads()).toEqual([true]);
    await h.aiSays();
    expect(h.events).toContainEqual({ type: 'mic', muted: true });
    expect(h.vads()).toEqual([true, false]);
    const before = h.sent.length;
    for (let i = 0; i < 20; i++) h.frame(0.5); // 스피커 소리가 마이크로 들어와도
    expect(h.vads()).toEqual([true, false]);
    expect(h.sent).toHaveLength(before); // PCM도 안 보냄 (기존 재입력 방지 그대로)
  });

  it('이어지는 큰 소음은 바닥 소음으로 바뀌어 감지가 꺼짐 (타이머가 계속 늘지 않게)', async () => {
    const h = await harness();
    for (let i = 0; i < 400; i++) h.frame(0.05); // 약 51초 같은 크기의 소음
    expect(h.vads()).toEqual([true, false]);
  });
});

describe('Gemini Live 페이지 — 끝내기', () => {
  it('앱의 stop: 마이크 트랙 · 연결 · 오디오 · 재생을 닫고, 여러 번 와도 한 번만, closed를 다시 알리지 않음', async () => {
    const h = await harness();
    await h.aiSays();
    h.fromApp({ type: 'stop' });
    expect(h.tracks[0].stopped).toBe(1);
    expect(h.ws.closes).toBe(1);
    expect(h.ctxClosed).toHaveLength(2);
    expect(h.sources[0].stopped).toBe(true);
    expect(h.processor().onaudioprocess).toBeNull();
    h.fromApp({ type: 'stop' });
    h.ws.onclose?.({ code: 1000, reason: '' });
    expect([h.tracks[0].stopped, h.ws.closes, h.ctxClosed.length]).toEqual([1, 1, 2]);
    expect(h.events.some((e) => e.type === 'closed')).toBe(false);
  });

  it('닫은 뒤 늦게 온 서버 응답은 재생 · 전달하지 않고, 되물을 것(ask)도 보내지 않음', async () => {
    const h = await harness();
    h.fromApp({ type: 'stop' });
    const n = h.events.length;
    await h.aiSays();
    await h.server({ serverContent: { inputTranscription: { text: '늦은 말' } } });
    h.fromApp({ type: 'ask', text: '몇 시예요?' });
    expect(h.events).toHaveLength(n);
    expect(h.sources).toHaveLength(0);
    expect(h.sent.some((m) => (m as { clientContent?: unknown }).clientContent)).toBe(false);
  });

  it('서버가 연결을 끊으면 정리하고 closed를 한 번 알림', async () => {
    const h = await harness();
    h.ws.onclose?.({ code: 1011, reason: 'x' });
    expect(h.tracks[0].stopped).toBe(1);
    expect(h.events.filter((e) => e.type === 'closed')).toHaveLength(1);
  });
});
