import { StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';

import type { RoutineSuggestion } from '../types';

// 루틴 제안 카드 (안건 D114) — 저녁 AI 대화 화면, 알람 조정 제안이 없을 때만 (한 번에 카드 하나)
//   UI 단순화: 제목 한 줄 + 이유 한 줄 + 오른쪽 아래 글자 버튼 [괜찮아요] · [만들기]
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
        <TextLink label="괜찮아요" onPress={onIgnore} disabled={busy} />
        <TextLink label="만들기" onPress={onCreate} disabled={busy} strong />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 4 },
  line: { marginTop: 4 },
  actions: { marginTop: 4, flexDirection: 'row', justifyContent: 'flex-end', gap: 24 }, // 카드 안 동작은 글자 버튼 — 주 동작은 [말하기]
});
