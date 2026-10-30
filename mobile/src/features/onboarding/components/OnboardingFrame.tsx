import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, ProgressBar, Screen, Text, TopBar } from '@/components/ui';
import { keepWords } from '@/lib/format';

type Props = {
  step: number; // 1부터
  total: number;
  title: string;
  lead?: string; // 제목 아래 한 줄 설명
  children: ReactNode;
  primaryLabel: string; // 이 단계의 주된 행동 (다음 · 저장하고 다음 …) — 화면에 진한 버튼은 이것 하나
  onPrimary: () => void;
  primaryDisabled?: boolean;
  primaryBusy?: boolean; // 저장하는 동안 버튼 안에 돌아가는 표시
  secondaryLabel?: string; // 나중에 · 건너뛰기 — 낮은 강조 글자 버튼
  onSecondary?: () => void;
  onBack?: () => void; // 없으면 "← 이전"을 그리지 않음 (첫 단계)
};

// 온보딩 모든 단계의 틀 — 위: 이전 · 진행(3 / 10) · 제목 · 설명, 아래 고정: 주된 버튼 하나 + 글자 버튼 하나
// 저장 · 이동 · 권한 요청은 하지 않고 콜백으로 밖에 맡김 (L7이 실제 함수를 붙임)
export function OnboardingFrame({
  step,
  total,
  title,
  lead,
  children,
  primaryLabel,
  onPrimary,
  primaryDisabled,
  primaryBusy,
  secondaryLabel,
  onSecondary,
  onBack,
}: Props) {
  const safeTotal = Math.max(1, total);
  return (
    <Screen
      footer={
        <View style={styles.footer}>
          <Button label={primaryLabel} onPress={onPrimary} disabled={primaryDisabled} loading={primaryBusy} />
          {secondaryLabel && onSecondary ? <Button variant="plain" label={secondaryLabel} onPress={onSecondary} disabled={primaryBusy} /> : null}
        </View>
      }
    >
      {onBack ? <TopBar onBack={onBack} /> : null}
      <View style={[styles.progress, !onBack && styles.progressFirst]} accessible accessibilityLabel={`${safeTotal}단계 중 ${step}단계`}>
        <Text variant="caption" tone="sub" style={styles.count}>
          {step} / {safeTotal}
        </Text>
        <View style={styles.bar}>
          <ProgressBar flush value={step / safeTotal} />
        </View>
      </View>
      <Text variant="title" style={styles.title}>
        {keepWords(title)}
      </Text>
      {lead ? (
        <Text variant="lead" style={styles.lead}>
          {keepWords(lead)}
        </Text>
      ) : null}
      <View style={styles.body}>{children}</View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  footer: { gap: 4 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 },
  progressFirst: { marginTop: 16 }, // 이전 줄이 없는 첫 단계는 위 여백을 대신 줌
  count: { fontVariant: ['tabular-nums'] },
  bar: { flex: 1 },
  title: { marginTop: 24 },
  lead: { marginTop: 8 },
  body: { marginTop: 24 },
});
