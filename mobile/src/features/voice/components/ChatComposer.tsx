import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Button, Text } from '@/components/ui';
import { colors, typeScale } from '@/theme';

type Props = {
  status: string; // 듣고 있어요… · 말할 준비가 됐어요 등
  mode: 'voice' | 'text';
  inputVisible: boolean; // 글 입력칸을 보임 — 내 차례가 남은 동안은 AI가 답하는 중에도 두어서 키보드가 닫히지 않게
  canSay: boolean; // 내 차례이고 AI가 정리 중이 아님
  listening: boolean;
  text: string; // 글 모드 입력값 (처음엔 빈칸)
  onChangeText: (text: string) => void;
  onSend: () => void;
  onToggleMode: () => void;
  onSpeak: () => void;
  onDone: () => void;
  doneDisabled?: boolean; // AI가 정리 중이면 완료를 막음 — 끝난 대화에 답 · 카드가 붙지 않게
  textOnly?: boolean; // 실데이터 대화 — 글로만. 텍스트 · 말하기 버튼을 숨기고 "키보드 마이크로 말해도 돼요" 한 줄
};

// 대화 아래 입력 칸 (.composer) — 상태 한 줄 · 글 입력(글 모드) · 텍스트 / 말하기 / 완료
export function ChatComposer({
  status,
  mode,
  inputVisible,
  canSay,
  listening,
  text,
  onChangeText,
  onSend,
  onToggleMode,
  onSpeak,
  onDone,
  doneDisabled,
  textOnly,
}: Props) {
  const input = useRef<TextInput>(null);
  const sendable = canSay && text.trim().length > 0; // 빈 글 · 공백만은 못 보냄

  function send() {
    if (!sendable) return;
    onSend();
    input.current?.focus(); // 버튼을 눌러도 키보드가 닫히지 않게
  }

  return (
    <View style={styles.box}>
      <Text variant="small" tone="sub" align="center" style={styles.status} accessibilityLiveRegion="polite">
        {status}
      </Text>
      {mode === 'text' && inputVisible ? (
        <View style={styles.inputRow}>
          <TextInput
            ref={input}
            value={text}
            onChangeText={onChangeText}
            onSubmitEditing={send}
            submitBehavior="submit"
            returnKeyType="send"
            placeholder="메시지를 입력하세요"
            accessibilityLabel="보낼 메시지"
            maxLength={1000} // 서버가 받는 한 말의 최대 글자 수 (voice-turn MAX_TEXT_CHARS)
            placeholderTextColor={colors.faint}
            maxFontSizeMultiplier={1.3}
            style={styles.input}
          />
          <Button label="보내기" small onPress={send} disabled={!sendable} />
        </View>
      ) : null}
      {textOnly && inputVisible ? (
        <Text variant="caption" tone="faint" align="center" style={styles.hint}>
          키보드 마이크로 말해도 돼요
        </Text>
      ) : null}
      <View style={styles.buttons}>
        {textOnly ? null : <Pill label="텍스트" on={mode === 'text'} onPress={onToggleMode} />}
        {textOnly ? null : <MicButton listening={listening} disabled={!canSay} onPress={onSpeak} />}
        <Pill label="완료" onPress={onDone} disabled={doneDisabled} />
      </View>
    </View>
  );
}

// 알약 버튼 — 켜짐(글 모드)은 흰 바탕에 검은 테두리로, 검은 원(말하기)과 구분. 모양은 38, 누르는 칸은 hitSlop 3을 더해 44
function Pill({ label, on, disabled, onPress }: { label: string; on?: boolean; disabled?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={3}
      accessibilityRole="button"
      accessibilityState={on != null ? { selected: on, disabled } : { disabled }}
      style={({ pressed }) => [styles.pill, on && styles.pillOn, disabled && styles.pillOff, pressed && styles.pressed]}
    >
      <Text variant="body" weight={on ? 600 : 400}>
        {label}
      </Text>
    </Pressable>
  );
}

// 말하기 (.mic) — 듣는 동안 테두리가 퍼짐 (.mic.listen)
function MicButton({ listening, disabled, onPress }: { listening: boolean; disabled: boolean; onPress: () => void }) {
  const [pulse] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!listening) return;
    pulse.setValue(0);
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1000, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [listening, pulse]);

  return (
    <View style={styles.micWrap}>
      {listening ? (
        <Animated.View
          style={[
            styles.ring,
            {
              opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.3, 0] }),
              transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.4] }) }],
            },
          ]}
        />
      ) : null}
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel="말하기"
        accessibilityState={{ disabled, busy: listening }}
        style={({ pressed }) => [styles.mic, disabled && !listening && styles.micOff, pressed && styles.pressed]}
      >
        <Text variant="note" tone="inverse" weight={600}>
          말하기
        </Text>
      </Pressable>
    </View>
  );
}

const MIC = 58;

const styles = StyleSheet.create({
  box: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 26,
    paddingTop: 12,
    paddingHorizontal: 16,
    paddingBottom: 14,
    boxShadow: `0 10px 30px -18px ${colors.shadow}40`,
  },
  status: { marginBottom: 8 },
  hint: { marginBottom: 10 },
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  input: {
    ...typeScale.body,
    flex: 1,
    minWidth: 0,
    minHeight: 38,
    paddingVertical: 0,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    color: colors.ink,
  },
  buttons: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16 },
  pill: { minHeight: 38, paddingHorizontal: 16, borderRadius: 19, borderWidth: 1, borderColor: colors.chip, backgroundColor: colors.chip, justifyContent: 'center' },
  pillOn: { backgroundColor: colors.card, borderColor: colors.ink },
  pillOff: { opacity: 0.4 },
  micWrap: { width: MIC, height: MIC, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: MIC, height: MIC, borderRadius: MIC / 2, backgroundColor: colors.ink },
  mic: { width: MIC, height: MIC, borderRadius: MIC / 2, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  micOff: { opacity: 0.3 },
  pressed: { opacity: 0.75 },
});
