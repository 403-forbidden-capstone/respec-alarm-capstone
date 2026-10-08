import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, ScrollView, StyleSheet, View } from 'react-native';

import { Screen, Text, toast, TopBar } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { finishConversation, getConversation, rejectFoundSchedule, reply, saveFoundSchedule, say } from '@/features/voice/api';
import { ChatBubble, TypingBubble } from '@/features/voice/components/ChatBubble';
import { ChatComposer } from '@/features/voice/components/ChatComposer';
import { FoundScheduleCard } from '@/features/voice/components/FoundScheduleCard';
import { useLoad } from '@/lib/useLoad';

const LISTEN_MS = 1100; // 말하기를 누른 뒤 듣는 시간 (목업 chatSpeak)
const REPLY_MS = 800; // 내 말 뒤 AI가 답하기까지 (목업 userSay → aiTurn)

// 03 AI 탭 · A02 AI 대화 — 자기 전 대화. AI 대기라 목업 대본대로 흘러감 (마이크 · 음성 합성 · 서버 호출 없음)
// 말하기 = 다음 대본 문장을 말한 것으로 침, 텍스트 = 그 문장을 고쳐 보냄. 일정을 찾으면 카드로 확인받고, 완료하면 하루 기록(A03)으로
export default function AiScreen() {
  const { data, reload } = useLoad(getConversation);
  const [mode, setMode] = useState<'voice' | 'text'>('voice');
  const [draftText, setDraftText] = useState<string | null>(null); // 글 모드에서 고친 글 (null = 대본 문장 그대로)
  const [listening, setListening] = useState(false);
  const scroll = useRef<ScrollView>(null);

  const next = data?.next ?? null;
  const count = data?.messages.length ?? 0;
  const aiPending = next?.who === 'ai';
  const canSay = !listening && next?.who === 'me';

  // 말하기 — 잠깐 듣고 나서 내 말이 올라감. 화면을 떠나면 타이머를 지움
  useEffect(() => {
    if (!listening) return;
    const timer = setTimeout(async () => {
      await say();
      setListening(false);
      reload();
    }, LISTEN_MS);
    return () => clearTimeout(timer);
  }, [listening, reload]);

  // AI 차례면 잠깐 정리한 뒤 답함 — 화면을 떠났다 돌아와도 차례가 남아 있으면 다시 잡음
  useEffect(() => {
    if (!aiPending) return;
    const timer = setTimeout(async () => {
      await reply();
      reload();
    }, REPLY_MS);
    return () => clearTimeout(timer);
  }, [aiPending, count, reload]);

  if (!data) {
    return (
      <Screen>
        <TopBar screenId="A02" />
      </Screen>
    );
  }
  const { messages, found } = data;

  const status = listening
    ? '듣고 있어요…'
    : aiPending
      ? 'AI가 정리하고 있어요'
      : canSay
        ? '말할 준비가 됐어요'
        : found?.status === 'PENDING'
          ? '찾은 일정을 확인해 주세요'
          : '대화를 마치려면 완료를 눌러 주세요';

  function speak() {
    if (canSay) setListening(true);
  }

  async function send() {
    if (!canSay || next?.who !== 'me') return;
    await say(draftText ?? next.text);
    setDraftText(null);
    reload();
  }

  function toggleMode() {
    setMode((m) => (m === 'text' ? 'voice' : 'text'));
    setDraftText(null);
  }

  // 대화 종료 · 완료 — 일기를 만들고 하루 기록으로
  async function finish() {
    setListening(false);
    const { recordDate } = await finishConversation();
    router.push({ pathname: '/journal/[date]', params: { date: recordDate } });
  }

  async function saveFound() {
    const saved = await saveFoundSchedule();
    toast(`${saved.title} 알람을 맞췄어요`);
    reload();
  }

  async function rejectFound() {
    await rejectFoundSchedule();
    reload();
  }

  return (
    <Screen scroll={false} contentStyle={styles.screen}>
      <KeyboardAvoidingView behavior="padding" style={styles.fill}>
        <ScrollView
          ref={scroll}
          style={styles.fill}
          contentContainerStyle={styles.content}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}
        >
          <TopBar screenId="A02" right={<TextLink label="대화 종료" onPress={finish} />} />
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
                  />
                ) : null
              ) : (
                <ChatBubble key={m.id} who={m.who} text={m.text} at={m.at} />
              ),
            )}
            {aiPending && !listening ? <TypingBubble /> : null}
          </View>
        </ScrollView>

        <View style={styles.composer}>
          <ChatComposer
            status={status}
            mode={mode}
            canSay={canSay}
            listening={listening}
            text={draftText ?? (next?.who === 'me' ? next.text : '')}
            onChangeText={setDraftText}
            onSend={send}
            onToggleMode={toggleMode}
            onSpeak={speak}
            onDone={finish}
          />
        </View>
      </KeyboardAvoidingView>
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
