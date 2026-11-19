import { StyleSheet, View } from 'react-native';

import { Button, Card, Text } from '@/components/ui';

import { suggestionSummary } from '../suggestion';
import type { RoutineSuggestion } from '../types';

// 루틴 제안 카드 (안건 D114) — 저녁 AI 대화 화면(알람 조정 제안 카드 아래) · 오늘 일기(A03)
//   [루틴 만들기] = 루틴 편집(A04)에 초안을 채워 엶 → 저장하면 제안은 받아들임, [괜찮아요] = 넘김(기록이 3일 더 쌓이면 다시, D24 C)
//   화면이 api로 읽고 처리 — 이 부품은 보여 주기만
export function RoutinePromptCard({
  suggestion,
  busy,
  onCreate,
  onIgnore,
}: {
  suggestion: RoutineSuggestion;
  busy: boolean;
  onCreate: () => void;
  onIgnore: () => void;
}) {
  return (
    <Card>
      <Text variant="caption" tone="sub">
        루틴 제안
      </Text>
      <Text variant="bodyLarge" weight={600} style={styles.title}>
        {suggestion.title} 루틴을 만들어 볼까요?
      </Text>
      <Text variant="small" tone="sub">
        {suggestion.reason}
      </Text>
      <Text variant="small" style={styles.line}>
        {suggestionSummary(suggestion)}
      </Text>
      <View style={styles.actions}>
        <Button label="루틴 만들기" onPress={onCreate} disabled={busy} />
        <Button label="괜찮아요" variant="ghost" onPress={onIgnore} disabled={busy} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 4 },
  line: { marginTop: 8 },
  actions: { marginTop: 12, gap: 8 },
});
