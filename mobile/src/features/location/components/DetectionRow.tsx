import { StyleSheet, View } from 'react-native';

import { Button, Text } from '@/components/ui';
import { keepWords } from '@/lib/format';

import type { DetectionKind } from '../detections';
import { detectionLabel } from '../rows';

type Props = {
  kind: DetectionKind;
  at: Date;
  disabled?: boolean; // 다른 정정이 도는 중
  onReject: () => void; // 지우기는 부르는 쪽(hooks/useHomeDetections)이 함
};

// 홈 감지 정정 줄 한 칸 (H01) — "출발 오전 8:30 · 자동 감지" + [아니에요] (위치로 잘못 잡았을 때만 누르는 정정)
export function DetectionRow({ kind, at, disabled, onReject }: Props) {
  return (
    <View style={styles.row}>
      <Text variant="body" style={styles.text}>
        {keepWords(detectionLabel(kind, at))}
      </Text>
      <Button small variant="ghost" label="아니에요" onPress={onReject} disabled={disabled} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 44 },
  text: { flex: 1 },
});
