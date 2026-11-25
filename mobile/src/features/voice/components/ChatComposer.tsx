import { SymbolView, type SymbolViewProps } from 'expo-symbols';
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

import { Text } from '@/components/ui';
import { colors, typeScale } from '@/theme';
import { useAccent } from '@/lib/skyTone';

export type VoiceState = 'idle' | 'listening' | 'speaking';

type Props = {
  notice?: string | null; // 알릴 일이 있을 때만 한 줄 (카드 계산 중 · 실패 · 한도 등)
  mode: 'voice' | 'text';
  onToggleMode: () => void;
  // 음성 모드
  voice: VoiceState; // 파형 · 마이크 아래 글: 말하기 / 듣고 있어요 / AI가 말하고 있어요
  micOn?: boolean; // 음성 대화가 켜져 있음 — 마이크를 다시 누르면 끝냄
  micDisabled: boolean;
  onSpeak: () => void;
  // 글 모드
  inputVisible: boolean; // 글을 쓸 수 있음 — 내 차례가 남은 동안은 AI가 답하는 중에도 두어서 키보드가 닫히지 않게
  canSay: boolean; // 내 차례이고 AI가 정리 중이 아님
  text: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
};

const VOICE_LABEL: Record<VoiceState, string> = { idle: '말하기', listening: '듣고 있어요', speaking: 'AI가 말하고 있어요' };

// 대화 아래 입력 칸 — 음성 모드(키보드 · 파형 · 큰 마이크)와 글 모드(마이크 · 입력칸 · 보내기)
export function ChatComposer(p: Props) {
  return (
    <View style={[styles.box, p.mode === 'voice' && styles.boxVoice]}>
      {p.notice ? (
        <Text variant="small" tone="sub" align="center" style={styles.notice} accessibilityLiveRegion="polite">
          {p.notice}
        </Text>
      ) : null}
      {p.mode === 'voice' ? <VoiceRow {...p} /> : <TextRow {...p} />}
    </View>
  );
}

function VoiceRow({ voice, micOn, micDisabled, onSpeak, onToggleMode }: Props) {
  const accent = useAccent();
  return (
    <View style={styles.voiceRow}>
      <View style={styles.center} pointerEvents="box-none">
        <View style={styles.micLine}>
          <Wave state={voice} />
          <View style={styles.micWrap}>
            {/* 마이크 둘레 — 포인트 색을 옅게 깐 원 + 테두리. 기본에도 은은하게, 듣거나 말하는 중엔 조금 짙게 */}
            <View style={[styles.halo, { backgroundColor: accent, opacity: voice === 'idle' ? 0.14 : 0.22 }]} />
            <View style={[styles.halo, styles.haloRing, { borderColor: accent, opacity: voice === 'idle' ? 0.3 : 0.5 }]} />
            <Pressable
              onPress={onSpeak}
              disabled={micDisabled}
              accessibilityRole="button"
              accessibilityLabel={micOn ? '음성 대화 끝내기' : '말하기'}
              accessibilityState={{ disabled: micDisabled, busy: voice !== 'idle' }}
              style={({ pressed }) => [styles.mic, { backgroundColor: accent }, micDisabled && voice === 'idle' && styles.off, pressed && styles.pressed]}
            >
              <SymbolView name={{ ios: 'mic.fill', android: 'mic', web: 'mic' }} size={26} tintColor={colors.inverse} />
            </Pressable>
          </View>
          <Wave state={voice} mirror />
        </View>
        <Text variant="small" tone="sub" weight={600} accessibilityLiveRegion="polite">
          {VOICE_LABEL[voice]}
        </Text>
      </View>
      {/* 가운데 칸(flex 1) 뒤에 그려야 위에 놓여 눌림 */}
      <RoundButton icon={{ ios: 'keyboard', android: 'keyboard', web: 'keyboard' }} label="글로 쓰기" onPress={onToggleMode} style={styles.side} />
    </View>
  );
}

function TextRow({ inputVisible, canSay, text, onChangeText, onSend, onToggleMode }: Props) {
  const accent = useAccent();
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
    <View style={styles.textRow}>
      <RoundButton icon={{ ios: 'mic', android: 'mic', web: 'mic' }} label="말로 하기" onPress={onToggleMode} />
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
          editable={inputVisible}
          multiline // 칸 너비를 넘으면 줄바꿈 — 높이는 위 숨은 글로 잼, 보낸 뒤 빈칸이면 한 줄로
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
          style={[styles.inputText, styles.input, { height: Math.min(Math.max(textHeight + INPUT_CHROME, BTN), INPUT_MAX) }]}
        />
      </View>
      <RoundButton
        icon={{ ios: 'arrow.up', android: 'arrow_upward', web: 'arrow_upward' }}
        label="보내기"
        onPress={send}
        disabled={!sendable}
        fill={accent}
      />
    </View>
  );
}

