import { Pressable, StyleSheet } from 'react-native';

import { Card, Text } from '@/components/ui';
import { keepWords } from '@/lib/format';

import type { TripCardView } from '../morning';

// 홈 이동 중 · 도착 줄 (H01) — 출발한 뒤 아침 카드가 빠진 자리. 보이는 때와 글자는 morning.ts tripCardOf가 정함 (이 부품은 그리기만)
export function TripCard({ view, onPress }: { view: TripCardView; onPress: () => void }) {
  return (
    <Card>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${view.title}, 일정 열기`} style={({ pressed }) => pressed && styles.pressed}>
        <Text variant="label" tone="sub">
          {view.stage === 'MOVING' ? '이동 중' : '도착'}
        </Text>
        <Text variant="big" style={styles.title}>
          {keepWords(view.title)}
        </Text>
        <Text variant="small" tone="sub" style={styles.summary}>
          {keepWords(view.summary)}
        </Text>
      </Pressable>
    </Card>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.7 },
  title: { marginTop: 4 },
  summary: { marginTop: 4 },
});
