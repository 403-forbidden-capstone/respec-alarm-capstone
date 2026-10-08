import { StyleSheet, View } from 'react-native';

import { Card, ProgressBar, Text } from '@/components/ui';

import type { RoutineProgress } from '../types';

// 오늘 루틴 카드 (.rcard) — 누를 때마다 다음 단계를 끝냄, 끝낸 단계는 줄을 그음
export function RoutineCard({ routine, onPress }: { routine: RoutineProgress; onPress: () => void }) {
  return (
    <Card onPress={onPress} accessibilityLabel={`${routine.title} 다음 단계 완료`}>
      <Text variant="bodyLarge" weight={600}>
        {routine.title}
      </Text>
      <Text variant="small" tone="sub" style={styles.steps}>
        {routine.steps.map((step, i) => (
          <Text key={i} variant="small" tone={i < routine.done ? 'faint' : 'sub'} style={i < routine.done && styles.done}>
            {step}
            {i < routine.steps.length - 1 ? ' · ' : ''}
          </Text>
        ))}
      </Text>
      <View>
        <ProgressBar value={routine.done / routine.steps.length} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  steps: { marginTop: 2 },
  done: { textDecorationLine: 'line-through' },
});
