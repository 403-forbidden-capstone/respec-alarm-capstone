import { StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

type Props = {
  value: number; // 0~1
  threshold?: number; // 0~1, 기준선 (기상 판정 θ 같은 것)
  thick?: boolean; // 기상 판정 막대처럼 굵게
};

// 진행 막대 (.prog · .meter) — 루틴 진행, 화면 사용 시간 등
export function ProgressBar({ value, threshold, thick }: Props) {
  const pct = `${Math.max(0, Math.min(1, value)) * 100}%` as const;
  const h = thick ? 8 : 6;
  return (
    <View style={[styles.track, { height: h, borderRadius: h / 2 }]}>
      <View style={[styles.fill, { width: pct, borderRadius: h / 2 }]} />
      {threshold != null ? (
        <View style={[styles.threshold, { left: `${Math.max(0, Math.min(1, threshold)) * 100}%` }]} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { backgroundColor: colors.chip, overflow: 'visible', marginTop: 12 },
  fill: { height: '100%', backgroundColor: colors.ink },
  threshold: { position: 'absolute', top: -4, bottom: -4, width: 2, backgroundColor: colors.warn },
});
