import { useEffect, useRef, useState } from 'react';
import { AppState, PermissionsAndroid, Platform } from 'react-native';

import { now } from '@/lib/clock';
import { userMessage } from '@/lib/errors';

import { LiveFrame } from '../components/LiveFrame';
import { idleArm, idleExpired, idleHeard, idleOff, idleVad, type IdleWatch } from '../idle';
import { livePage, parseLiveMessage } from '../live';
import { addLiveChunk, closeLive, takeTurn, type LiveLine } from '../liveChat';

const CONNECT_TIMEOUT_MS = 15000; // 이 안에 연결(setupComplete)이 안 되면 실패로 봄
const LIVE_MAX_MS = 10 * 60_000; // 한 번 연결의 최대 길이 — 서버 토큰 만료(supabase/functions/_shared/ai/live-token.ts LIVE_SESSION_MS)와 같게
export const IDLE_TICK_MS = 1000; // 30초 무발화 판정을 보는 간격

export type LivePhase = 'idle' | 'connecting' | 'live';

export interface LiveVoiceOptions {
  /** 30초 동안 사용자 말이 없어 연결을 스스로 끝냈을 때 — 마지막 차례는 이미 넘긴 뒤(flush) 불림. 화면이 하루 기록 정리를 부름 */
  onIdle?: () => void;
  /** 화면 쪽 처리(카드 저장 · 장소 계산 · 글 답 대기)가 도는 중이면 true — 그동안은 끝내지 않고, 끝나면 새 30초 */
  isBusy?: () => boolean;
}

