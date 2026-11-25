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
  onBack?: () => void; // 없으면 "← 이전"을 그리지 않음 (첫 단계) — 자리는 비워 둬서 제목 높이가 단계마다 같음
  aboveFooter?: ReactNode; // 주된 버튼 바로 위에 붙일 것 (동의 단계의 만 14세 확인 — 스크롤 끝까지 안 가도 보임)
  footerHint?: string; // 주된 버튼이 꺼져 있을 때만 버튼 아래에 보이는 한 줄 (왜 못 누르는지)
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
  aboveFooter,
  footerHint,
}: Props) {
  const safeTotal = Math.max(1, total);
  return (
    <Screen
      footer={
        <View style={styles.footer}>
          {aboveFooter}
          <Button label={primaryLabel} onPress={onPrimary} disabled={primaryDisabled} loading={primaryBusy} />
          {primaryDisabled && footerHint ? (
            <Text variant="small" tone="sub" align="center">
              {footerHint}
            </Text>
          ) : null}
          {secondaryLabel && onSecondary ? <Button variant="plain" label={secondaryLabel} onPress={onSecondary} disabled={primaryBusy} /> : null}
        </View>
      }
    >
      <TopBar onBack={onBack ? (primaryBusy ? noop : onBack) : undefined} />
      <View style={styles.progress} accessible accessibilityLabel={`${safeTotal}단계 중 ${step}단계`}>
        <Text variant="small" tone="sub" style={styles.count}>
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

const noop = () => {}; // 저장하는 중에는 이전으로 못 감

const styles = StyleSheet.create({
  footer: { gap: 4 },
  progress: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 8 },
  count: { fontVariant: ['tabular-nums'] },
  bar: { flex: 1 },
  title: { marginTop: 24 },
  lead: { marginTop: 8 },
  body: { marginTop: 24 },
});
