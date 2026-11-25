import { StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';

import { promptLine } from '../suggestion';
import type { Suggestion } from '../types';

// 저녁 AI 대화(A02) 속 알람 조정 제안 카드 (안건 D111 5번) — 대화 첫 마디 바로 아래
//   UI 단순화: 제목 한 줄 + 바뀌는 시각 한 줄 + 오른쪽 아래 글자 버튼 [괜찮아요] · [적용하기], 자세히(S01)는 오른쪽 위 작은 글자
//   제안이 보이는 곳은 이 카드 한 곳 (그룹 탭 카드는 뺌), 되돌리기 · 직접 고르기는 S01에서
//   applied = 적용한 뒤 한 줄 — 카드는 그 자리에 \"적용했어요\"로 남음
export function SuggestionPromptCard({
  suggestion,
  applied,
  busy,
  onApply,
  onIgnore,
  onOpen,
}: {
  suggestion: Suggestion;
  applied: string | null;
  busy: boolean;
  onApply: () => void;
  onIgnore: () => void;
  onOpen: () => void;
}) {
  return (
    <Card>
      <View style={styles.head}>
        <Text variant="caption" tone="sub">
          알람 조정 제안
        </Text>
        <TextLink label={applied ? '되돌리기 ›' : '자세히 ›'} onPress={onOpen} />
      </View>
      <Text variant="bodyLarge" weight={600} style={styles.title}>
        {applied ? '적용했어요' : suggestion.title}
      </Text>
      <Text variant="small" tone="sub" style={styles.line}>
        {applied ?? promptLine(suggestion)}
      </Text>
      {applied ? null : (
        <View style={styles.actions}>
          <TextLink label="괜찮아요" onPress={onIgnore} disabled={busy} />
          <TextLink label="적용하기" onPress={onApply} disabled={busy} strong />
        </View>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  head: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { marginTop: 4 },
  line: { marginTop: 4 },
  actions: { marginTop: 4, flexDirection: 'row', justifyContent: 'flex-end', gap: 24 }, // 이 화면의 주 동작은 [말하기] — 카드 안 동작은 글자 버튼
});
