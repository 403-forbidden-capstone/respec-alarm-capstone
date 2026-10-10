import { Pressable, StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { colors } from '@/theme';

import { calendarRows } from '../calendar';
import type { DayMark, MonthDay, MonthRecord } from '../types';

import { CalendarHeader } from './CalendarHeader';

const WEEK = ['월', '화', '수', '목', '금', '토', '일'];

const MARK_LABEL: Record<DayMark, string> = { done: '기록 완료', partial: '일부 기록', none: '기록 없음' };

type Props = {
  record: MonthRecord;
  onPrev: () => void;
  onNext: () => void;
  onPressDay: (day: MonthDay) => void;
};

// 월간 달력 (.cal) — 월요일 시작, 날짜 아래 점: 기록 완료(검정) · 일부 기록(회색), 오늘은 검은 원
export function MonthCalendar({ record, onPrev, onNext, onPressDay }: Props) {
  return (
    <Card>
      <CalendarHeader title={record.title} unit="달" onPrev={onPrev} onNext={onNext} />
      <View style={styles.row}>
        {WEEK.map((w) => (
          <Text key={w} variant="tiny" align="center" style={styles.weekday}>
            {w}
          </Text>
        ))}
      </View>
      {calendarRows(record.leadingBlanks, record.days).map((row, i) => (
        <View key={i} style={styles.row}>
          {row.map((d, j) => (d ? <DayCell key={d.day} day={d} onPress={() => onPressDay(d)} /> : <View key={`blank-${j}`} style={styles.cell} />))}
        </View>
      ))}
      <View style={styles.legend}>
        <Legend mark="done" />
        <Legend mark="partial" />
      </View>
    </Card>
  );
}

function DayCell({ day: d, onPress }: { day: MonthDay; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${d.day}일${d.isToday ? ' 오늘' : ''}${d.mark === 'none' ? '' : ` ${MARK_LABEL[d.mark]}`}`}
      style={({ pressed }) => [styles.cell, pressed && styles.pressed]}
    >
      <View style={[styles.num, d.isToday && styles.today]}>
        <Text variant="note" tone={d.isToday ? 'inverse' : d.isFuture ? 'faint' : 'ink'} weight={d.isToday ? 600 : 400} style={styles.numText}>
          {d.day}
        </Text>
      </View>
      <View style={[styles.dot, styles[d.mark]]} />
    </Pressable>
  );
}

function Legend({ mark }: { mark: DayMark }) {
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendDot, styles[mark]]} />
      <Text variant="caption" tone="sub">
        {MARK_LABEL[mark]}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row' },
  weekday: { flex: 1, paddingBottom: 4 },
  cell: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center', gap: 3 },
  pressed: { opacity: 0.6 },
  num: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  today: { backgroundColor: colors.ink },
  numText: { fontVariant: ['tabular-nums'] },
  dot: { width: 4, height: 4, borderRadius: 2 },
  done: { backgroundColor: colors.ink },
  partial: { backgroundColor: colors.faint },
  none: { backgroundColor: 'transparent' },
  legend: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 14,
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  legendDot: { width: 5, height: 5, borderRadius: 2.5 },
});
