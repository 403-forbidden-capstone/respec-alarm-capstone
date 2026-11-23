import { router, useFocusEffect } from 'expo-router';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { confirm, LoadError, Loading, Screen, Text, toast, TopBar } from '@/components/ui';
import { listPlaces } from '@/features/alarm/api';
import { PlaceSearchSheet } from '@/features/alarm/components/PlaceSearchSheet';
import { homeOf } from '@/features/alarm/placeSheet';
import { useAuth } from '@/features/auth/AuthProvider';
import { applySuggestion, getPendingSuggestion, ignoreSuggestion } from '@/features/records/api';
import { SuggestionPromptCard } from '@/features/records/components/SuggestionPromptCard';
import { getPendingRoutineSuggestion, ignoreRoutineSuggestion } from '@/features/routine/api';
import { RoutinePromptCard } from '@/features/routine/components/RoutinePromptCard';
import { SkyTone } from '@/features/sky/components/SkyBackdrop';
import { useSky } from '@/features/sky/hooks/useSky';
import type { RoutineSuggestion } from '@/features/routine/types';
import { previewTimes } from '@/features/records/suggestion';
import type { Suggestion } from '@/features/records/types';
import { endLiveVoice, finishConversation, getConversation, getLiveToken, pickCardPlace, rejectCard, retryConversation, saveCard, saveCardWithoutPlace, say, sayVoice } from '@/features/voice/api';
import { ChatBubble, TypingBubble } from '@/features/voice/components/ChatBubble';
import { ChatComposer } from '@/features/voice/components/ChatComposer';
import { noticeCopy } from '@/features/voice/chatNotice';
import { ChatNotice } from '@/features/voice/components/ChatNotice'; // L5 부품 — 실패 · 한도 안내
import { FoundScheduleCard } from '@/features/voice/components/FoundScheduleCard';
import { useLiveVoice } from '@/features/voice/hooks/useLiveVoice';
import { askPrompt, heardSchedule, isNearBottom, mergeLive, mightBeSchedule, type ChatRow } from '@/features/voice/liveChat';
import type { Conversation, TurnNotice } from '@/features/voice/types';
import { now } from '@/lib/clock';
import { formatTime } from '@/lib/format';
import { userMessage } from '@/lib/errors';
import { backOrHome } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { useLoad } from '@/lib/useLoad';

// 추출(T2F) 결과 전 — 아직 일정인지 모르므로 '만들고 있어요'라고 하지 않음 (추출이 실패해도 성공처럼 보였음, 11/12)
const SCHEDULE_CHECKING = '일정이 있는지 확인하고 있어요...';
// 추출이 일정을 찾아 카드가 생긴 뒤 알람을 계산하는 동안만
const CARD_DRAFTING = '일정 카드를 만들고 있어요...';
// 카드 하나에서 도는 일의 단계 — 실제 처리 단계(api의 진행 알림)에 맞춰 바뀜
const CARD_STEP = {
  save: '일정을 저장하고 있어요...',
  place: '장소를 확인하고 있어요...',
  estimate: '기상·준비·출발 시간을 계산하고 있어요...',
} as const;
// 일정일 수도 있는 말을 일정으로 정리하지 못한 까닭 — 모른 채 같은 말을 되풀이하지 않게 짧게 알림 (일반 대화면 알리지 않음)
const MISSED: Record<'LIMIT' | 'BUSY' | TurnNotice, string> = {
  LIMIT: '오늘 대화 한도에 닿아 더 이상 일정으로 정리되지 않아요. 일정은 직접 만들거나 내일 새 대화에서 말해 주세요.',
  BUSY: '앞의 요청이 실패해 방금 말은 정리되지 않았어요. [다시 시도]를 먼저 눌러 주세요.',
  // 추출이 실패하면 그 말이 일정이었는지 모름 — 일정이라고 단정하지 않음 (할 일 · 생활 기록은 [완료] 정리가 따로 챙김)
  RATE_LIMITED: 'AI 요청이 몰려 방금 한 말에서 일정을 찾지 못했어요. 일정이었다면 잠시 뒤 한 번 더 말해 주세요.',
  EXTRACT_FAILED: '방금 한 말에서 일정을 찾지 못했어요. 일정이었다면 한 번 더 말해 주세요.',
};
const explain = (text: string, why: keyof typeof MISSED | null | undefined) => {
  if (why && mightBeSchedule(text)) toast(MISSED[why]);
};
const LISTEN_MS = 1100; // 말하기를 누른 뒤 듣는 시간 (목업 chatSpeak). AI가 답하는 시간은 api(say)가 기다림

