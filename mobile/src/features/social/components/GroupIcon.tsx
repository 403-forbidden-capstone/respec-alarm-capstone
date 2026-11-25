import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import { useAccent } from '@/lib/skyTone';
import { colors, radius } from '@/theme';

type Props = {
  label: string; // 캡 · 가족
  light?: boolean; // 기상 상태를 볼 수 없는 그룹은 연한 바탕
  small?: boolean; // 관계 고르기 · 권한 설정 칸
};

// 그룹 아이콘 (.gico) — 둥근 네모에 그룹 이름 앞 글자
export function GroupIcon({ label, light, small }: Props) {
  const accent = useAccent(); // 포인트 색 (lib/skyTone)
  return (
    <View style={[styles.box, { backgroundColor: accent }, small && styles.small, light && styles.light]}>
      <Text variant="note" tone={light ? 'ink' : 'inverse'} weight={600}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    width: 42,
    height: 42,
    borderRadius: radius.icon,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  small: { width: 36, height: 36 },
  light: { backgroundColor: colors.chip },
});
