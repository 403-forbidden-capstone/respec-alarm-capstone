import { Pressable, StyleSheet, View } from 'react-native';

import { Text, Toggle } from '@/components/ui';
import { colors, size } from '@/theme';

import type { RoutineStep } from '../types';

type Props = {
  step: RoutineStep;
  time: string; // 21:30
  first?: boolean; // 첫 줄이면 위 구분선을 뺌
  canUp: boolean; // 한 칸 위로 옮길 수 있는지 (맨 위면 false)
  canDown: boolean;
  onPress: () => void; // 단계 편집 열기
  onMove: (by: -1 | 1) => void; // ▲ ▼
  onToggleAlarm: (on: boolean) => void;
};

// 루틴 단계 한 줄 (.rstep) — 시작 시각 · 이름 · 걸리는 시간 · ▲▼ 순서 · 알람 스위치. 줄을 누르면 단계 편집
export function RoutineStepRow({ step, time, first, canUp, canDown, onPress, onMove, onToggleAlarm }: Props) {
  return (
    <View style={[styles.row, !first && styles.divider]}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`${time} ${step.name} 단계 편집`}
        style={({ pressed }) => [styles.main, pressed && styles.pressed]}
      >
        <Text variant="note" weight={600} style={styles.time}>
          {time}
        </Text>
        <View style={styles.text}>
          <Text variant="bodyStrong">{step.name}</Text>
          <Text variant="caption" tone="faint">
            {step.minutes}분 · 알람 {step.alarm ? '있음' : '없음'}
          </Text>
        </View>
      </Pressable>
      <View style={styles.arrows}>
        <Arrow glyph="▲" label={`${step.name} 위로 옮기기`} disabled={!canUp} onPress={() => onMove(-1)} />
        <Arrow glyph="▼" label={`${step.name} 아래로 옮기기`} disabled={!canDown} onPress={() => onMove(1)} />
      </View>
      <Toggle value={step.alarm} onChange={onToggleAlarm} label={`${step.name} 알람`} />
    </View>
  );
}

// 순서 옮기기 버튼 — 모양은 작게, 누르는 칸은 44 × 44
function Arrow({ glyph, label, disabled, onPress }: { glyph: string; label: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.arrow, disabled && styles.arrowOff, pressed && styles.pressed]}
    >
      <Text variant="note" tone="sub">
        {glyph}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: size.touch },
  time: { width: 44, fontVariant: ['tabular-nums'] },
  text: { flex: 1 },
  arrows: { flexDirection: 'row' },
  arrow: { width: size.touch, height: size.touch, alignItems: 'center', justifyContent: 'center' },
  arrowOff: { opacity: 0.3 },
  pressed: { opacity: 0.6 },
});
