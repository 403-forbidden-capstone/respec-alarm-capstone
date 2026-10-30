import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { confirm, LoadError, Loading, Screen, Text, toast, TopBar } from '@/components/ui';
import { listPlaces } from '@/features/alarm/api';
import { PlaceSearchSheet } from '@/features/alarm/components/PlaceSearchSheet';
import { homeOf } from '@/features/alarm/placeSheet';
import { useAuth } from '@/features/auth/AuthProvider';
import { finishConversation, getConversation, pickCardPlace, rejectCard, retryConversation, saveCard, say } from '@/features/voice/api';
import { ChatBubble, TypingBubble } from '@/features/voice/components/ChatBubble';
import { ChatComposer } from '@/features/voice/components/ChatComposer';
import { ChatNotice } from '@/features/voice/components/ChatNotice'; // L5 부품 — 실패 · 한도 안내
import { FoundScheduleCard } from '@/features/voice/components/FoundScheduleCard';
import { now } from '@/lib/clock';
import { userMessage } from '@/lib/errors';
import { backOrHome } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { useLoad } from '@/lib/useLoad';

const LISTEN_MS = 1100; // 말하기를 누른 뒤 듣는 시간 (목업 chatSpeak). AI가 답하는 시간은 api(say)가 기다림

// 03 AI 탭 · A02 AI 대화 — 자기 전 대화
// 가짜 데이터: 목업 대본대로 흘러감 (마이크 · 음성 합성 · 서버 호출 없음). 말하기 = 다음 대본 문장을 말한 것으로 침, 텍스트 = 빈 칸에 쓴 글을 그대로 보냄(AI 답은 대본). 완료하면 하루 기록(A03)으로
// 실데이터: 글로만 대화(서버 voice-session · voice-turn). 일정 · 알람을 찾으면 카드가 여러 장 떠서 [저장] · [바꾸기] · [저장 안 함]으로 확인받고, 완료하면 대화를 남긴 채 이전 화면(홈)으로
//   서버가 답하지 못하면(LLM_UNAVAILABLE · NOT_CONFIGURED …) 대화 · 카드는 두고 마지막 말풍선 아래에 ChatNotice failed, 한도에 닿으면(limits.reached) ChatNotice limit — 입력창은 막음
export default function AiScreen() {
  const { data, error, reload } = useLoad(getConversation);
  const [mode, setMode] = useState<'voice' | 'text'>('voice');
  const [draftText, setDraftText] = useState(''); // 글 모드에 쓰는 글 — 말하기로 바꿔도 남음
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false); // 내 말을 보내고 AI 답을 기다리는 중
  const [pendingText, setPendingText] = useState<string | null>(null); // 보낸 내 말 — 답을 기다리는 동안 먼저 보여 줌
  const [pendingAt, setPendingAt] = useState<Date | null>(null); // 보낸 시각 — 렌더마다 now()가 바뀌지 않게 (실데이터 모드는 지금 시각)
  const [placeCardId, setPlaceCardId] = useState<string | null>(null); // [장소 고르기]를 누른 카드 — 장소 검색 시트
  const home = homeOf(useAuth().profile); // 집 좌표 — 있으면 장소 검색을 가까운 순으로
  // 카드 저장 · 완료 같은 버튼은 한 번에 하나씩, 다시 읽기가 끝날 때까지 — 실패하면 토스트 (lib/useAction)
  const { busy, run: act } = useAction();
  const scroll = useRef<ScrollView>(null);
  const thinkingRef = useRef(false); // 정리 중인지 — 확인창이 떠 있는 사이 바뀐 값을 읽어야 해서 렌더 값(thinking) 말고 ref로도 둠

  const next = data?.next ?? null;
  const real = data?.source === 'REAL'; // 서버 대화 — 글로만, 완료는 홈으로
  const canSay = !listening && !thinking && next?.who === 'me';

  // 내 말을 보내고 AI 답까지 기다림 (api say가 한 번에 돌려줌). 보낼 글을 알면 답을 기다리는 동안 내 말을 먼저 그림(목업 userSay)
  // 실데이터에서 next에 대본 문장이 없고 글 모드도 아니면(음성) 보낼 글을 모르니 점 세 개만. 다시 읽은 뒤에 정리 표시를 내림
  async function talk(text?: string) {
    thinkingRef.current = true;
    setPendingText(text?.trim() || (next?.who === 'me' ? next.text : null));
    setPendingAt(now());
    setThinking(true);
    try {
      await say(text);
    } catch (e) {
      toast(userMessage(e, '말을 보내지 못했어요'));
      if (text) setDraftText((d) => d || text); // 못 보냈으면 쓴 글을 되돌려 놓음
    } finally {
      await reload();
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
      <Screen>
        <TopBar screenId="A02" />
        {error ? <LoadError onRetry={reload} /> : <Loading />}
      </Screen>
    );
  }
  const { messages, cards, unavailable, limits } = data;
  const cardOf = (id?: string) => cards.find((c) => c.id === id);
  const reached = limits?.reached ?? null;
  const waiting = cards.some((c) => c.status === 'READY' || c.status === 'NEEDS_PLACE' || c.status === 'NEEDS_ESTIMATE' || c.status === 'ESTIMATING');
  const textMode = real || mode === 'text';
  const placeCard = cardOf(placeCardId ?? undefined);

  const status = listening
    ? '듣고 있어요…'
    : thinking
      ? real
        ? 'AI가 답하고 있어요'
        : 'AI가 정리하고 있어요'
      : unavailable
        ? 'AI가 답하지 못했어요'
        : reached
          ? '오늘 대화는 여기까지예요'
          : canSay
            ? textMode
              ? '보낼 메시지를 입력해 주세요'
              : '말할 준비가 됐어요'
            : waiting
              ? '찾은 내용을 확인해 주세요'
              : '대화를 마치려면 완료를 눌러 주세요';

  function speak() {
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
    setMode((m) => (m === 'text' ? 'voice' : 'text'));
  }

  // 완료 — 가짜: 한 번 묻고 일기를 만들어 하루 기록으로. 내가 아직 한 마디도 안 했으면 완료를 막음 (빈 대화로 기록이 생기지 않게)
  // 실데이터: 대화를 그대로 남기고 이전 화면(홈)으로 — 대화 끝 정리(할 일 · 준비물)는 서버의 대화 끝 함수가 생긴 뒤
  // 정리 중에 끝내면 끝난 대화에 답 · 카드가 붙으므로, 확인창 앞뒤로 두 번 봄 (확인창이 떠 있는 사이 글 모드 보내기로 정리가 시작될 수 있음)
  const started = messages.some((m) => m.who === 'me');
  const finish = async () => {
    if (thinkingRef.current) return;
    setListening(false); // 듣는 중이면 멈춤 — 확인창이 떠 있는 사이 듣기 타이머가 터져 말을 보내지 않게
    if (real) {
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

  // 카드 저장 · 바꾸기 — 실패하면 토스트(이유는 UserError일 때만), 어느 쪽이든 카드 상태를 다시 읽음
  const saveFound = (cardId: string) =>
    act(async () => {
      try {
        toast(await saveCard(cardId));
      } finally {
        await reload();
      }
    }, '저장하지 못했어요');

  const rejectFound = (cardId: string) =>
    act(async () => {
      await rejectCard(cardId);
      await reload();
    });

  // 장소 시트에서 고름 — 그 장소로 카드를 다시 계산
  const pickPlace = (cardId: string, place: { name: string; lat?: number; lng?: number }) => {
    setPlaceCardId(null);
    return act(async () => {
      try {
        await pickCardPlace(cardId, place);
      } finally {
        await reload();
      }
    }, '장소로 계산하지 못했어요');
  };

  return (
    // 키보드를 피하는 일은 Screen이 맡음 (채팅 목록 + 아래 입력 칸 전체를 밀어 올림)
    <Screen scroll={false} contentStyle={styles.screen}>
      <ScrollView
        ref={scroll}
        style={styles.fill}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
      >
        <TopBar screenId="A02" />
        <Text variant="title" style={styles.title}>
          하루를 돌아봐요
        </Text>
        <Text variant="lead">기본 AI · 차분한 코치</Text>

        <View style={styles.chat} accessibilityLiveRegion="polite">
          {messages.map((m) => {
            if (m.who !== 'card') return <ChatBubble key={m.id} who={m.who} text={m.text} at={m.at} />;
            const card = cardOf(m.cardId);
            if (!card) return null;
            const appointmentId = card.appointmentId;
            return (
              <FoundScheduleCard
                key={m.id}
                card={card}
                at={m.at}
                onSave={() => saveFound(card.id)}
                onEdit={real ? undefined : () => router.push({ pathname: '/schedule/new', params: { from: 'chat' } })}
                onReject={() => rejectFound(card.id)}
                onPickPlace={() => setPlaceCardId(card.id)}
                onOpen={appointmentId ? () => router.push({ pathname: '/alarm/[id]', params: { id: appointmentId } }) : undefined}
                onManual={() => router.push('/schedule/new')}
                disabled={busy || thinking}
              />
            );
          })}
          {thinking && pendingText ? <ChatBubble who="me" text={pendingText} at={pendingAt ?? now()} /> : null}
          {thinking ? <TypingBubble /> : null}
          {unavailable && !thinking ? (
            <ChatNotice kind="failed" onRetry={unavailable.canRetry ? retry : undefined} onManual={() => router.push('/schedule/new')} onDone={finish} busy={busy} />
          ) : null}
          {reached && !unavailable ? <ChatNotice kind="limit" onManual={() => router.push('/schedule/new')} onDone={finish} busy={busy} /> : null}
        </View>
      </ScrollView>

      <View style={styles.composer}>
        <ChatComposer
          status={status}
          mode={textMode ? 'text' : 'voice'}
          textOnly={real}
          inputVisible={next?.who === 'me'}
          canSay={canSay}
          listening={listening}
          text={draftText}
          onChangeText={setDraftText}
          onSend={send}
          onToggleMode={toggleMode}
          onSpeak={speak}
          onDone={finish}
          doneDisabled={thinking || listening || busy || (!real && !started)}
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
  composer: { paddingTop: 10 },
});
