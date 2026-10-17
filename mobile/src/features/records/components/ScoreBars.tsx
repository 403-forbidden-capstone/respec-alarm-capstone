import { Pressable, StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { dateParts } from '@/lib/format';
import { colors, size } from '@/theme';

import type { WeekBar } from '../types';

type Props = {
  bars: WeekBar[];
  onPressDay: (bar: WeekBar) => void; // 막대를 누르면 그 날의 일간 (D48, 날짜 칩과 같음)
};

// 주간 실행 흐름 막대 (.bar) — 날마다 실행 점수 0~100. 날짜 칩처럼 누를 수 있음
export function ScoreBars({ bars, onPressDay }: Props) {
  return (
    <View>
      {bars.map((b) => {
        const { weekday, day } = dateParts(b.date);
        return (
          <Pressable
            key={b.label}
            onPress={() => onPressDay(b)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`${weekday}요일 ${day}일${b.isToday ? ' 오늘' : ''}${b.isFuture ? ' 아직 오지 않은 날' : ''} ${b.score}점`}
          >
            <Text variant="note" style={styles.label}>
              {b.label}
            </Text>
            <View style={styles.track}>
              <View style={[styles.fill, { width: `${Math.max(0, Math.min(100, b.score))}%` }]} />
            </View>
            <Text variant="note" tone="sub" align="right" style={styles.score}>
              {b.score}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: size.touch },
  pressed: { opacity: 0.6 },
  label: { width: 48 },
  track: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.chip, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 4, backgroundColor: colors.ink },
  score: { width: 28, fontVariant: ['tabular-nums'] },
});
