import { StyleSheet } from 'react-native';

import { Text } from '@/components/ui';
import { WAKE_SENSITIVITY_NAME } from '@/features/profile/labels';
import type { WakeSensitivity } from '@/features/profile/types';

import { ChoiceRow } from './ChoiceRow';

type Props = {
  value: WakeSensitivity;
  onChange: (next: WakeSensitivity) => void;
};

// 이름은 profile/labels.ts (D92 기본안 A — 3개 → 보통 · 보통 · 강, 계산 반영은 L1, 여기서는 고른 값만 저장)
const OPTIONS: readonly WakeSensitivity[] = ['LIGHT', 'NORMAL', 'HEAVY'];

// 잠귀 단계 (L02-3) — 질문 하나 · 3지선다
export function SleepStep({ value, onChange }: Props) {
  return (
    <>
      <Text variant="bodyStrong" style={styles.question}>
        알람 소리에 얼마나 잘 깨요?
      </Text>
      {OPTIONS.map((v) => (
        <ChoiceRow key={v} label={WAKE_SENSITIVITY_NAME[v]} selected={v === value} onPress={() => onChange(v)} />
      ))}
    </>
  );
}

const styles = StyleSheet.create({
  question: { marginBottom: 12 },
});
