import { StyleSheet, View } from 'react-native';

import { Button, DayPicker, Text } from '@/components/ui';
import type { Weekday } from '@/lib/weekday';
import { colors } from '@/theme';

import { EVERY_DAY, repeatLabel, sameDays, toggleWeekday, WEEKDAYS_ONLY } from '../repeat';

type Props = {
  value: readonly Weekday[]; // 반복 요일 — 비어 있으면 반복 없음
  onChange: (next: Weekday[]) => void;
};

// 일정 반복 고르기 (H05 · D44) — 요일 칩(루틴 반복 요일과 같은 부품) + 매일 · 평일 빠른 선택
// 빠른 선택을 한 번 더 누르면 끔. 요일을 하나도 안 고르면 반복 없음
export function RepeatPicker({ value, onChange }: Props) {
  const every = sameDays(value, EVERY_DAY);
  const weekdays = sameDays(value, WEEKDAYS_ONLY);

  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text variant="rowLabel" tone="sub">
          반복
        </Text>
        <Text variant="bodyStrong" accessibilityLiveRegion="polite">
          {repeatLabel(value)}
        </Text>
      </View>
      <View style={styles.quick}>
        <Button small variant={every ? 'primary' : 'ghost'} label="매일" onPress={() => onChange(every ? [] : [...EVERY_DAY])} />
        <Button small variant={weekdays ? 'primary' : 'ghost'} label="평일" onPress={() => onChange(weekdays ? [] : [...WEEKDAYS_ONLY])} />
      </View>
      <DayPicker value={value} onToggle={(day) => onChange(toggleWeekday(value, day))} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 14 }, // 위 줄들과 같은 구분선
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  quick: { flexDirection: 'row', gap: 8, marginTop: 10, marginBottom: 12 },
});
