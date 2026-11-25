import { StyleSheet, View } from 'react-native';

import { Button, Card, Text } from '@/components/ui';

import type { RoutineSuggestion } from '../types';

// 루틴 제안 카드 (안건 D114) — 저녁 AI 대화 화면, 알람 조정 제안이 없을 때만 (한 번에 카드 하나)
//   UI 단순화: 제목 한 줄 + 이유 한 줄 + [만들기] · [괜찮아요] 나란히
//   [만들기] = 초안 그대로 바로 저장(제안은 받아들임) → 토스트의 [고치기]로 루틴 편집, [괜찮아요] = 넘김(기록 3일 뒤 다시, D24 C)
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
      <Text variant="small" tone="sub" style={styles.line}>
        {suggestion.reason}
      </Text>
      <View style={styles.actions}>
        <View style={styles.action}>
          <Button label="만들기" onPress={onCreate} disabled={busy} />
        </View>
        <View style={styles.action}>
          <Button label="괜찮아요" variant="ghost" onPress={onIgnore} disabled={busy} />
        </View>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 4 },
  line: { marginTop: 4 },
  actions: { marginTop: 12, flexDirection: 'row', gap: 8 },
  action: { flex: 1 },
});
