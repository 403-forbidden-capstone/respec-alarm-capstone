import { useEffect, useRef, useState } from 'react';
import { PermissionsAndroid, Platform } from 'react-native';

import { now } from '@/lib/clock';
import { userMessage } from '@/lib/errors';

import { LiveFrame } from '../components/LiveFrame';
import { livePage, parseLiveMessage } from '../live';
import { addLiveChunk, closeLive, type LiveLine } from '../liveChat';

const CONNECT_TIMEOUT_MS = 15000; // 이 안에 연결(setupComplete)이 안 되면 실패로 봄
const LIVE_MAX_MS = 10 * 60_000; // 한 번 연결의 최대 길이 — 서버 토큰 만료(supabase/functions/_shared/ai/live-token.ts LIVE_SESSION_MS)와 같게

export type LivePhase = 'idle' | 'connecting' | 'live';

// 실시간 음성 대화(Gemini Live) — start하면 마이크 권한을 묻고 토큰을 받아 연결, 말하면 AI가 목소리로 답함. stop하면 페이지를 내려 마이크 · 연결을 모두 닫음
//   말을 글로 바꾼 것(lines)은 AI 대화 화면이 말풍선으로 그림 (liveChat.mergeLive). 연결을 끝내도 lines는 남음 — clear로만 지움
//   frame(소리 페이지)은 화면 어디든 한 번 그려 두면 됨 (보이지 않음)
export function useLiveVoice(getToken: () => Promise<{ token: string; model: string }>) {
  const [phase, setPhase] = useState<LivePhase>('idle');
  const [page, setPage] = useState<string | null>(null);
  const [lines, setLines] = useState<LiveLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const run = useRef(0); // 시작 · 끝마다 늘림 — 토큰을 기다리는 사이 끝냈으면 늦게 온 토큰으로 연결하지 않게

  const end = () => {
    run.current++;
    setPage(null);
    setPhase('idle');
    setLines(closeLive); // 연결이 끝나면 임시 글도 확정
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
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  async function start() {
    const mine = ++run.current;
    setError(null);
    setPhase('connecting');
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.RECORD_AUDIO);
      if (mine !== run.current) return;
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) return fail('마이크 권한이 필요해요. 설정에서 마이크를 허용해 주세요');
    }
    try {
      const { token, model } = await getToken();
      if (mine === run.current) setPage(livePage(token, model));
    } catch (e) {
      if (mine === run.current) fail(userMessage(e, '음성 대화를 시작하지 못했어요'));
    }
  }

  const onPageMessage = (raw: unknown) => {
    const m = parseLiveMessage(raw);
    if (!m) return;
    if (m.type === 'live') setPhase('live');
    else if (m.type === 'me' || m.type === 'ai') {
      const { type, text } = m;
      setLines((prev) => addLiveChunk(prev, type, text, now()));
    } else if (m.type === 'turn') setLines(closeLive);
    else if (m.type === 'error') fail(m.code === 'MIC' ? '마이크를 쓸 수 없어요. 마이크 권한을 확인해 주세요' : '음성 연결에 실패했어요. 다시 시작해 주세요');
    else if (m.type === 'closed') {
      if (__DEV__) console.warn('Gemini Live closed', m.code, m.reason);
      fail('음성 연결이 끝났어요. 이어서 말하려면 다시 시작해 주세요');
    }
  };

  return {
    phase,
    error,
    lines,
    start,
    stop: end,
    clear: () => setLines([]),
    clearError: () => setError(null), // 글을 보내거나 입력 방식을 바꾸면 지난 음성 오류 문구를 내림
    frame: page ? <LiveFrame html={page} onMessage={onPageMessage} /> : null,
  };
}
