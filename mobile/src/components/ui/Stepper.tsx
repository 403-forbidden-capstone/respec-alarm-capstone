import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { colors, size, typeScale } from '@/theme';

import { Text } from './Text';

type Props = {
  label: string;
  value: number;
  onChange: (next: number) => void;
  step?: number;
  min?: number;
  max?: number;
  unit?: string; // 값 뒤 글자 (예: "분")
  first?: boolean;
  typeable?: boolean; // 숫자를 눌러 직접 적기 (기본 켬)
  typeExact?: boolean; // 직접 적은 값은 step 칸에 맞추지 않고 범위 안에서 그대로 (분 [+]는 5분씩이어도 7분을 적을 수 있게)
  wrap?: boolean; // 끝에서 반대쪽으로 넘어감 (시 23→0, 분 59→0). 기본은 끝에서 멈춤
};

const REPEAT_SLOW = 160; // 길게 누르는 첫 1초 동안 간격(ms)
const REPEAT_FAST = 60; // 1초 뒤부터
const REPEAT_SWITCH = 1000;

type Range = { step: number; min: number; max: number; wrap: boolean };

// dir만큼 한 칸. 끝을 넘으면 wrap이면 반대쪽 끝으로, 아니면 끝에서 멈춤
function stepValue(value: number, dir: 1 | -1, { step, min, max, wrap }: Range) {
  const raw = value + dir * step;
  if (raw < min) return wrap ? min + Math.floor((max - min) / step) * step : min;
  if (raw > max) return wrap ? min : max;
  return raw;
}

// 직접 적은 값을 범위 안으로 넣고 step 칸에 맞춤 (분 5단위에 7을 적으면 5)
function snapValue(raw: number, { step, min, max }: Range) {
  const clamped = Math.min(max, Math.max(min, raw));
  const snapped = min + Math.round((clamped - min) / step) * step;
  return Math.min(max, Math.max(min, snapped));
}

// 숫자 줄이기 · 늘리기 (.stepper) — 준비 시간 · 여유 시간처럼 정해진 단위로 바꾸는 값
// −/+를 길게 누르면 계속 바뀌고(1초 뒤 더 빨라짐), 숫자를 누르면 직접 적을 수 있음
export function Stepper({ label, value, onChange, step = 5, min = 0, max = 600, unit = '', first, typeable = true, typeExact = false, wrap = false }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const range: Range = { step, min, max, wrap };

  // 길게 누르는 동안 쓰는 최신 값 — 타이머 안에서 옛 value를 읽지 않게
  const latest = useRef({ value, onChange, step, min, max, wrap });
  useEffect(() => {
    latest.current = { value, onChange, step, min, max, wrap };
  });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const start = (dir: 1 | -1) => {
    stop();
    const startedAt = Date.now();
    const tick = () => {
      const cur = latest.current;
      const next = stepValue(cur.value, dir, cur);
      if (next === cur.value) {
        stop();
        return;
      }
      cur.value = next;
      cur.onChange(next);
      timer.current = setTimeout(tick, Date.now() - startedAt > REPEAT_SWITCH ? REPEAT_FAST : REPEAT_SLOW);
    };
    tick();
  };

  const atMin = !wrap && value <= min;
  const atMax = !wrap && value >= max;

  function commit() {
    setEditing(false);
    const n = Number.parseInt(draft, 10);
    if (Number.isNaN(n)) return; // 비우거나 숫자가 아니면 그대로
    const next = typeExact ? Math.min(max, Math.max(min, n)) : snapValue(n, range);
    if (next !== value) onChange(next);
  }

  return (
    <View style={[styles.row, !first && styles.divider]}>
      <Text variant="body" tone="sub" style={styles.label}>
        {label}
      </Text>
      <View style={styles.controls}>
        <Pressable
          onPress={() => onChange(stepValue(value, -1, range))}
          onLongPress={() => start(-1)}
          onPressOut={stop}
          delayLongPress={400}
          disabled={atMin}
          accessibilityRole="button"
          accessibilityLabel={`${label} ${step}${unit} 줄이기`}
          style={styles.hit}
        >
          <View style={[styles.button, atMin && styles.disabled]}>
            <Text variant="body">−</Text>
          </View>
        </Pressable>
        {editing ? (
          <View style={styles.valueBox}>
            <TextInput
              value={draft}
              onChangeText={(t) => setDraft(t.replace(/[^0-9]/g, ''))}
              onBlur={commit}
              onSubmitEditing={commit}
              autoFocus
              placeholder={String(value)}
              placeholderTextColor={colors.faint}
              keyboardType="number-pad"
              returnKeyType="done"
              maxLength={String(max).length}
              accessibilityLabel={`${label} 직접 입력`}
              maxFontSizeMultiplier={1.3}
              style={styles.input}
            />
            {unit ? <Text variant="bodyStrong">{unit}</Text> : null}
          </View>
        ) : (
          <Pressable
            onPress={() => {
              setDraft(''); // 빈 칸에서 시작 — 기존 값 뒤에 이어 붙지 않게(지금 값은 placeholder로)
              setEditing(true);
            }}
            disabled={!typeable}
            accessibilityRole={typeable ? 'button' : 'text'}
            accessibilityLabel={typeable ? `${label} ${value}${unit}, 눌러서 직접 입력` : undefined}
            style={styles.valueBox}
          >
            <Text variant="bodyStrong" style={styles.value} accessibilityLiveRegion="polite">
              {value}
              {unit}
            </Text>
          </Pressable>
        )}
        <Pressable
          onPress={() => onChange(stepValue(value, 1, range))}
          onLongPress={() => start(1)}
          onPressOut={stop}
          delayLongPress={400}
          disabled={atMax}
          accessibilityRole="button"
          accessibilityLabel={`${label} ${step}${unit} 늘리기`}
          style={styles.hit}
        >
          <View style={[styles.button, atMax && styles.disabled]}>
            <Text variant="body">+</Text>
          </View>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 4 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  label: { fontSize: 13.5 },
  controls: { flexDirection: 'row', alignItems: 'center' },
  // 누르는 칸은 44 × 44, 보이는 단추는 그대로 36 × 32
  hit: { width: size.touch, height: size.touch, alignItems: 'center', justifyContent: 'center' },
  button: {
    width: 36,
    minHeight: 32,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  valueBox: { minWidth: 56, minHeight: size.touch, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  value: { minWidth: 48, textAlign: 'center', fontVariant: ['tabular-nums'], textDecorationLine: 'underline', textDecorationColor: colors.faint }, // 밑줄 = 눌러서 직접 적을 수 있음 (B-07)
  input: {
    ...typeScale.bodyStrong,
    width: 48,
    paddingVertical: 4,
    paddingHorizontal: 6,
    textAlign: 'center',
    color: colors.ink,
    borderBottomWidth: 1,
    borderBottomColor: colors.ink,
    fontVariant: ['tabular-nums'],
  },
  disabled: { opacity: 0.35 },
});
