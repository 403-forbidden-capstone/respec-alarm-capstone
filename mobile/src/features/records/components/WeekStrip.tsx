import { StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { colors } from '@/theme';

import type { WeekDay, WeekRecord } from '../types';

import { CalendarHeader } from './CalendarHeader';

type Props = {
  record: WeekRecord;
  onPrev: () => void;
  onNext: () => void;
};

// 주간 날짜 줄 (.wstrip) — 오늘은 검게, 지나지 않은 날은 흐리게, 기록 있는 날은 점
export function WeekStrip({ record, onPrev, onNext }: Props) {
  return (
    <Card>
      <CalendarHeader title={record.title} sub={record.relative} unit="주" onPrev={onPrev} onNext={onNext} />
      <View style={styles.strip}>
        {record.strip.map((d) => (
          <DayChip key={d.day} day={d} />
        ))}
      </View>
    </Card>
  );
}

function DayChip({ day: d }: { day: WeekDay }) {
  return (
    <View
      style={[styles.day, d.isToday && styles.on, d.isFuture && styles.future]}
      accessible
      accessibilityLabel={`${d.weekday}요일 ${d.day}일${d.isToday ? ' 오늘' : ''}${d.recorded ? ' 기록 있음' : ''}`}
    >
      <Text variant="caption" tone={d.isToday ? 'inverse' : 'sub'} style={[styles.weekday, d.isToday && styles.weekdayOn]}>
        {d.weekday}
      </Text>
      <Text variant="bodyStrong" tone={d.isToday ? 'inverse' : 'ink'} style={styles.num}>
        {d.day}
      </Text>
      <View style={[styles.dot, d.recorded && (d.isToday ? styles.dotOn : styles.dotInk)]} />
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { flexDirection: 'row', gap: 4 },
  day: { flex: 1, alignItems: 'center', gap: 2, paddingVertical: 8, borderRadius: 14, backgroundColor: colors.chip },
  on: { backgroundColor: colors.ink },
  future: { opacity: 0.5 },
  weekday: { fontSize: 11 },
  weekdayOn: { opacity: 0.7 },
  num: { fontVariant: ['tabular-nums'] },
  dot: { width: 4, height: 4, borderRadius: 2 },
  dotInk: { backgroundColor: colors.ink },
  dotOn: { backgroundColor: colors.inverse },
});
