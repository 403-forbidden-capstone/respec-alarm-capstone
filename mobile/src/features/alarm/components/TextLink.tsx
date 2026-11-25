import { Pressable, StyleSheet } from 'react-native';

import { Text } from '@/components/ui';
import { useAccent } from '@/lib/skyTone';

type Props = {
  label: string;
  onPress: () => void;
  strong?: boolean;
  accessibilityLabel?: string; // 글자만으로 뜻이 모자랄 때 (없으면 label을 읽음)
  disabled?: boolean; // 흐리게 · 못 누름
};

// 글자 높이가 낮아(약 19) 위아래로 넓혀 누르는 칸을 44 이상으로 — 모양 · 줄 높이는 그대로
// '···'처럼 글자 폭이 10 안팎이면 옆으로도 모자라 최소 폭 20을 둠 (20 + 양옆 12 = 44)
const HIT_SLOP = { top: 13, bottom: 13, left: 12, right: 12 } as const;

// 글자만 있는 작은 버튼 (.tlink) — 섹션 제목 오른쪽 "+ 새 일정" 등. 섹션 제목 안에서는 굵게(strong)
export function TextLink({ label, onPress, strong, accessibilityLabel, disabled }: Props) {
  const accent = useAccent(); // 글자 버튼은 포인트 색 (lib/skyTone)
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={HIT_SLOP}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.box, disabled ? { opacity: 0.4 } : pressed && { opacity: 0.6 }]}
    >
      <Text variant="rowLabel" tone="sub" weight={strong ? 700 : 600} style={{ color: accent }}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({ box: { minWidth: 20, alignItems: 'center' } });
