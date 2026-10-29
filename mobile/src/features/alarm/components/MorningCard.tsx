import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Card, Text } from '@/components/ui';
import { keepWords } from '@/lib/format';
import { colors } from '@/theme';

import { morningCardView, morningDayWord } from '../morning';
import type { DepartCheck, MorningPlan } from '../types';

type Props = {
  plan: MorningPlan;
  current: Date; // 지금 시각 — "출발까지" · 도착 · 여유는 늘 지금 기준으로 다시 셈
  check: DepartCheck | null; // 마지막으로 [다시 확인]한 결과 — 없으면 저장된 이동분으로 셈
  busy?: boolean; // 다시 확인하는 중
  onRecheck: () => void; // 저장은 안 함 — 부르는 쪽(hooks/useDepartCheck)이 api를 부름
  onPress: () => void; // 카드를 누르면 알람 설정(H03)
};

// 홈 아침 카드 (H01, 이슈 #230) — 기상을 확인한 뒤 출발까지: 첫 일정 · 출발까지 남은 시간 · 지금 나가면 도착 · 여유 · 상태
// 보이는 때는 morning.ts morningCardVisible이 정함 (이 부품은 그리기만)
export function MorningCard({ plan, current, check, busy, onRecheck, onPress }: Props) {
  const view = morningCardView(plan, check, current);
  return (
    <Card>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${plan.title} 알람 설정 열기`} style={({ pressed }) => pressed && styles.pressed}>
        <Text variant="label" tone="sub">
          {morningDayWord(current)} 첫 일정
        </Text>
        <Text variant="bodyLarge" weight={600} style={styles.summary}>
          {keepWords(view.summary)}
        </Text>
        {view.untilDepart ? (
          <Text variant="big" style={styles.until}>
            {keepWords(view.untilDepart)}
          </Text>
        ) : null}
        <Text variant="body" style={styles.nowLine}>
          {keepWords(view.nowLine)}
        </Text>
        <View style={styles.statusRow}>
          <Text variant="bodyStrong" tone={view.status === 'LATE_RISK' ? 'warn' : 'ink'}>
            {view.statusLabel}
          </Text>
          <Text variant="small" tone="sub" style={styles.travel}>
            {keepWords(view.travelLine)}
          </Text>
        </View>
      </Pressable>
      <View style={styles.action}>
        <Button small variant="ghost" label="다시 확인" onPress={onRecheck} loading={busy} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.7 },
  summary: { marginTop: 2 },
  until: { marginTop: 10 },
  nowLine: { marginTop: 2 },
  statusRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', columnGap: 8, marginTop: 8 },
  travel: { flexShrink: 1 },
  action: { marginTop: 12, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 12 },
});
