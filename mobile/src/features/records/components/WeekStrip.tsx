import { Pressable, StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { colors } from '@/theme';

import type { WeekDay, WeekRecord } from '../types';

import { CalendarHeader } from './CalendarHeader';

type Props = {
  record: WeekRecord;
  onPrev: () => void;
  onNext: () => void;
  onPressDay: (day: WeekDay) => void; // 날짜를 누르면 그 날의 일간 (D48)
};

// 주간 날짜 줄 (.wstrip) — 오늘은 검게, 지나지 않은 날은 흐리게 하고 못 누름, 기록 있는 날은 점. 지난 날 · 오늘은 눌러서 그 날의 일간으로
export function WeekStrip({ record, onPrev, onNext, onPressDay }: Props) {
  return (
    <Card>
      <CalendarHeader title={record.title} sub={record.relative} unit="주" onPrev={onPrev} onNext={onNext} />
      <View style={styles.strip}>
        {record.strip.map((d) => (
          <DayChip key={d.day} day={d} onPress={() => onPressDay(d)} />
        ))}
      </View>
    </Card>
  );
}

function DayChip({ day: d, onPress }: { day: WeekDay; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={d.isFuture}
      style={({ pressed }) => [styles.day, d.isToday && styles.on, d.isFuture && styles.future, pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityState={{ disabled: d.isFuture, selected: d.isToday }}
      accessibilityLabel={`${d.weekday}요일 ${d.day}일${d.isToday ? ' 오늘' : ''}${d.isFuture ? ' 아직 오지 않은 날' : ''}${d.recorded ? ' 기록 있음' : ''}`}
    >
      <Text variant="tiny" tone={d.isToday ? 'inverse' : 'sub'} style={d.isToday && styles.weekdayOn}>
        {d.weekday}
      </Text>
      <Text variant="bodyStrong" tone={d.isToday ? 'inverse' : 'ink'} style={styles.num}>
        {d.day}
      </Text>
      <View style={[styles.dot, d.recorded && (d.isToday ? styles.dotOn : styles.dotInk)]} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: 'row', gap: 4 },
  day: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 8, borderRadius: 14, backgroundColor: colors.chip },
  on: { backgroundColor: colors.ink },
  future: { opacity: 0.5 },
  pressed: { opacity: 0.6 },
  weekdayOn: { opacity: 0.7 },
  num: { fontVariant: ['tabular-nums'] },
  dot: { width: 4, height: 4, borderRadius: 2 },
  dotInk: { backgroundColor: colors.ink },
  dotOn: { backgroundColor: colors.inverse },
});
