import { StyleSheet, View } from 'react-native';

import { Card, SectionHeader } from '@/components/ui';
import { colors } from '@/theme';

import { DetectionRow } from './components/DetectionRow';
import { useHomeDetections } from './hooks/useHomeDetections';
import { detectionKey } from './rows';

type Props = {
  reloadOn?: unknown; // 이 값이 바뀌면 다시 읽음 — 홈 데이터를 넘김
  onChanged?: () => unknown; // 지우거나 되돌린 뒤 — 홈을 다시 읽게 (아침 카드가 출발 기록에 따라 달라짐)
};

// 홈 감지 정정 줄 (H01) — 오늘 위치로 잡힌 출발 · 도착. 없으면 제목도 줄도 그리지 않음
//   훅(useHomeDetections)과 부품(DetectionRow)을 잇기만 함
export function DetectionRows({ reloadOn, onChanged }: Props) {
  const { rows, busy, reject } = useHomeDetections({ reloadOn, onChanged });
  if (rows.length === 0) return null;
  return (
    <>
      <SectionHeader title="위치로 잡은 기록" />
      <Card>
        {rows.map((d, i) => (
          <View key={detectionKey(d)} style={i > 0 && styles.divider}>
            <DetectionRow kind={d.kind} at={d.at} disabled={busy} onReject={() => void reject(d)} />
          </View>
        ))}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  divider: { borderTopWidth: 1, borderTopColor: colors.line, marginTop: 6, paddingTop: 6 },
});
