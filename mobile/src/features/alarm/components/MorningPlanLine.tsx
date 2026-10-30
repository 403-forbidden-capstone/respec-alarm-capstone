import { Pressable, StyleSheet } from 'react-native';

import { Card, Text } from '@/components/ui';
import { formatTime, keepWords } from '@/lib/format';

import { morningDayWord, upcomingNotices } from '../morning';
import type { MorningPlan } from '../types';

type Props = {
  plan: MorningPlan | null; // 오늘 첫 일정 — 없으면 짧은 문구
  current: Date;
  onPress: () => void; // 일정 줄을 누르면 알람 설정(H03)
};

// 기상 확정 뒤 "오늘 첫 일정" 한 줄 (H08, 이슈 #230) — 일정 · 나갈 시각 · 다음 알림
export function MorningPlanLine({ plan, current, onPress }: Props) {
  const day = morningDayWord(current);
  if (!plan) {
    return (
      <Card variant="dash">
        <Text variant="body" tone="sub">
          {day}은 기상 알람이 걸린 일정이 없어요
        </Text>
      </Card>
    );
  }
  const notices = upcomingNotices(plan, current);
  const summary = [`${formatTime(plan.at)} ${plan.title}`, plan.place].filter(Boolean).join(' · ');
  return (
    <Card>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`${plan.title} 알람 설정 열기`} style={({ pressed }) => pressed && styles.pressed}>
        <Text variant="label" tone="sub">
          {day} 첫 일정
        </Text>
        <Text variant="bodyLarge" weight={600} style={styles.summary}>
          {keepWords(summary)}
        </Text>
        {plan.departAt && plan.departAt.getTime() > current.getTime() ? (
          <Text variant="body" style={styles.line}>
            {formatTime(plan.departAt)}에 나가면 돼요
          </Text>
        ) : null}
        {notices.length ? (
          <Text variant="small" tone="sub" style={styles.line}>
            {keepWords(`다음 알림 · ${notices.map((x) => `${x.label} ${formatTime(x.at)}`).join(' · ')}`)}
          </Text>
        ) : null}
      </Pressable>
    </Card>
  );
}

const styles = StyleSheet.create({
  pressed: { opacity: 0.7 },
  summary: { marginTop: 2 },
  line: { marginTop: 6 },
});
