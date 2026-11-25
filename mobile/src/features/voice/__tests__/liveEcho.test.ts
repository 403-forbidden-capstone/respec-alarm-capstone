import { describe, expect, it } from '@jest/globals';

import { livePage } from '../live';

// Gemini Live 내부 페이지를 가짜 마이크 · 가짜 스피커로 실행해 실제 입출력 전환 순서를 검증한다.
// 외부 API · 실제 마이크가 없어도 'AI 재생 → PCM 차단 → 재생 종료 → PCM 재개'를 확인한다.
describe('Gemini Live microphone gating', () => {
  it('AI 말이 끝까지 재생될 때까지 마이크 전송을 막고 연결은 유지한다', async () => {
    const html = livePage('test-token', 'test-model');
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    expect(script).toBeTruthy();

    const sent: unknown[] = [];
    const events: { type: string; muted?: boolean }[] = [];
    const timers: (() => void)[] = [];
    const sources: { onended?: () => void; start?: (time: number) => void; stop?: () => void }[] = [];
    let processor: { onaudioprocess?: (event: unknown) => void } = {};
    let socket: { onopen?: () => void; onmessage?: (ev: { data: string }) => void; readyState: number; close: () => void } | null = null;
    const win = {
      ReactNativeWebView: { postMessage: (text: string) => events.push(JSON.parse(text)) },
      addEventListener: () => {},
      parent: { postMessage: () => {} },
    };
    const mic = { getTracks: () => [{ stop: () => {} }] };
    const navigatorFake = { mediaDevices: { getUserMedia: async () => mic } };
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      createMediaStreamSource() { return { connect: () => {} }; }
      createScriptProcessor() {
        processor = {};
        const p = processor; // 펼침({...})은 setter를 값으로 바꿔 버려서(Babel) 받는 쪽을 직접 둠
        return { set onaudioprocess(fn: (e: unknown) => void) { p.onaudioprocess = fn; }, connect: () => {} };
      }
      createBuffer(_channels: number, size: number, rate: number) {
        return { duration: size / rate, getChannelData: () => new Float32Array(size) };
      }
      createBufferSource() {
        const s = { buffer: null, connect: () => {}, start: (_at: number) => {}, stop: () => {}, onended: undefined as (() => void) | undefined };
        sources.push(s);
        return s;
      }
      resume() {}
      close() {}
    }
    class FakeWebSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (ev: { data: string }) => void;
      constructor(_url: string) { socket = this; }
      send(message: string) { sent.push(JSON.parse(message)); }
      close() { this.readyState = 3; }
    }
     
    const runScript = new Function('window', 'document', 'navigator', 'AudioContext', 'WebSocket', 'setTimeout', 'clearTimeout', 'btoa', 'atob', script as string);
    runScript(
      win, { addEventListener: () => {} }, navigatorFake, FakeAudioContext, FakeWebSocket,
      (callback: () => void) => { timers.push(callback); return timers.length; },
      () => {},
      (binary: string) => Buffer.from(binary, 'binary').toString('base64'),
      (base64: string) => Buffer.from(base64, 'base64').toString('binary'),
    );
    await Promise.resolve();
    expect(socket).not.toBeNull();
    const ws = socket as unknown as InstanceType<typeof FakeWebSocket>;
    ws.onopen?.();
    // 페이지는 서버 메시지를 Promise로 읽어(onmessage → then) 다음 마이크로태스크에 처리함
    const settle = async () => {
      for (let i = 0; i < 3; i++) await Promise.resolve();
    };
    const fromServer = async (serverContent: object) => {
      ws.onmessage?.({ data: JSON.stringify({ serverContent }) });
      await settle();
    };
    ws.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
    await settle();

    const micFrame = () => processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array([0.1, 0.2]) } });
    micFrame();
    const initial = sent.length;
    expect(initial).toBeGreaterThan(1); // setup + 사용자 PCM

    const pcm = Buffer.alloc(8).toString('base64');
    await fromServer({ outputTranscription: { text: '안녕하세요' }, modelTurn: { parts: [{ inlineData: { data: pcm, mimeType: 'audio/pcm;rate=24000' } }] } });
    expect(events).toContainEqual({ type: 'mic', muted: true });
    expect(sources).toHaveLength(1);
    micFrame();
    expect(sent).toHaveLength(initial);
    await fromServer({ turnComplete: true });
    expect(events.some((e) => e.type === 'turn')).toBe(false); // 서버의 완료만으로 조기 종료하면 안 됨
    micFrame();
    expect(sent).toHaveLength(initial);

    sources[0].onended?.(); // 사용자에게 들리는 마지막 PCM 재생 종료
    micFrame();
    expect(sent).toHaveLength(initial); // 잔향 보호시간 동안에도 차단
    expect(timers).toHaveLength(1);
    timers[0]();
    expect(events.slice(-2)).toEqual([{ type: 'mic', muted: false }, { type: 'turn' }]);
    micFrame();
    expect(sent).toHaveLength(initial + 1);
    expect(ws.readyState).toBe(1); // WebSocket은 계속 연결돼 다음 사용자 말을 받음
  });
});
