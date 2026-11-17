// 실시간 음성 대화(Gemini Live) — 마이크 · 재생 · WebSocket을 돌리는 작은 페이지와 그 페이지가 보내는 메시지 모양
//   앱은 WebView, 웹 미리보기는 iframe으로 이 페이지를 띄움 (마이크 PCM 스트리밍 · 24kHz 재생을 새 네이티브 패키지 없이 하려고)
//   토큰은 서버(voice-live-token)가 준 1회용 토큰 — 1분 안에 연결, 모델 · 지침은 서버가 잠가 둠
//   페이지 → 앱: live(연결됨) · me/ai(말을 글로 바꾼 조각) · turn(AI 차례 끝) · mic(AI 말 중 전송 막음 · 다시 엶) · vad(사용자 목소리 감지 켜짐 · 꺼짐) · error(MIC · NETWORK) · closed(연결 끊김)
//   앱 → 페이지: ask(글) — 서버가 찾은 되물을 것을 Live 연결에 글로 넣어 Live가 소리로 물음 (clientContent, 받아쓰기에는 안 나옴)
//                stop — 앱이 연결을 끝낼 때 페이지를 내리기 전에 마이크 · 연결 · 재생을 먼저 닫게 (여러 번 와도 한 번만)

export type LiveMessage =
  | { type: 'live' }
  | { type: 'me' | 'ai'; text: string }
  | { type: 'turn' }
  | { type: 'mic'; muted: boolean }
  | { type: 'vad'; active: boolean }
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
  // AI 출력 중 PCM 전송만 막음. 마이크 트랙 · WebSocket · 재생은 유지한다.
  var micMuted = false, turnPending = false, resumeTimer = null, closed = false;
  var ECHO_TAIL_MS = 350;
  // 목소리 감지(30초 무발화 판정용) — 마이크가 열려 있을 때만, 프레임(2048샘플 ≈ 128ms) 소리 크기(RMS)로.
  //   켜짐: 문턱을 넘는 프레임이 3번 이어짐(≈0.4초, 짧은 잡음 무시) · 꺼짐: 문턱 아래가 6번 이어짐(≈0.8초, 말 사이 숨 고르기)
  //   문턱 = max(VAD_MIN, 바닥 소음 × 3) — 바닥 소음은 조용하면 바로 내려가고 시끄러우면 천천히 올라가서(약 10초 — 말 사이 쉼에 다시 내려감) 이어지는 소음은 바닥이 됨
  //   AI 소리는 마이크가 막힌 동안 보지 않음(재입력 방지와 같은 구간)
  var VAD_MIN = 0.015, VAD_ON = 3, VAD_OFF = 6, vadFloor = VAD_MIN / 3, vadActive = false, vadRun = 0;
  function vadSet(active) {
    vadRun = 0;
    if (vadActive === active) return;
    vadActive = active;
    post({ type: 'vad', active: active });
  }
  function vadFrame(f) {
    var sum = 0;
    for (var i = 0; i < f.length; i++) sum += f[i] * f[i];
    var rms = Math.sqrt(sum / (f.length || 1));
    var loud = rms > Math.max(VAD_MIN, vadFloor * 3);
    vadFloor = rms < vadFloor ? rms : vadFloor + (rms - vadFloor) * 0.005;
    if (loud === vadActive) { vadRun = 0; return; }
    vadRun++;
    if (vadRun >= (loud ? VAD_ON : VAD_OFF)) vadSet(loud);
  }
  function muteMic() {
    if (resumeTimer !== null) { clearTimeout(resumeTimer); resumeTimer = null; }
    if (micMuted) return;
    micMuted = true;
    vadSet(false);
    post({ type: 'mic', muted: true });
  }
  function maybeFinishTurn() {
    // 서버 turnComplete만으로는 실제 스피커 재생이 끝난 게 아니다.
    if (!turnPending || playing.length || closed || resumeTimer !== null) return;
    resumeTimer = setTimeout(function () {
      resumeTimer = null;
      if (closed || !turnPending || playing.length) return;
      turnPending = false;
      micMuted = false;
      post({ type: 'mic', muted: false });
      post({ type: 'turn' });
    }, ECHO_TAIL_MS);
  }
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
      if (closed || !ws || ws.readyState !== 1 || micMuted) return;
      var f = e.inputBuffer.getChannelData(0), pcm = new Int16Array(f.length);
      vadFrame(f);
      for (var i = 0; i < f.length; i++) { var v = Math.max(-1, Math.min(1, f[i])); pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff; }
      ws.send(JSON.stringify({ realtimeInput: { audio: { data: toB64(new Uint8Array(pcm.buffer)), mimeType: 'audio/pcm;rate=' + inCtx.sampleRate } } }));
    };
    src.connect(proc);
    proc.connect(inCtx.destination); // ScriptProcessor는 출력에 이어야 돎 (출력은 비어 있어 소리는 안 남)
  }
  // AI 목소리(16비트 PCM, 보통 24kHz)를 이어 붙여 재생
  function play(data, mimeType) {
    muteMic();
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
    s.onended = function () {
      var k = playing.indexOf(s);
      if (k >= 0) playing.splice(k, 1);
      maybeFinishTurn();
    };
  }
  // 사용자가 AI 말을 끊으면 남은 소리를 버림
  function hush() {
    playing.forEach(function (s) { try { s.stop(); } catch (e) {} });
    playing = [];
    playAt = 0;
    maybeFinishTurn();
  }
  function onServer(text) {
    if (closed) return; // 닫은 뒤 늦게 온 응답은 재생 · 전달하지 않음
    var m = JSON.parse(text);
    if (m.setupComplete) { startMic(); post({ type: 'live' }); return; }
    var c = m.serverContent;
    if (!c) return;
    if (c.interrupted) hush();
    // 첫 오디오가 오기 전에도 AI 응답 글이 먼저 도착할 수 있어 선제적으로 음소거한다.
    if ((c.outputTranscription && c.outputTranscription.text) || (c.modelTurn && c.modelTurn.parts && c.modelTurn.parts.length)) muteMic();
    if (c.inputTranscription && c.inputTranscription.text) post({ type: 'me', text: c.inputTranscription.text });
    if (c.outputTranscription && c.outputTranscription.text) post({ type: 'ai', text: c.outputTranscription.text });
    ((c.modelTurn && c.modelTurn.parts) || []).forEach(function (p) {
      if (p.inlineData && p.inlineData.data) play(p.inlineData.data, p.inlineData.mimeType);
    });
    if (c.turnComplete) { turnPending = true; maybeFinishTurn(); }
  }
  // 마이크 · 연결 · 재생 · 타이머를 모두 닫음 — 여러 번 불려도 한 번만 (앱 stop · pagehide · 연결 끊김)
  function cleanup() {
    if (closed) return;
    closed = true;
    if (resumeTimer !== null) { clearTimeout(resumeTimer); resumeTimer = null; }
    if (proc) { proc.onaudioprocess = null; try { proc.disconnect(); } catch (e) {} }
    playing.forEach(function (s) { try { s.stop(); } catch (e) {} });
    playing = [];
    try { if (ws) ws.close(); } catch (e) {}
    if (mic) mic.getTracks().forEach(function (t) { t.stop(); });
    [inCtx, outCtx].forEach(function (c) { try { if (c) Promise.resolve(c.close()).catch(function () {}); } catch (e) {} });
  }
  window.addEventListener('pagehide', cleanup);
  // 앱이 보낸 글(되물을 것) — 연결돼 있을 때만 Live에 넣고 차례를 넘겨 바로 답하게 (웹은 부모 창 · 앱은 WebView가 보냄)
  function fromApp(ev) {
    if (ev.source && ev.source !== window.parent) return;
    var m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (m && m.type === 'stop') { cleanup(); return; }
    if (!m || m.type !== 'ask' || typeof m.text !== 'string' || closed || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: m.text }] }], turnComplete: true } }));
  }
  window.addEventListener('message', fromApp);
  document.addEventListener('message', fromApp);
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { post({ type: 'error', code: 'MIC', detail: 'unsupported' }); return; }
  navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (stream) {
    if (closed) { stream.getTracks().forEach(function (t) { t.stop(); }); return; } // 권한을 기다리는 사이 앱이 끝냄
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
    ws.onclose = function (e) { var mine = !closed; cleanup(); if (mine) post({ type: 'closed', code: e.code, reason: e.reason || '' }); };
  }, function (err) {
    post({ type: 'error', code: 'MIC', detail: String(err && err.name) });
  });
})();
</script></body></html>`;
}