// 실시간 음성 대화(Gemini Live) — start하면 마이크 권한을 묻고 토큰을 받아 연결, 말하면 AI가 목소리로 답함. stop하면 페이지를 내려 마이크 · 연결을 모두 닫음
//   말을 글로 바꾼 것(lines)은 AI 대화 화면이 말풍선으로 그림 (liveChat.mergeLive). 연결을 끝내도 lines는 남음 — clear로만 지움
//   frame(소리 페이지)은 화면 어디든 한 번 그려 두면 됨 (보이지 않음)
//   onTurn — 한 차례(내 말 + AI 답)가 끝날 때마다 불림. true를 돌려주면(서버 대화에 남김) 그 말풍선을 내림
//   ask(글) — onTurn 안에서 부름: 되물을 것을 Live에 넣어 소리로 묻게 함, 연결이 끝났으면 false
//   30초 무발화(idle.ts) — 듣는 중에만 잼(AI가 말하는 동안 · 서버 처리 중엔 멈춤). 지나면 마지막 차례를 넘기고 연결을 닫은 뒤 onIdle
//   앱이 뒤로 가면(홈 · 다른 앱 · 최근 앱) 바로 끝냄 — 돌아와도 다시 켜지 않음(사용자가 말하기를 눌러야 켜짐)
export function useLiveVoice(
  getToken: () => Promise<{ token: string; model: string }>,
  onTurn?: (me: string, ai: string, ask: (text: string) => boolean) => Promise<boolean>,
  options: LiveVoiceOptions = {},
) {
  const [phase, setPhase] = useState<LivePhase>('idle');
  const [page, setPage] = useState<{ html: string; run: number } | null>(null);
  const [lines, setLinesState] = useState<LiveLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [micMuted, setMicMuted] = useState(false); // AI 발화 중 자동 음소거 (연결 종료 아님)
  const [idleEnded, setIdleEnded] = useState(false); // 30초 무발화로 끝남 — 다시 시작하거나 clearError까지 (화면 안내용)
  const run = useRef(0); // 시작 · 끝마다 늘림 — 토큰을 기다리는 사이 끝냈으면 늦게 온 토큰으로 연결하지 않게, 닫은 페이지의 늦은 메시지를 버리게
  const linesRef = useRef<LiveLine[]>([]); // 차례를 넘길 때 지금 줄을 읽으려고 (렌더 값은 늦을 수 있음)
  const sendRef = useRef<((data: string) => void) | null>(null); // Live 페이지로 글 보내기 (LiveFrame이 채움)
  const idle = useRef<IdleWatch>(idleOff());
  const listening = useRef(false); // 연결됨 + 마이크 전송 중 (AI가 말하는 중이 아님)
  const inflight = useRef(0); // 서버로 넘긴 차례(onTurn) 중 아직 안 끝난 수
  const active = useRef(false); // start ~ end 사이 (연결 중 · 연결됨)
  const onTurnRef = useRef(onTurn);
  const optionsRef = useRef(options);
  useEffect(() => {
    onTurnRef.current = onTurn;
    optionsRef.current = options;
  });
  const setLines = (f: (prev: LiveLine[]) => LiveLine[]) => {
    linesRef.current = f(linesRef.current);
    setLinesState(linesRef.current);
  };
  const t = () => Date.now();
  const rearm = () => {
    idle.current = listening.current ? idleArm(t()) : idleOff();
  };

  // 확정된 새 줄을 한 차례로 서버에 넘김 — 남겼으면 그 말풍선을 내림 (서버 대화로 다시 보임). 내 말이 없으면(AI 혼잣말) 화면에만
  const flush = () => {
    const turn = takeTurn(linesRef.current);
    const send = onTurnRef.current;
    if (!turn || !send) return;
    setLines((prev) => prev.map((l) => (turn.ids.includes(l.id) ? { ...l, sent: true } : l))); // 두 번 보내지 않게
    if (!turn.me) return;
    inflight.current++;
    send(turn.me, turn.ai, ask)
      .then((ok) => {
        if (ok) setLines((prev) => prev.filter((l) => !turn.ids.includes(l.id)));
      })
      .catch(() => {}) // 못 남김 — 말풍선은 화면에 남음 (부르는 쪽이 알림)
      .finally(() => {
        inflight.current--;
        if (inflight.current === 0) rearm(); // 서버 처리 · 되묻기를 넘긴 뒤부터 새 30초
      });
  };

  // 되물을 것을 Live에 넣어 소리로 묻게 함 — 연결이 없으면(끝냄 · 끊김) false, 부르는 쪽이 글로 알림. 페이지가 연결 전이면 페이지가 버림
  const ask = (text: string): boolean => {
    if (!sendRef.current) return false;
    sendRef.current(JSON.stringify({ type: 'ask', text }));
    return true;
  };

  // 끝냄 — 여러 번 불려도 됨. 페이지에 먼저 stop을 보내 마이크 · 연결 · 재생을 닫게 하고 페이지를 내림
  const end = () => {
    run.current++;
    active.current = false;
    sendRef.current?.(JSON.stringify({ type: 'stop' }));
    listening.current = false;
    idle.current = idleOff();
    setPage(null);
    setPhase('idle');
    setMicMuted(false);
    setLines(closeLive); // 연결이 끝나면 임시 글도 확정
    flush(); // 끊긴 차례도 남김
  };
  const fail = (message: string) => {
    end();
    setError(message);
  };

  useEffect(() => {
    if (phase !== 'connecting' || !page) return;
    const timer = setTimeout(() => fail('음성 연결이 늦어요. 인터넷을 확인하고 다시 시작해 주세요'), CONNECT_TIMEOUT_MS);
    return () => clearTimeout(timer);
    // fail은 렌더마다 새로 만들어지지만 연결을 기다리기 시작할 때 한 번만 걸면 됨
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, page]);

  useEffect(() => {
    if (phase !== 'live') return;
    const timer = setTimeout(() => fail('10분이 지나 음성 대화를 마쳤어요. 이어서 말하려면 다시 시작해 주세요'), LIVE_MAX_MS);
    // 30초 무발화 — 서버 처리(넘긴 차례 · 화면 작업) 중이면 끝내지 않고 새 30초
    const tick = setInterval(() => {
      if (!idleExpired(idle.current, t())) return;
      if (inflight.current > 0 || optionsRef.current.isBusy?.()) return rearm();
      end();
      setIdleEnded(true);
      optionsRef.current.onIdle?.();
    }, IDLE_TICK_MS);
    return () => {
      clearTimeout(timer);
      clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // 앱이 뒤로 가면(background · inactive) 마이크 · 연결을 바로 닫음 — 돌아와도 자동으로 켜지 않음
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' && active.current) end();
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 화면(훅)이 사라질 때도 닫음
  useEffect(
    () => () => {
      sendRef.current?.(JSON.stringify({ type: 'stop' }));
    },
    [],
  );

  async function start() {
    if (active.current) end(); // 켜져 있던 연결은 닫고 새로 (마이크 두 번 열지 않게)
    const mine = ++run.current;
    active.current = true;
    setError(null);
    setIdleEnded(false);
    setMicMuted(false);
    setPhase('connecting');
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (mine !== run.current) return;
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) return fail('마이크 권한이 필요해요. 설정에서 마이크를 허용해 주세요');
    }
    try {
      const { token, model } = await getToken();
      if (mine === run.current) setPage({ html: livePage(token, model), run: mine });
    } catch (e) {
      if (mine === run.current) fail(userMessage(e, '음성 대화를 시작하지 못했어요'));
    }
  }

  const onPageMessage = (raw: unknown, from: number) => {
    if (from !== run.current) return; // 닫은 연결의 늦은 메시지
    const m = parseLiveMessage(raw);
    if (!m) return;
    if (m.type === 'live') {
      setPhase('live');
      listening.current = true;
      rearm(); // AI가 아직 말하지 않았어도 연결 순간부터 30초
    } else if (m.type === 'mic') {
      setMicMuted(m.muted);
      listening.current = !m.muted;
      rearm(); // AI가 말하는 동안 멈춤, 말이 끝나 다시 들으면 새 30초
    } else if (m.type === 'vad') idle.current = idleVad(idle.current, t(), m.active);
    else if (m.type === 'me' || m.type === 'ai') {
      const { type, text } = m;
      if (type === 'me') idle.current = idleHeard(idle.current, t());
      setLines((prev) => addLiveChunk(prev, type, text, now()));
    } else if (m.type === 'turn') {
      setLines(closeLive);
      flush();
    } else if (m.type === 'error') fail(m.code === 'MIC' ? '마이크를 쓸 수 없어요. 마이크 권한을 확인해 주세요' : '음성 연결에 실패했어요. 다시 시작해 주세요');
    else if (m.type === 'closed') {
      if (__DEV__) console.warn('Gemini Live closed', m.code, m.reason);
      fail('음성 연결이 끝났어요. 이어서 말하려면 다시 시작해 주세요');
    }
  };

  return {
    phase,
    error,
    micMuted,
    idleEnded,
    lines,
    start,
    stop: end,
    clear: () => setLines(() => []),
    // 글을 보내거나 입력 방식을 바꾸면 지난 음성 오류 · 무발화 종료 문구를 내림
    clearError: () => {
      setError(null);
      setIdleEnded(false);
    },
    frame: page ? <LiveFrame key={page.run} html={page.html} onMessage={(raw) => onPageMessage(raw, page.run)} sendRef={sendRef} /> : null,
  };
}
