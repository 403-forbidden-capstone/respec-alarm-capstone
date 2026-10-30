import { StyleSheet, View } from 'react-native';

import { Button, Card, Text } from '@/components/ui';
import type { Place } from '@/features/alarm/types';

type Props = {
  campus: Place | null;
  onOpen: () => void; // 학교 찾기 시트는 부르는 화면이 엶
  disabled?: boolean;
};

// 학교 위치 한 번에 맞추기 — 가져온 수업은 건물 이름 글자만 있고 좌표가 없어 이동시간을 못 구하므로, 학교(캠퍼스)를 한 번 정하면 모든 줄에 적용됨.
// 건물마다 따로 찾고 싶으면 줄의 [장소]에서 고르면 그 줄만 바뀜. 값 · 콜백만 받음
export function CampusCard({ campus, onOpen, disabled }: Props) {
  return (
    <Card style={styles.card}>
      <Text variant="rowLabel" weight={600}>
        학교 위치
      </Text>
      <Text variant="small" tone="sub" style={styles.lead}>
        학교를 한 번 정하면 모든 수업의 이동시간을 구해요
      </Text>
      <View style={styles.row}>
        <Button
          variant={campus ? 'ghost' : 'primary'}
          small
          label={campus ? `${campus.name} · 바꾸기` : '학교 찾기'}
          onPress={onOpen}
          disabled={disabled}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 12 },
  lead: { marginTop: 4 },
  row: { marginTop: 12, flexDirection: 'row' },
});
