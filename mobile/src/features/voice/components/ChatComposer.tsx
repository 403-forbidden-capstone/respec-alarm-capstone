import { useEffect, useState } from 'react';
import { Animated, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { Button, Text } from '@/components/ui';
import { colors, font } from '@/theme';

type Props = {
  status: string; // 듣고 있어요… · 말할 준비가 됐어요 등
  mode: 'voice' | 'text';
  canSay: boolean; // 내 차례이고 AI가 정리 중이 아님
  listening: boolean;
  text: string; // 글 모드 입력값
  onChangeText: (text: string) => void;
  onSend: () => void;
  onToggleMode: () => void;
  onSpeak: () => void;
  onDone: () => void;
};

// 대화 아래 입력 칸 (.composer) — 상태 한 줄 · 글 입력(글 모드) · 텍스트 / 말하기 / 완료
export function ChatComposer({ status, mode, canSay, listening, text, onChangeText, onSend, onToggleMode, onSpeak, onDone }: Props) {
  return (
    <View style={styles.box}>
      <Text variant="small" tone="sub" align="center" style={styles.status} accessibilityLiveRegion="polite">
        {status}
      </Text>
      {mode === 'text' && canSay ? (
        <View style={styles.inputRow}>
          <TextInput
            value={text}
            onChangeText={onChangeText}
            onSubmitEditing={onSend}
            returnKeyType="send"
            accessibilityLabel="보낼 메시지"
            placeholderTextColor={colors.faint}
            style={styles.input}
          />
          <Button label="보내기" small onPress={onSend} />
        </View>
      ) : null}
      <View style={styles.buttons}>
        <Pill label="텍스트" on={mode === 'text'} onPress={onToggleMode} />
        <MicButton listening={listening} disabled={!canSay} onPress={onSpeak} />
        <Pill label="완료" onPress={onDone} />
      </View>
    </View>
  );
}

function Pill({ label, on, onPress }: { label: string; on?: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={on != null ? { selected: on } : undefined}
      style={({ pressed }) => [styles.pill, on && styles.pillOn, pressed && styles.pressed]}
    >
      <Text variant="body" tone={on ? 'inverse' : 'ink'}>
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
        <Text variant="body" tone="inverse" weight={600} style={styles.micText}>
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
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  input: {
    ...font(400),
    fontSize: 14,
    flex: 1,
    minWidth: 0,
    height: 38,
    paddingVertical: 0,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 12,
    color: colors.ink,
  },
  buttons: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 16 },
  pill: { height: 38, paddingHorizontal: 16, borderRadius: 19, backgroundColor: colors.chip, justifyContent: 'center' },
  pillOn: { backgroundColor: colors.ink },
  micWrap: { width: MIC, height: MIC, alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', width: MIC, height: MIC, borderRadius: MIC / 2, backgroundColor: colors.ink },
  mic: { width: MIC, height: MIC, borderRadius: MIC / 2, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  micOff: { opacity: 0.3 },
  micText: { fontSize: 13 },
  pressed: { opacity: 0.75 },
});
