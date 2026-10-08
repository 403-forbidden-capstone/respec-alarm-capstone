import { Pressable, StyleSheet, View } from 'react-native';

import { Text, Toggle } from '@/components/ui';
import { colors } from '@/theme';

import type { RoutineStep } from '../types';

type Props = {
  step: RoutineStep;
  time: string; // 21:30
  first?: boolean; // 첫 줄이면 위 구분선을 뺌
  onPress: () => void; // 단계 편집 열기
  onToggleAlarm: (on: boolean) => void;
};

// 루틴 단계 한 줄 (.rstep) — 시작 시각 · 이름 · 걸리는 시간 · 알람 스위치. 줄을 누르면 단계 편집
export function RoutineStepRow({ step, time, first, onPress, onToggleAlarm }: Props) {
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
      <Toggle value={step.alarm} onChange={onToggleAlarm} label={`${step.name} 알람`} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 12 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  main: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10 },
  time: { width: 48, fontVariant: ['tabular-nums'] },
  text: { flex: 1 },
  pressed: { opacity: 0.6 },
});
