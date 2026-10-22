import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { confirm, LoadError, Loading, Screen, Text, toast, TopBar } from '@/components/ui';
import { finishConversation, getConversation, rejectFoundSchedule, saveFoundSchedule, say } from '@/features/voice/api';
import { ChatBubble, TypingBubble } from '@/features/voice/components/ChatBubble';
import { ChatComposer } from '@/features/voice/components/ChatComposer';
import { FoundScheduleCard } from '@/features/voice/components/FoundScheduleCard';
import { now } from '@/lib/clock';
import { userMessage } from '@/lib/errors';
import { useAction } from '@/lib/useAction';
import { useLoad } from '@/lib/useLoad';

const LISTEN_MS = 1100; // 말하기를 누른 뒤 듣는 시간 (목업 chatSpeak). AI가 답하는 시간은 api(say)가 기다림

// 03 AI 탭 · A02 AI 대화 — 자기 전 대화. AI 대기라 목업 대본대로 흘러감 (마이크 · 음성 합성 · 서버 호출 없음)
// 말하기 = 다음 대본 문장을 말한 것으로 침, 텍스트 = 빈 칸에 쓴 글을 그대로 보냄(AI 답은 대본). 일정을 찾으면 카드로 확인받고, 완료하면 하루 기록(A03)으로
export default function AiScreen() {
  const { data, error, reload } = useLoad(getConversation);
  const [mode, setMode] = useState<'voice' | 'text'>('voice');
  const [draftText, setDraftText] = useState(''); // 글 모드에 쓰는 글 — 말하기로 바꿔도 남음
  const [listening, setListening] = useState(false);
  const [thinking, setThinking] = useState(false); // 내 말을 보내고 AI 답을 기다리는 중
  const [pendingText, setPendingText] = useState<string | null>(null); // 보낸 내 말 — 답을 기다리는 동안 먼저 보여 줌
  const [pendingAt, setPendingAt] = useState<Date | null>(null); // 보낸 시각 — 렌더마다 now()가 바뀌지 않게 (실데이터 모드는 지금 시각)
  // 카드 저장 · 완료 같은 버튼은 한 번에 하나씩, 다시 읽기가 끝날 때까지 — 실패하면 토스트 (lib/useAction)
  const { busy, run: act } = useAction();
  const scroll = useRef<ScrollView>(null);

  const next = data?.next ?? null;
  const canSay = !listening && !thinking && next?.who === 'me';

  // 내 말을 보내고 AI 답까지 기다림 (api say가 한 번에 돌려줌). 보낼 글을 알면 답을 기다리는 동안 내 말을 먼저 그림(목업 userSay)
  // 실데이터에서 next에 대본 문장이 없고 글 모드도 아니면(음성) 보낼 글을 모르니 점 세 개만. 다시 읽은 뒤에 정리 표시를 내림
  async function talk(text?: string) {
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
  const { messages, found } = data;

  const status = listening
    ? '듣고 있어요…'
    : thinking
      ? 'AI가 정리하고 있어요'
      : canSay
        ? mode === 'text'
          ? '보낼 메시지를 입력해 주세요'
          : '말할 준비가 됐어요'
        : found?.status === 'PENDING'
          ? '찾은 일정을 확인해 주세요'
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

  // 완료 — 한 번 묻고 일기를 만들어 하루 기록으로. 내가 아직 한 마디도 안 했으면 완료를 막음 (빈 대화로 기록이 생기지 않게)
  const started = messages.some((m) => m.who === 'me');
  const finish = async () => {
    if (thinking) return; // 정리 중에 끝내면 끝난 대화에 답 · 카드가 붙음
    const ok = await confirm({ title: '대화를 마칠까요?', message: '지금까지 나눈 대화로 하루 기록을 만들어요.', okLabel: '완료' });
    if (!ok) return;
    await act(async () => {
      setListening(false);
      const { recordDate } = await finishConversation();
      router.push({ pathname: '/journal/[date]', params: { date: recordDate } });
    });
  };

  const saveFound = () =>
    act(async () => {
      const saved = await saveFoundSchedule();
      toast(`${saved.title} 알람을 맞췄어요`);
      await reload();
    });

  const rejectFound = () =>
    act(async () => {
      await rejectFoundSchedule();
      await reload();
    });

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
          {messages.map((m) =>
            m.who === 'card' ? (
              found ? (
                <FoundScheduleCard
                  key={m.id}
                  found={found}
                  at={m.at}
                  onSave={saveFound}
                  onEdit={() => router.push({ pathname: '/schedule/new', params: { from: 'chat' } })}
                  onReject={rejectFound}
                  disabled={busy}
                />
              ) : null
            ) : (
              <ChatBubble key={m.id} who={m.who} text={m.text} at={m.at} />
            ),
          )}
          {thinking && pendingText ? <ChatBubble who="me" text={pendingText} at={pendingAt ?? now()} /> : null}
          {thinking ? <TypingBubble /> : null}
        </View>
      </ScrollView>

      <View style={styles.composer}>
        <ChatComposer
          status={status}
          mode={mode}
          inputVisible={next?.who === 'me'}
          canSay={canSay}
          listening={listening}
          text={draftText}
          onChangeText={setDraftText}
          onSend={send}
          onToggleMode={toggleMode}
          onSpeak={speak}
          onDone={finish}
          doneDisabled={thinking || busy || !started}
        />
      </View>
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
