import { StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

import { Text } from './Text';

export type TimelineItem = {
  time: string; // 오전 8:00
  label: string;
  source?: string; // 오른쪽 작은 글자 (자동 판정 · 지오펜스)
  past?: boolean; // 지나간 일은 흐리게
};

type Props = {
  items: TimelineItem[];
  highlightLast?: boolean; // 마지막 줄 점을 진하게 (지금)
};

// 시각 순 기록 (.tl) — 그룹원 기상 상태 · 하루 기록 · 변경 기록
export function Timeline({ items, highlightLast }: Props) {
  return (
    <View>
      {items.map((item, i) => {
        const now = highlightLast && i === items.length - 1;
        return (
          <View key={`${item.time}-${item.label}-${i}`} style={styles.row}>
            <Text variant="label" tone="sub" style={styles.time}>
              {item.time}
            </Text>
            <View style={[styles.dot, now && styles.dotNow]} />
            <Text variant="body" tone={item.past ? 'faint' : 'ink'} style={styles.label}>
              {item.label}
            </Text>
            {item.source ? (
              <Text variant="caption" tone="faint" align="right">
                {item.source}
              </Text>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 9 },
  time: { width: 64, fontVariant: ['tabular-nums'] },
  dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: colors.line, marginHorizontal: 1.5 },
  dotNow: { backgroundColor: colors.ink },
  label: { flex: 1, fontSize: 13.5 },
});