// 03 AI 탭 · A02 AI 대화 — 자기 전 대화
// 가짜 데이터: 목업 대본대로 흘러감 (마이크 · 음성 합성 · 서버 호출 없음). 말하기 = 다음 대본 문장을 말한 것으로 침, 텍스트 = 빈 칸에 쓴 글을 그대로 보냄(AI 답은 대본). 완료하면 하루 기록(A03)으로
// 실데이터: 글(서버 voice-session · voice-turn)과 실시간 음성(Gemini Live, [말하기])을 한 대화 목록에. 음성은 한 차례(내 말 + Live 답)가 끝나면 같은 서버 대화에 남아(voice-turn spoken_reply) 글과 문맥 · 일정 카드 흐름을 함께 씀 — 못 남긴 말풍선만 화면에 남음. 일정 · 알람을 찾으면 카드가 여러 장 떠서 [저장] · [바꾸기] · [저장 안 함]으로 확인받고, 완료하면 하루 기록을 정리하고 이전 화면(홈)으로 — 같은 날 다시 열면 같은 대화(말 · 카드)가 이어지고, 날짜가 바뀌면 새 대화
//   서버가 답하지 못하면(LLM_UNAVAILABLE · NOT_CONFIGURED …) 대화 · 카드는 두고 마지막 말풍선 아래에 ChatNotice failed(분당 사용량이면 busy), 한도에 닿으면(limits.reached) ChatNotice limit(하루) · turn(대화 길이) — 입력창은 막음
// 30초 무발화로 음성 대화가 끝났을 때 — 저장을 시작했다는 것까지만 (끝났는지는 하루 기록 화면에서 봄)
const IDLE_ENDED = '말이 없어 음성 대화를 마쳤어요. 하루 기록 저장을 시작했어요';