// 둥근 아이콘 버튼 (44) — fill이 있으면 포인트 색으로 채움(보내기)
function RoundButton({ icon, label, onPress, disabled, fill, style }: { icon: SymbolViewProps['name']; label: string; onPress: () => void; disabled?: boolean; fill?: string; style?: object }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.round, fill ? { backgroundColor: fill, borderColor: fill } : null, disabled && styles.off, pressed && styles.pressed, style]}
    >
      <SymbolView name={icon} size={22} tintColor={fill ? colors.inverse : colors.ink} />
    </Pressable>
  );
}

// 마이크 옆 파형 — 기본은 낮게 멈춤, 듣는 중 · AI가 말하는 중에는 막대가 오르내림
const BARS = [0.45, 0.8, 1, 0.65, 0.4];
function Wave({ state, mirror }: { state: VoiceState; mirror?: boolean }) {
  const accent = useAccent();
  const [t] = useState(() => new Animated.Value(0));
  const moving = state !== 'idle';

  useEffect(() => {
    if (!moving) return;
    const loop = Animated.loop(Animated.timing(t, { toValue: 1, duration: state === 'speaking' ? 700 : 1000, useNativeDriver: true }));
    loop.start();
    return () => {
      loop.stop();
      t.setValue(0);
    };
  }, [moving, state, t]);

  const bars = mirror ? [...BARS].reverse() : BARS;
  return (
    <View style={styles.wave} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {bars.map((h, i) => (
        <Animated.View
          key={i}
          style={[
            styles.bar,
            { backgroundColor: accent, opacity: moving ? 0.85 : 0.3 },
            {
              transform: [
                {
                  // 짝 · 홀 막대가 엇갈려 오르내림
                  scaleY: moving ? t.interpolate({ inputRange: [0, 0.5, 1], outputRange: i % 2 ? [h, h * 0.35, h] : [h * 0.35, h, h * 0.35] }) : 0.25,
                },
              ],
            },
          ]}
        />
      ))}
    </View>
  );
}

const BTN = 44; // 둥근 버튼 · 한 줄 입력칸 높이
const MIC = 54;
const HALO = 64; // 마이크 둘레 원 — 음성 칸 높이 112 → 94
const INPUT_LINES = 5; // 입력칸이 늘어나는 최대 줄 수
const INPUT_BORDER = 1;
const INPUT_PAD = (BTN - typeScale.body.lineHeight) / 2 - INPUT_BORDER; // 한 줄일 때 칸 높이 = 버튼(44)
const INPUT_CHROME = (INPUT_PAD + INPUT_BORDER) * 2; // 글 높이 밖 위아래 여백 · 테두리
const INPUT_MAX = INPUT_CHROME + typeScale.body.lineHeight * INPUT_LINES; // 넘으면 칸 안에서 세로 스크롤

const styles = StyleSheet.create({
  box: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 26,
    paddingVertical: 12,
    paddingHorizontal: 12,
    boxShadow: `0 10px 30px -18px ${colors.shadow}40`,
  },
  notice: { marginBottom: 8 },
  voiceRow: { flexDirection: 'row', alignItems: 'center' },
  side: { position: 'absolute', left: 0 }, // 키보드 버튼은 왼쪽, 마이크는 칸 한가운데
  boxVoice: { paddingVertical: 6 }, // 음성 모드는 낮게 — 글 모드 여백(12)은 그대로
  center: { flex: 1, alignItems: 'center' }, // 마이크 원 바로 아래 글
  micLine: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  micWrap: { width: HALO, height: HALO, alignItems: 'center', justifyContent: 'center' },
  halo: { position: 'absolute', width: HALO, height: HALO, borderRadius: HALO / 2 },
  haloRing: { borderWidth: 1.5 },
  mic: { width: MIC, height: MIC, borderRadius: MIC / 2, alignItems: 'center', justifyContent: 'center' },
  wave: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 28 },
  bar: { width: 3, height: 28, borderRadius: 1.5 },
  textRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 }, // 칸이 늘어나도 양쪽 버튼은 아래 줄에 붙어 있게
  round: {
    width: BTN,
    height: BTN,
    borderRadius: BTN / 2,
    borderWidth: 1,
    borderColor: colors.chip,
    backgroundColor: colors.chip,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inputWrap: { flex: 1, minWidth: 0 },
  // 칸과 숨은 글이 같이 쓰는 글꼴 · 가로 여백 — 둘이 같은 자리에서 줄이 바뀌어야 높이가 맞음
  inputText: { ...typeScale.body, paddingHorizontal: 16, borderWidth: INPUT_BORDER, borderColor: colors.line },
  input: { paddingTop: INPUT_PAD, paddingBottom: INPUT_PAD, textAlignVertical: 'top', borderRadius: BTN / 2, color: colors.ink },
  measure: { position: 'absolute', left: 0, right: 0, top: 0, opacity: 0, paddingVertical: 0, borderTopWidth: 0, borderBottomWidth: 0 }, // 가로 테두리는 남겨 칸과 너비를 맞추고, 잰 높이엔 글만
  off: { opacity: 0.35 },
  pressed: { opacity: 0.75 },
});
