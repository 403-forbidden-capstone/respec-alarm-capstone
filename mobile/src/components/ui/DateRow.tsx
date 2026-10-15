import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { now } from '@/lib/clock';
import { addMinutes, dateParts, dayKey, formatDateShort, minuteOfDay, startOfDay } from '@/lib/format';
import { colors, size } from '@/theme';

import { Sheet } from './Sheet';
import { Text } from './Text';

type Props = {
  label: string;
  value: Date;
  onChange: (next: Date) => void; // 날짜만 바뀌고 시각(시 · 분)은 이전 값 그대로
  minDate?: Date; // 이 날짜 앞은 못 고름 (날짜만 봄)
  maxDate?: Date; // 이 날짜 뒤는 못 고름
  first?: boolean; // 묶음의 첫 줄이면 위 구분선을 뺌
};

const WEEK = ['월', '화', '수', '목', '금', '토', '일'];

// 달력 계산 — 한국 시간 날짜. features/records/calendar.ts와 같은 방식(월요일 시작)이지만 ui가 features를 가져오지 않게 여기에 둠
const dateOf = (year: number, month: number, day: number) => startOfDay(new Date(Date.UTC(year, month - 1, day)));
const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const leadingBlanks = (year: number, month: number) => (dateParts(dateOf(year, month, 1)).weekdayIndex + 6) % 7;
const monthIndex = (year: number, month: number) => year * 12 + (month - 1);

function shiftMonth(year: number, month: number, delta: number) {
  const index = monthIndex(year, month) + delta;
  return { year: Math.floor(index / 12), month: (((index % 12) + 12) % 12) + 1 };
}

// 날짜 고르는 줄 — 누르면 아래 시트에 달력이 뜨고, 날짜를 누르면 바로 고르고 닫힘
// 지난 날(minDate 앞)은 흐리게 막아서 못 고름. 오늘은 테두리, 고른 날은 검은 원
export function DateRow({ label, value, onChange, minDate, maxDate, first }: Props) {
  const [open, setOpen] = useState(false);
  const picked = dateParts(value);
  const [view, setView] = useState({ year: picked.year, month: picked.month });
  const text = formatDateShort(value);

  const todayKey = dayKey(now());
  const pickedKey = dayKey(value);
  const minKey = minDate ? dayKey(minDate) : null;
  const maxKey = maxDate ? dayKey(maxDate) : null;
  const min = minDate ? dateParts(minDate) : null;
  const max = maxDate ? dateParts(maxDate) : null;
  const canPrev = !min || monthIndex(view.year, view.month) > monthIndex(min.year, min.month);
  const canNext = !max || monthIndex(view.year, view.month) < monthIndex(max.year, max.month);

  const cells: (Date | null)[] = [
    ...Array<null>(leadingBlanks(view.year, view.month)).fill(null),
    ...Array.from({ length: daysInMonth(view.year, view.month) }, (_, i) => dateOf(view.year, view.month, i + 1)),
  ];
  while (cells.length % 7) cells.push(null);
  const rows = Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));

  function openSheet() {
    setView({ year: picked.year, month: picked.month }); // 열 때마다 고른 날이 든 달부터
    setOpen(true);
  }

  function pick(day: Date) {
    onChange(addMinutes(day, minuteOfDay(value)));
    setOpen(false);
  }

  return (
    <>
      <Pressable
        onPress={openSheet}
        accessibilityRole="button"
        accessibilityLabel={`${label} ${text}`}
        style={({ pressed }) => [styles.row, !first && styles.divider, pressed && styles.pressed]}
      >
        <Text variant="rowLabel" tone="sub">
          {label}
        </Text>
        <Text variant="bodyStrong">{text}</Text>
      </Pressable>
      <Sheet visible={open} onClose={() => setOpen(false)} title={label}>
        <View style={styles.header}>
          <Arrow label="←" a11y="이전 달" disabled={!canPrev} onPress={() => setView((v) => shiftMonth(v.year, v.month, -1))} />
          <Text variant="big" align="center" style={styles.title}>
            {view.year}년 {view.month}월
          </Text>
          <Arrow label="→" a11y="다음 달" disabled={!canNext} onPress={() => setView((v) => shiftMonth(v.year, v.month, 1))} />
        </View>
        <View style={styles.week}>
          {WEEK.map((w) => (
            <Text key={w} variant="tiny" align="center" style={styles.weekday}>
              {w}
            </Text>
          ))}
        </View>
        {rows.map((row, i) => (
          <View key={i} style={styles.week}>
            {row.map((day, j) => {
              if (!day) return <View key={`blank-${j}`} style={styles.cell} />;
              const key = dayKey(day);
              const parts = dateParts(day);
              const disabled = (minKey != null && key < minKey) || (maxKey != null && key > maxKey);
              const selected = key === pickedKey;
              const today = key === todayKey;
              return (
                <Pressable
                  key={key}
                  onPress={() => pick(day)}
                  disabled={disabled}
                  accessibilityRole="button"
                  accessibilityLabel={`${parts.month}월 ${parts.day}일 (${parts.weekday})${today ? ' 오늘' : ''}`}
                  accessibilityState={{ selected, disabled }}
                  style={styles.cell}
                >
                  <View style={[styles.num, today && !selected && styles.today, selected && styles.selected]}>
                    <Text
                      variant="note"
                      tone={selected ? 'inverse' : disabled ? 'faint' : 'ink'}
                      weight={selected || today ? 600 : 400}
                      style={[styles.numText, disabled && styles.disabledText]}
                    >
                      {parts.day}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        ))}
      </Sheet>
    </>
  );
}

function Arrow({ label, a11y, disabled, onPress }: { label: string; a11y: string; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.arrow, pressed && styles.pressed, disabled && styles.disabledArrow]}
    >
      <Text variant="big" tone="sub" weight={400}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 14 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  pressed: { opacity: 0.6 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4, marginBottom: 8 },
  title: { flex: 1 },
  arrow: { width: size.touch, height: size.touch, alignItems: 'center', justifyContent: 'center' },
  disabledArrow: { opacity: 0.3 },
  week: { flexDirection: 'row' },
  weekday: { flex: 1, paddingBottom: 4 },
  cell: { flex: 1, height: size.touch, alignItems: 'center', justifyContent: 'center' },
  num: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  today: { borderWidth: 1, borderColor: colors.ink },
  selected: { backgroundColor: colors.ink },
  numText: { fontVariant: ['tabular-nums'] },
  disabledText: { opacity: 0.45 },
});
