import { StyleSheet, View } from 'react-native';

import { colors, size } from '@/theme';

import { Text } from './Text';

export type WakeDot = 'ok' | 'mid' | 'zz'; // 기상 확인 · 준비 중 · 아직 자는 중

type Props = {
  initial: string; // 이름 첫 글자
  small?: boolean;
  dot?: WakeDot;
};

// 사람 동그라미 (.avatar) — 오른쪽 위 점으로 기상 상태
export function Avatar({ initial, small, dot }: Props) {
  const d = small ? size.avatarSm : size.avatar;
  return (
    <View style={[styles.circle, { width: d, height: d, borderRadius: d / 2 }]}>
      <Text variant={small ? 'label' : 'small'} tone="ink" weight={600}>
        {initial}
      </Text>
      {dot === 'zz' ? (
        <Text variant="caption" weight={700} style={styles.zz}>
          z
        </Text>
      ) : dot ? (
        <View style={[styles.dot, { backgroundColor: dot === 'ok' ? colors.ok : colors.mid }]} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  circle: { backgroundColor: colors.chip, alignItems: 'center', justifyContent: 'center' },
  dot: {
    position: 'absolute',
    top: 0,
    right: -1,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: colors.card,
  },
  zz: { position: 'absolute', top: -6, right: -2, color: colors.zz, fontSize: 11 },
});
