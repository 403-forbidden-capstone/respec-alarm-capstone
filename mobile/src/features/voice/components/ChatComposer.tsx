import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  Text as RNText,
  StyleSheet,
  TextInput,
  type TextInputKeyPressEventData,
  View,
} from 'react-native';

import { Button, Text } from '@/components/ui';
import { colors, typeScale } from '@/theme';
import { useAccent } from '@/lib/skyTone';

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
  micLabel?: string; // 말하기 버튼 글 (기본 "말하기") — 실데이터 음성 대화 중이면 "끝내기"
  micDisabled?: boolean; // 기본은 내 차례가 아니면 막음(!canSay). 실데이터 음성 대화는 글 대화와 따로 돌아 화면이 정함
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
  micLabel = '말하기',
  micDisabled,
}: Props) {
  const input = useRef<TextInput>(null);
  const sendable = canSay && text.trim().length > 0; // 빈 글 · 공백만은 못 보냄
  const [textHeight, setTextHeight] = useState(0); // 숨은 글로 잰 입력 글 높이

  function send() {
    if (!sendable) return;
    onSend();
    input.current?.focus(); // 버튼을 눌러도 키보드가 닫히지 않게
  }

  // 웹(react-native-web)은 여러 줄 칸에서 submitBehavior를 몰라 Enter가 줄바꿈이 됨 — Enter는 보내기, Shift+Enter · 한글 조합 중 Enter는 그대로
  function sendOnEnter(e: NativeSyntheticEvent<TextInputKeyPressEventData>) {
    const key = e.nativeEvent as unknown as KeyboardEvent; // 웹에선 DOM 키 이벤트
    if (key.key !== 'Enter' || key.shiftKey || key.isComposing) return;
    e.preventDefault();
    send();
  }

  return (
    <View style={styles.box}>
      <Text variant="small" tone="sub" align="center" style={styles.status} accessibilityLiveRegion="polite">
        {status}
      </Text>
      {mode === 'text' && inputVisible ? (
        <View style={styles.inputRow}>
          <View style={styles.inputWrap}>
            {/* 높이 재기용 숨은 글 — 웹 textarea는 글이 늘어도 스스로 커지지 않아서, 같은 너비 · 글꼴로 줄 수를 재 칸 높이로 씀.
                keepWords(어절 단위)가 칸과 다르게 줄을 바꾸므로 공용 Text 대신 RN Text */}
            <RNText
              aria-hidden
              importantForAccessibility="no-hide-descendants"
              accessibilityElementsHidden
              pointerEvents="none"
              maxFontSizeMultiplier={1.3}
              onLayout={(e) => setTextHeight(e.nativeEvent.layout.height)}
              style={[styles.inputText, styles.measure]}
            >
              {!text || text.endsWith('\n') ? `${text} ` : text}
            </RNText>
            <TextInput
              ref={input}
              value={text}
              onChangeText={onChangeText}
              multiline // 칸 너비를 넘으면 줄바꿈 — 높이는 위 숨은 글로 잼
              scrollEnabled
              onSubmitEditing={send}
              onKeyPress={Platform.OS === 'web' ? sendOnEnter : undefined}
              submitBehavior="submit"
              returnKeyType="send"
              placeholder="메시지를 입력하세요"
              accessibilityLabel="보낼 메시지"
              maxLength={1000} // 서버가 받는 한 말의 최대 글자 수 (voice-turn MAX_TEXT_CHARS)
              placeholderTextColor={colors.faint}
              maxFontSizeMultiplier={1.3}
              style={[styles.inputText, styles.input, { height: Math.min(Math.max(textHeight + INPUT_CHROME, 38), INPUT_MAX) }]}
            />
          </View>
          <View>
            {/* 작은 Button은 스스로 위에 붙어서(alignSelf) 한 겹 싸야 줄의 아래 맞춤을 따름 */}
            <Button label="보내기" small onPress={send} disabled={!sendable} />
          </View>
        </View>
      ) : null}
      <View style={styles.buttons}>
        <Pill label="텍스트" on={mode === 'text'} onPress={onToggleMode} />
        <MicButton label={micLabel} listening={listening} disabled={micDisabled ?? !canSay} onPress={onSpeak} />
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
function MicButton({ label, listening, disabled, onPress }: { label: string; listening: boolean; disabled: boolean; onPress: () => void }) {
  const accent = useAccent(); // 포인트 색 — 그 시각 하늘과 같은 계열 (lib/skyTone)
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
            [styles.ring, { backgroundColor: accent }],
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
        accessibilityLabel={label}
        accessibilityState={{ disabled, busy: listening }}
        style={({ pressed }) => [[styles.mic, { backgroundColor: accent }], disabled && !listening && styles.micOff, pressed && styles.pressed]}
      >
        <Text variant="note" tone="inverse" weight={600}>
          {label}
        </Text>
      </Pressable>
    </View>
  );
}

const MIC = 58;
const INPUT_LINES = 5; // 입력칸이 늘어나는 최대 줄 수
const INPUT_PAD = 8; // 한 줄(20) + 여백 8×2 + 테두리 1×2 = 38 — 보내기 버튼과 같게
const INPUT_BORDER = 1;
const INPUT_CHROME = (INPUT_PAD + INPUT_BORDER) * 2; // 글 높이 밖 위아래 여백 · 테두리
const INPUT_MAX = INPUT_CHROME + typeScale.body.lineHeight * INPUT_LINES; // 넘으면 칸 안에서 세로 스크롤

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
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, marginBottom: 10 }, // 칸이 늘어나도 보내기는 아래 줄에 붙어 있게
  inputWrap: { flex: 1, minWidth: 0 },
  // 칸과 숨은 글이 같이 쓰는 글꼴 · 가로 여백 — 둘이 같은 자리에서 줄이 바뀌어야 높이가 맞음
  inputText: { ...typeScale.body, paddingHorizontal: 12, borderWidth: INPUT_BORDER, borderColor: colors.line },
  input: { paddingTop: INPUT_PAD, paddingBottom: INPUT_PAD, textAlignVertical: 'top', borderRadius: 12, color: colors.ink },
  measure: { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0, paddingVertical: 0, borderTopWidth: 0, borderBottomWidth: 0 }, // 가로 테두리는 남겨 칸과 너비를 맞추고, 잰 높이엔 글만
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