export default function AiScreen() {
  const sky = useSky(); // 위쪽 하늘 배경 — 홈과 같은 날씨 × 시간대
  const { data, error, reload: reloadNow } = useLoad(getConversation);
  // [완료]로 나간 뒤에는 끝나지 않은 저장 · 답이 다시 읽기를 걸어도 새 세션을 열지 않음 — 다시 들어올 때(포커스)만 읽음 (그건 useLoad가 함)
  const leftRef = useRef(false);
  // 말 하나를 처리하는 도중의 대화 (api say · sayVoice의 onProgress) — 카드 계산 중 · 계산 끝 카드를 안내 답보다 먼저 그림. 끝나고 다시 읽으면 비움
  const [progress, setProgress] = useState<Conversation | null>(null);
  // 보낸 말 중 일정일 수도 있는 것(mightBeSchedule)의 수 — 추출(T2F) 결과가 오기 전부터 "일정이 있는지 확인하고 있어요..."를 띄움.
  //   추출이 일정을 찾으면(progress) 카드 자리의 임시 말풍선이 이어받고, 아니면 · 실패하면 그 말 처리가 끝날 때 내림
  const [drafting, setDrafting] = useState(0);
  const draft = async <T,>(text: string | undefined, task: () => Promise<T>): Promise<T> => {
    const maybe = !!text && mightBeSchedule(text);
    if (maybe) setDrafting((n) => n + 1);
    try {
      return await task();
    } finally {
      if (maybe) setDrafting((n) => n - 1);
    }
  };
  // 실시간 음성 대화 — 실데이터만 씀. 한 차례가 끝나면 같은 대화에 남기고(일정이면 카드까지) 다시 읽음
  const live = useLiveVoice(getLiveToken, (heard, spoken, ask) => draft(heard, async () => {
    try {
      const r = await sayVoice(heard, spoken, setProgress);
      if (r.kept && !leftRef.current) await reloadNow();
      explain(heard, r.reason ?? r.notice);
      // 일정에서 아직 모르는 것(날짜 · 시각 · 이름) — 열려 있는 Live 연결에 넣어 Live가 소리로 되물음 (글 질문 · T1 호출 없음). 연결이 끝났으면 글로 짧게
      if (r.ask?.length && !ask(askPrompt(r.ask))) toast(`알려 주세요: ${r.ask.join(', ')}`);
      return r.kept;
    } catch (e) {
      toast(userMessage(e, '음성 대화를 대화 기록에 남기지 못했어요'));
      return false;
    } finally {
      setProgress(null);
    }
  }), {
    // 30초 무발화로 음성 대화가 끝남 — 마지막 차례(sayVoice)는 훅이 먼저 넘겼고, 정리는 api가 그 뒤에 차례로 적음 ([완료]와 같은 길, 실패하면 다음 열기 · 새벽 4시에 다시)
    //   화면에 머묾: 같은 날 대화가 다시 읽혀 이어 말할 수 있음. 내가 한 마디도 안 했으면 정리하지 않음(finishConversation)
    //   저장 결과는 기다리지 않음(정리는 서버가 이어서 함) — 시작했다는 것만 알리고 성공했다고는 말하지 않음
    onIdle: () => {
      toast(IDLE_ENDED);
      finishConversation()
        .then(() => reload())
        .catch(() => {});
    },
    // 카드 저장 · 장소 계산 · 글 답 · 일정 확인 중에는 끝내지 않음
    isBusy: () => busy || !!work || thinkingRef.current || drafting > 0,
  });
  // 통화가 끝나면 붙잡은 대화방을 놓음 — 03:59에 시작한 통화는 끝날 때까지 전날 방, 끝난 뒤 새 대화는 새 기준일 방 (마지막 차례 저장 뒤에 풀림)
  useEffect(() => {
    if (live.phase === 'idle') void endLiveVoice();
  }, [live.phase]);
  const stopLive = useRef(live.stop);
  useEffect(() => {
    stopLive.current = live.stop;
  });
  useFocusEffect(
    useCallback(() => {
      leftRef.current = false;
      return () => stopLive.current(); // 화면을 떠나면 마이크 · 연결을 닫음 (탭 화면은 내려가지 않고 남아 있어서)
    }, []),
  );
  const reload = async () => {
    if (!leftRef.current) await reloadNow();
  };
  const [mode, setMode] = useState<'voice' | 'text'>('voice');
  const [draftText, setDraftText] = useState(''); // 글 모드에 쓰는 글 — 말하기로 바꿔도 남음
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false); // 내 말을 보내고 AI 답을 기다리는 중
  const [pendingText, setPendingText] = useState<string | null>(null); // 보낸 내 말 — 답을 기다리는 동안 먼저 보여 줌
  const [pendingAt, setPendingAt] = useState<Date | null>(null); // 보낸 시각 — 렌더마다 now()가 바뀌지 않게 (실데이터 모드는 지금 시각)
  const [placeCardId, setPlaceCardId] = useState<string | null>(null); // [장소 고르기]를 누른 카드 — 장소 검색 시트
  const [work, setWork] = useState<{ id: string; step: keyof typeof CARD_STEP } | null>(null); // 카드에서 도는 저장 · 장소 · 계산 — 도는 동안 카드 버튼을 막음(중복 저장 · 선택 막기)
  const [cardFail, setCardFail] = useState<{ id: string; message: string | null; retry: () => void } | null>(null); // 카드의 저장 · 계산 실패 — 카드에 까닭 + [다시 시도]
  const home = homeOf(useAuth().profile); // 집 좌표 — 있으면 장소 검색을 가까운 순으로
  // 카드 저장 · 완료 같은 버튼은 한 번에 하나씩, 다시 읽기가 끝날 때까지 — 실패하면 토스트 (lib/useAction)
  const { busy, run: act } = useAction();
  // 알람 조정 제안 — 저녁 대화에서 카드로 묻기 (안건 D111 5번). 대화(AI) 쪽과 따로 records api로 읽고 처리(대화 서버 상태는 안 건드림)
  //   들어올 때마다 대기 중인 제안을 다시 읽고, 못 읽으면 카드 없이 대화만
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [suggestionDone, setSuggestionDone] = useState<string | null>(null);
  // 루틴 제안 (안건 D114) — 알람 조정 제안 카드 아래. [루틴 만들기]는 루틴 편집에 초안을 채워 엶
  const [routineSuggestion, setRoutineSuggestion] = useState<RoutineSuggestion | null>(null);
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      getPendingSuggestion()
        .then((s) => {
          if (!alive) return;
          setSuggestion(s);
          setSuggestionDone(null);
        })
        .catch(() => {});
      getPendingRoutineSuggestion()
        .then((s) => {
          if (alive) setRoutineSuggestion(s);
        })
        .catch(() => {});
      return () => {
        alive = false;
      };
    }, []),
  );
  const applyPrompt = (s: Suggestion) =>
    act(async () => {
      await applySuggestion(s.id, s.minutes);
      const after = previewTimes(s, s.minutes);
      setSuggestionDone(after.prepare ? `다음 회차부터 준비 알람이 ${formatTime(after.prepare)}에 울려요` : `기상 알람이 ${formatTime(after.wake)}에 울려요`);
    }, '제안을 적용하지 못했어요');
  const ignoreRoutinePrompt = (s: RoutineSuggestion) =>
    act(async () => {
      await ignoreRoutineSuggestion(s.id);
      setRoutineSuggestion(null);
      toast('기록이 3일 더 쌓이면 다시 볼 수 있어요');
    }, '제안을 넘기지 못했어요');
  const ignorePrompt = (s: Suggestion) =>
    act(async () => {
      await ignoreSuggestion(s.id);
      setSuggestion(null);
      toast('같은 제안은 당분간 다시 보이지 않아요');
    }, '제안을 넘기지 못했어요');
  const scroll = useRef<ScrollView>(null);
  const atBottom = useRef(true); // 맨 아래 근처를 보고 있음 — 이때만 새 말에 맞춰 내림 (위를 읽는 중이면 그대로)
  const thinkingRef = useRef(false); // 정리 중인지 — 확인창이 떠 있는 사이 바뀐 값을 읽어야 해서 렌더 값(thinking) 말고 ref로도 둠

  const next = data?.next ?? null;
  const real = data?.source === 'REAL'; // 서버 대화 — 글로만, 완료는 홈으로
  const canSay = !listening && !thinking && next?.who === 'me';

  // 내 말을 보내고 AI 답까지 기다림 (api say가 한 번에 돌려줌). 보낼 글을 알면 답을 기다리는 동안 내 말을 먼저 그림(목업 userSay)
  // 실데이터에서 next에 대본 문장이 없고 글 모드도 아니면(음성) 보낼 글을 모르니 점 세 개만. 다시 읽은 뒤에 정리 표시를 내림
  async function talk(text?: string) {
    thinkingRef.current = true;
    live.clearError();
    atBottom.current = true; // 내가 보냈으면 맨 아래로
    setPendingText(text?.trim() || (next?.who === 'me' ? next.text : null));
    setPendingAt(now());
    setThinking(true);
    try {
      const c = await draft(text, () => say(text, setProgress));
      if (text) explain(text, c.notice);
    } catch (e) {
      toast(userMessage(e, '말을 보내지 못했어요'));
      if (text) setDraftText((d) => d || text); // 못 보냈으면 쓴 글을 되돌려 놓음
    } finally {
      await reload();
      setProgress(null);
      setThinking(false);
      setPendingText(null);
      thinkingRef.current = false;
    }
  }

  // [다시 시도] — 서버가 답하지 못한 요청을 같은 것으로 다시 보냄 (대화 · 카드는 그대로)
  async function retry() {
    if (thinkingRef.current) return;
    thinkingRef.current = true;
    setPendingText(null);
    setThinking(true);
    try {
      await retryConversation();
    } catch (e) {
      toast(userMessage(e, '다시 시도하지 못했어요'));
    } finally {
      await reload();
      setThinking(false);
      thinkingRef.current = false;
    }
  }

  // 말하기 — 잠깐 듣고 나서 보냄. 화면을 떠나면 타이머를 지움
  useEffect(() => {
    if (!listening) return;
    const timer = setTimeout(() => {
      setListening(false);
      talk();
    }, LISTEN_MS);
    return () => clearTimeout(timer);
    // talk는 렌더마다 새로 만들어지지만 듣기가 시작될 때 한 번만 걸면 됨
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listening]);

  if (!data) {
    return (
      <Screen backdrop={<SkyTone kind={sky.kind} phase={sky.phase} />}>
        <TopBar screenId="A02" />
        {error ? <LoadError onRetry={reload} /> : <Loading />}
      </Screen>
    );
  }
  const { messages, cards, unavailable, limits } = progress ?? data;
  const cardOf = (id?: string) => cards.find((c) => c.id === id);
  const reached = limits?.reached ?? null;
  // 안내 종류 — 사용량 제한(busy) · 일정 정리 못 함(extract, 말이 저장 안 됨) · 시간 초과(timeout) · 그 밖의 실패(failed) / 대화 길이(turn) · 하루 사용량(limit)
  const failKind = unavailable?.rateLimited ? 'busy' : unavailable?.extractFailed ? 'extract' : unavailable?.timedOut ? 'timeout' : 'failed';
  const limitKind = reached === 'TURN' ? 'turn' : 'limit';
  const waiting = cards.some((c) => c.status === 'READY' || c.status === 'NEEDS_PLACE' || c.status === 'NEEDS_ESTIMATE' || c.status === 'ESTIMATING');
  const textMode = mode === 'text';
  const placeCard = cardOf(placeCardId ?? undefined);
  const liveOn = real && live.phase !== 'idle';
  const rows: ChatRow[] = real ? mergeLive(messages, live.lines) : messages; // 글 대화 + 음성 말풍선, 시각 순서

  // 음성이 켜져 있는 동안만 음성 상태가 앞. 지난 음성 오류는 글 대화 상태(답하는 중 · 실패 · 한도)보다 뒤 — 그 상태들을 가리지 않게
  const liveStatus = !real ? null : live.phase === 'connecting' ? '음성 대화를 연결하고 있어요…' : live.phase === 'live' ? (live.micMuted ? 'AI가 말하고 있어요. 끝나면 자동으로 다시 들어요' : '듣고 있어요. 편하게 말해 보세요') : null;
  const status = liveStatus
    ? liveStatus
    : work
    ? CARD_STEP[work.step]
    : listening
    ? '듣고 있어요…'
    : thinking
      ? real
        ? 'AI가 답하고 있어요'
        : 'AI가 정리하고 있어요'
      : unavailable
        ? noticeCopy(failKind).title
        : reached
          ? noticeCopy(limitKind).title
          : real && live.error
            ? live.error
            : real && live.idleEnded
            ? IDLE_ENDED
            : canSay
            ? textMode
              ? '보낼 메시지를 입력해 주세요'
              : '말할 준비가 됐어요'
            : waiting
              ? '찾은 내용을 확인해 주세요'
              : '대화를 마치려면 완료를 눌러 주세요';

  // 말하기 — 가짜: 대본 한 문장을 들은 것으로. 실데이터: 실시간 음성 대화를 켜고 끔 (켜져 있는 동안 계속 주고받음)
  function speak() {
    if (real) {
      if (liveOn) return live.stop();
      atBottom.current = true;
      return void live.start();
    }
    if (canSay) setListening(true);
  }

  // 쓴 글을 그대로 보냄 — 빈 글은 보내지 않음
  function send() {
    const typed = draftText.trim();
    if (!canSay || !typed) return;
    setDraftText('');
    talk(typed);
  }

  function toggleMode() {
    live.clearError();
    setMode((m) => (m === 'text' ? 'voice' : 'text'));
  }

  // 완료 — 가짜: 한 번 묻고 일기를 만들어 하루 기록으로. 내가 아직 한 마디도 안 했으면 완료를 막음 (빈 대화로 기록이 생기지 않게)
  // 실데이터: 이전 화면(홈)으로 — 같은 날 다시 열면 같은 대화가 이어짐. 하루 기록 정리(할 일 · 준비물 · 생활 기록 · 일기)는 api가 서버 voice-commit으로 기다리지 않고 보냄 (다시 완료하면 새 말까지)
  // 정리 중에 끝내면 끝난 대화에 답 · 카드가 붙으므로, 확인창 앞뒤로 두 번 봄 (확인창이 떠 있는 사이 글 모드 보내기로 정리가 시작될 수 있음)
  const started = messages.some((m) => m.who === 'me');
  const finish = async () => {
    if (thinkingRef.current) return;
    setListening(false); // 듣는 중이면 멈춤 — 확인창이 떠 있는 사이 듣기 타이머가 터져 말을 보내지 않게
    if (real) {
      // 카드 저장 · 장소 계산이 AI 답을 기다리는 동안(busy)에도 눌려야 함 — 막으면 첫 탭이 먹통. 끝남 표시는 api가 앞 요청 뒤에 차례로 적음
      leftRef.current = true;
      live.stop();
      live.clear(); // 서버에 남긴 음성 차례는 다시 열 때 대화로 돌아옴 — 못 남긴 화면용 말풍선만 지움
      finishConversation().catch(() => {}); // 로컬에 적는 일이라 실패해도 이동은 그대로
      backOrHome();
      return;
    }
    const ok = await confirm({ title: '대화를 마칠까요?', message: '지금까지 나눈 대화로 하루 기록을 만들어요.', okLabel: '완료' });
    if (!ok || thinkingRef.current) return;
    await act(async () => {
      const { recordDate } = await finishConversation();
      if (recordDate) router.push({ pathname: '/journal/[date]', params: { date: recordDate } });
      else backOrHome();
    });
  };

  // 카드 저장 · 바꾸기 — 누르는 즉시 "일정을 저장하고 있어요...", 성공하면 토스트("일정이 저장됐어요"), 실패하면 카드에 까닭 + [다시 시도]. 어느 쪽이든 카드 상태를 다시 읽음
  //   두 번 누름은 useAction(act) · 카드 버튼 막기 · saveCard(이미 저장한 카드 거절)가 막음
  //   withoutPlace = [장소 없이 저장] — 장소를 확인 못 한 새 일정을 알람 없이 (실패하면 같은 버튼으로 다시)
  const saveFound = (cardId: string, withoutPlace = false): Promise<void> =>
    act(async () => {
      setCardFail(null);
      setWork({ id: cardId, step: 'save' });
      try {
        toast(await (withoutPlace ? saveCardWithoutPlace(cardId) : saveCard(cardId)));
      } catch (e) {
        setCardFail({ id: cardId, message: userMessage(e, '일정을 저장하지 못했어요'), retry: () => void saveFound(cardId, withoutPlace) });
      } finally {
        setWork(null);
        await reload();
      }
    });

  const rejectFound = (cardId: string) =>
    act(async () => {
      await rejectCard(cardId);
      await reload();
    });

  // 장소 시트에서 고름 — "장소를 확인하고 있어요..." → (api가 장소를 정하면) "기상·준비·출발 시간을 계산하고 있어요..." → 카드에 결과.
  //   계산 결과는 서버 안내 답을 기다리지 않고 바로 보임(api 진행 알림). 계산이 실패하면 카드에 까닭 + [다시 시도](같은 장소로)
  const pickPlace = async (cardId: string, place: { name: string; lat?: number; lng?: number }): Promise<void> => {
    setPlaceCardId(null);
    if (work) return; // 다른 카드 일이 도는 중 — 겹쳐 고르지 않음
    const retryPlace = () => void pickPlace(cardId, place);
    setCardFail(null);
    setWork({ id: cardId, step: 'place' });
    try {
      const result = await pickCardPlace(
        cardId,
        place,
        (c) => {
          setProgress(c);
          setWork(c.cards.find((x) => x.id === cardId)?.status === 'ESTIMATING' ? { id: cardId, step: 'estimate' } : null);
        },
        // 음성 대화 중이면 계산 뒤 되물을 것(할 일이 있는 일정의 기상 확인)을 Live가 소리로 물음 — 연결이 없으면 ask가 false(글 대화는 화면의 AI 답이 물음)
        //   누른 때의 live.phase가 아니라 지금 연결을 봄 (계산 중에 음성 대화를 켜거나 꺼도 맞게)
        (ask) => void live.ask(askPrompt(ask)),
      );
      if (result === 'FAILED') setCardFail({ id: cardId, message: null, retry: retryPlace }); // 까닭은 카드의 error
    } catch (e) {
      setCardFail({ id: cardId, message: userMessage(e, '장소로 계산하지 못했어요'), retry: retryPlace });
    } finally {
      setWork(null);
      await reload();
      setProgress(null);
    }
  };

  // 대화 한 줄 — 말풍선이나 카드 (아래 rows.map)
  const rowView = (m: ChatRow) => {
    if (m.who !== 'card') return <ChatBubble key={m.id} who={m.who} text={m.text} at={m.at} interim={m.interim} />;
    const card = cardOf(m.cardId);
    if (!card) return null;
    // 말을 처리하는 도중 앱이 알람을 계산하는 카드 — 카드 대신 임시 말풍선 (끝나면 같은 자리가 카드로 바뀜, 실패하면 카드가 오류 안내)
    //   처리가 끝났는데 계산 전으로 남은 카드(오류 뒤)는 임시 말풍선으로 두지 않고 카드 그대로
    if ((progress || thinking) && (card.status === 'NEEDS_ESTIMATE' || card.status === 'ESTIMATING') && work?.id !== card.id) {
      return <ChatBubble key={m.id} who="ai" text={CARD_DRAFTING} at={m.at} />;
    }
    const appointmentId = card.appointmentId;
    const step = work?.id === card.id ? work.step : null;
    const fail = cardFail?.id === card.id ? cardFail : null;
    return (
      <FoundScheduleCard
        key={m.id}
        card={card}
        at={m.at}
        onSave={() => saveFound(card.id)}
        onEdit={real ? undefined : () => router.push({ pathname: '/schedule/new', params: { from: 'chat' } })}
        onReject={() => rejectFound(card.id)}
        onPickPlace={() => setPlaceCardId(card.id)}
        onSaveWithoutPlace={real ? () => saveFound(card.id, true) : undefined}
        onOpen={appointmentId ? () => router.push({ pathname: '/alarm/[id]', params: { id: appointmentId } }) : undefined}
        onManual={() => router.push('/schedule/new')}
        disabled={busy || thinking || !!work}
        working={step ? CARD_STEP[step] : null}
        saving={step === 'save'}
        failure={fail?.message ?? null}
        onRetry={fail?.retry}
      />
    );
  };

  return (
    // 키보드를 피하는 일은 Screen이 맡음 (채팅 목록 + 아래 입력 칸 전체를 밀어 올림)
    <Screen scroll={false} contentStyle={styles.screen} backdrop={<SkyTone kind={sky.kind} phase={sky.phase} />}>
      <ScrollView
        ref={scroll}
        style={styles.fill}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        scrollEventThrottle={16}
        onScroll={(e) => {
          atBottom.current = isNearBottom(e.nativeEvent);
        }}
        onContentSizeChange={() => {
          if (atBottom.current) scroll.current?.scrollToEnd({ animated: true });
        }}
      >
        <TopBar screenId="A02" />
        <Text variant="title" style={styles.title}>
          하루를 돌아봐요
        </Text>
        <Text variant="lead">기본 AI · 차분한 코치</Text>

        <View style={styles.chat} accessibilityLiveRegion="polite">
          {rows.map((m, i) => (
            <Fragment key={m.id}>
              {rowView(m)}
              {/* 알람 조정 제안 — 대화 첫 마디 바로 아래 (안건 D111 5번) */}
              {i === 0 && suggestion ? (
                <SuggestionPromptCard
                  suggestion={suggestion}
                  applied={suggestionDone}
                  busy={busy}
                  onApply={() => applyPrompt(suggestion)}
                  onIgnore={() => ignorePrompt(suggestion)}
                  onOpen={() => router.push({ pathname: '/suggestion/[id]', params: { id: suggestion.id } })}
                />
              ) : null}
              {/* 루틴 제안 — 알람 조정 제안 아래 (안건 D114 4번) */}
              {i === 0 && routineSuggestion ? (
                <RoutinePromptCard
                  suggestion={routineSuggestion}
                  busy={busy}
                  onCreate={() => router.push({ pathname: '/routine/[id]', params: { id: 'new', suggestion: routineSuggestion.id } })}
                  onIgnore={() => ignoreRoutinePrompt(routineSuggestion)}
                />
              ) : null}
            </Fragment>
          ))}
          {thinking && pendingText && !progress ? <ChatBubble who="me" text={pendingText} at={pendingAt ?? now()} /> : null}
          {/* 추출 전 — 일정일 수도 있는 말이면 점 세 개 대신 임시 말풍선 (추출이 일정을 찾으면 카드 자리가 이어받음). Live는 내 말이 확정된 순간부터(차례 끝 전) */}
          {(drafting > 0 || (real && heardSchedule(live.lines))) && !progress ? <ChatBubble who="ai" text={SCHEDULE_CHECKING} at={pendingAt ?? now()} /> : thinking ? <TypingBubble /> : null}
          {unavailable && !thinking ? (
            <ChatNotice kind={failKind} onRetry={unavailable.canRetry ? retry : undefined} onManual={() => router.push('/schedule/new')} onDone={finish} busy={busy} />
          ) : null}
          {reached && !unavailable ? <ChatNotice kind={limitKind} onManual={() => router.push('/schedule/new')} onDone={finish} busy={busy} /> : null}
        </View>
      </ScrollView>

      <View style={styles.composer}>
        {/* 실시간 음성 대화(Gemini Live)의 소리 페이지 — 보이지 않음 */}
        {live.frame}
        <ChatComposer
          status={status}
          mode={textMode ? 'text' : 'voice'}
          inputVisible={next?.who === 'me'}
          canSay={canSay}
          listening={real ? liveOn : listening}
          micLabel={liveOn ? '끝내기' : undefined}
          micDisabled={real ? false : undefined}
          text={draftText}
          onChangeText={setDraftText}
          onSend={send}
          onToggleMode={toggleMode}
          onSpeak={speak}
          onDone={finish}
          doneDisabled={thinking || listening || (!real && (busy || !started))}
        />
      </View>
      <PlaceSearchSheet
        visible={placeCard != null}
        onClose={() => setPlaceCardId(null)}
        onPick={(place) => placeCard && pickPlace(placeCard.id, place)}
        search={(query) => listPlaces(query || placeCard?.place || undefined, home)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  screen: { paddingBottom: 12 },
  fill: { flex: 1 },
  content: { flexGrow: 1, paddingBottom: 8 },
  title: { marginTop: 8, marginBottom: 4 },
  chat: { flexGrow: 1, justifyContent: 'flex-end', gap: 10, paddingTop: 18 },
  composer: { paddingTop: 10, gap: 10 },
});
