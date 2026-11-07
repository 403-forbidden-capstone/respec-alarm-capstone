// 실시간 음성 대화(Gemini Live) — 마이크 · 재생 · WebSocket을 돌리는 작은 페이지와 그 페이지가 보내는 메시지 모양
//   앱은 WebView, 웹 미리보기는 iframe으로 이 페이지를 띄움 (마이크 PCM 스트리밍 · 24kHz 재생을 새 네이티브 패키지 없이 하려고)
//   토큰은 서버(voice-live-token)가 준 1회용 토큰 — 1분 안에 연결, 모델 · 지침은 서버가 잠가 둠
//   페이지 → 앱: live(연결됨) · me/ai(말을 글로 바꾼 조각) · turn(AI 차례 끝) · error(MIC · NETWORK) · closed(연결 끊김)

export type LiveMessage =
  | { type: 'live' }
  | { type: 'me' | 'ai'; text: string }
  | { type: 'turn' }
  | { type: 'error'; code: 'MIC' | 'NETWORK'; detail?: string }
  | { type: 'closed'; code: number; reason: string };

export function parseLiveMessage(raw: unknown): LiveMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const m = JSON.parse(raw) as LiveMessage;
    return m && typeof m.type === 'string' ? m : null;
  } catch {
    return null;
  }
}

const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

// 페이지 글 — 토큰을 넣어서 만들고, 띄우면 바로 마이크를 열고 연결함. 끄려면 페이지를 내림(WebView · iframe을 없앰)
export function livePage(token: string, model: string): string {
  const js = (v: string) => JSON.stringify(v).replace(/</g, '\\u003c');
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
(function () {
  var TOKEN = ${js(token)}, MODEL = ${js(model)}, URL = ${js(LIVE_URL)};
  var ws, mic, inCtx, outCtx, proc, playAt = 0, playing = [];
  function post(m) {
    var s = JSON.stringify(m);
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(s);
    else window.parent.postMessage(s, '*');
  }
  function toB64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(b64) {
    var s = atob(b64), u = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  function newCtx(rate) {
    try { return new AudioContext({ sampleRate: rate }); } catch (e) { return new AudioContext(); }
  }
  // 마이크 → 16비트 PCM → realtimeInput. shortcut: ScriptProcessor는 낡은 API지만 WebView에서 모듈 없이 돎, 끊김이 보이면 AudioWorklet으로
  function startMic() {
    var src = inCtx.createMediaStreamSource(mic);
    proc = inCtx.createScriptProcessor(2048, 1, 1);
    proc.onaudioprocess = function (e) {
      if (!ws || ws.readyState !== 1) return;
      var f = e.inputBuffer.getChannelData(0), pcm = new Int16Array(f.length);
      for (var i = 0; i < f.length; i++) { var v = Math.max(-1, Math.min(1, f[i])); pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: toB64(new Uint8Array(pcm.buffer)), mimeType: 'audio/pcm;rate=' + inCtx.sampleRate } } }));
    };
    src.connect(proc);
    proc.connect(inCtx.destination); // ScriptProcessor는 출력에 이어야 돎 (출력은 비어 있어 소리는 안 남)
  }
  // AI 목소리(16비트 PCM, 보통 24kHz)를 이어 붙여 재생
  function play(data, mimeType) {
    var rate = Number((/rate=(\\d+)/.exec(mimeType || '') || [])[1]) || 24000;
    var u = fromB64(data), pcm = new Int16Array(u.buffer, 0, u.length >> 1);
    var buf = outCtx.createBuffer(1, pcm.length, rate), ch = buf.getChannelData(0);
    for (var i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
    var s = outCtx.createBufferSource();
    s.buffer = buf;
    s.connect(outCtx.destination);
    playAt = Math.max(playAt, outCtx.currentTime);
    s.start(playAt);
    playAt += buf.duration;
    playing.push(s);
    s.onended = function () { var k = playing.indexOf(s); if (k >= 0) playing.splice(k, 1); };
  }
  // 사용자가 AI 말을 끊으면 남은 소리를 버림
  function hush() {
    playing.forEach(function (s) { try { s.stop(); } catch (e) {} });
    playing = [];
    playAt = 0;
  }
  function onServer(text) {
    var m = JSON.parse(text);
    if (m.setupComplete) { startMic(); post({ type: 'live' }); return; }
    var c = m.serverContent;
    if (!c) return;
    if (c.interrupted) hush();
    if (c.inputTranscription && c.inputTranscription.text) post({ type: 'me', text: c.inputTranscription.text });
    if (c.outputTranscription && c.outputTranscription.text) post({ type: 'ai', text: c.outputTranscription.text });
    ((c.modelTurn && c.modelTurn.parts) || []).forEach(function (p) {
      if (p.inlineData && p.inlineData.data) play(p.inlineData.data, p.inlineData.mimeType);
    });
    if (c.turnComplete) post({ type: 'turn' });
  }
  function cleanup() {
    try { if (ws) ws.close(); } catch (e) {}
    if (mic) mic.getTracks().forEach(function (t) { t.stop(); });
    try { if (inCtx) inCtx.close(); if (outCtx) outCtx.close(); } catch (e) {}
  }
  window.addEventListener('pagehide', cleanup);
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { post({ type: 'error', code: 'MIC', detail: 'unsupported' }); return; }
  navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (stream) {
    mic = stream;
    inCtx = newCtx(16000);
    outCtx = newCtx(24000);
    inCtx.resume();
    outCtx.resume();
    ws = new WebSocket(URL + '?access_token=' + encodeURIComponent(TOKEN));
    ws.onopen = function () { ws.send(JSON.stringify({ setup: { model: 'models/' + MODEL } })); };
    ws.onmessage = function (ev) {
      (typeof ev.data === 'string' ? Promise.resolve(ev.data) : ev.data.text()).then(onServer).catch(function () {});
    };
    ws.onerror = function () { post({ type: 'error', code: 'NETWORK' }); };
    ws.onclose = function (e) { post({ type: 'closed', code: e.code, reason: e.reason || '' }); };
  }, function (err) {
    post({ type: 'error', code: 'MIC', detail: String(err && err.name) });
  });
})();
</script></body></html>`;
}
