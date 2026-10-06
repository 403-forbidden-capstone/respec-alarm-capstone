import { useEffect, useRef } from 'react';
import { Animated, Pressable, StyleSheet } from 'react-native';

import { colors, size } from '@/theme';

type Props = {
  value: boolean;
  onChange: (next: boolean) => void;
  label: string; // 화면 읽기용 이름 (예: "팀 주간회의 알람")
  disabled?: boolean;
};

const KNOB = 22;
const TRAVEL = size.switchW - KNOB - 6;

// 켜기 · 끄기 스위치 (.sw) — 기본 Switch 대신 목업 모양으로
export function Toggle({ value, onChange, label, disabled }: Props) {
  const x = useRef(new Animated.Value(value ? TRAVEL : 0)).current;

  useEffect(() => {
    Animated.timing(x, { toValue: value ? TRAVEL : 0, duration: 180, useNativeDriver: true }).start();
  }, [value, x]);

  return (
    <Pressable
      onPress={() => onChange(!value)}
      disabled={disabled}
      hitSlop={8}
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      style={[styles.track, { backgroundColor: value ? colors.ink : colors.switchOff }, disabled && styles.disabled]}
    >
      <Animated.View style={[styles.knob, { transform: [{ translateX: x }] }]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  track: { width: size.switchW, height: size.switchH, borderRadius: size.switchH / 2, padding: 3 },
  knob: { width: KNOB, height: KNOB, borderRadius: KNOB / 2, backgroundColor: colors.card },
  disabled: { opacity: 0.4 },
});
