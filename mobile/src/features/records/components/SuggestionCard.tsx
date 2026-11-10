import { StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import type { Suggestion } from '@/features/records/types';

// 알람 조정 제안 카드 — 점선은 목업 · 피그마 그대로, 누르면 제안 상세(S01)로 가니 '보기 ›' 꼬리
// 홈 아래에 있던 카드를 그룹 탭 위로 옮김 (D110). onPress = 제안 id를 받아 상세를 여는 쪽(화면)이 정함
export function SuggestionCard({ suggestion, onPress }: { suggestion: Suggestion; onPress: (id: string) => void }) {
  return (
    <Card variant="dash" onPress={() => onPress(suggestion.id)}>
      <View style={styles.banner}>
        <View style={styles.text}>
          <Text variant="bodyLarge" weight={600}>
            {suggestion.title}
          </Text>
          <Text variant="small" tone="sub" style={styles.sub}>
            {suggestion.summary}
          </Text>
        </View>
        <Text variant="rowLabel" tone="sub">
          보기 ›
        </Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  banner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  text: { flex: 1 },
  sub: { marginTop: 2 },
});
