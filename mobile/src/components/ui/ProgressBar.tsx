import { StyleSheet, View } from 'react-native';

import { useAccent } from '@/lib/skyTone';
import { colors } from '@/theme';

type Props = {
  value: number; // 0~1
  threshold?: number; // 0~1, 기준선 (기상 판정 θ 같은 것)
  thick?: boolean; // 기상 판정 막대처럼 굵게
  flush?: boolean; // 위 여백(12) 없이 — 글자와 한 줄에 놓을 때
};

// 진행 막대 (.prog · .meter) — 루틴 진행, 화면 사용 시간 등
export function ProgressBar({ value, threshold, thick, flush }: Props) {
  const accent = useAccent(); // 채운 부분 — 포인트 색 (lib/skyTone)
  const pct = `${Math.max(0, Math.min(1, value)) * 100}%` as const;
  const h = thick ? 8 : 6;
  return (
    <View style={[styles.track, { height: h, borderRadius: h / 2 }, flush && styles.flush]}>
      <View style={[styles.fill, { backgroundColor: accent, width: pct, borderRadius: h / 2 }]} />
      {threshold != null ? (
        <View style={[styles.threshold, { left: `${Math.max(0, Math.min(1, threshold)) * 100}%` }]} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  track: { backgroundColor: colors.chip, overflow: 'visible', marginTop: 12 },
  flush: { marginTop: 0 },
  fill: { height: '100%', backgroundColor: colors.ink },
  threshold: { position: 'absolute', top: -4, bottom: -4, width: 2, backgroundColor: colors.warn },
});
