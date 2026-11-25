import { StyleSheet } from 'react-native';

import { Card } from '@/components/ui';
import type { Place } from '@/features/alarm/types';

import { PickRow } from './PickRow';

type Props = {
  campus: Place | null;
  onOpen: () => void; // 학교 찾기 시트는 부르는 화면이 엶
  disabled?: boolean;
};

// 학교 한 번 고르기 — 학교를 정하면 모든 수업의 이동시간을 이 위치로 구함 (가져온 수업은 건물 글자만 있고 좌표가 없어서, 직접 넣는 수업은 줄마다 장소를 고르지 않게).
// 건물마다 따로 정하고 싶은 줄은 그 줄의 [장소]에서 고르면 그 줄만 바뀜. 값 · 콜백만 받음
export function CampusCard({ campus, onOpen, disabled }: Props) {
  return (
    <Card style={styles.card}>
      <PickRow first label="학교" value={campus?.name ?? null} placeholder="학교 고르기" onPress={disabled ? () => {} : onOpen} />
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 12, paddingVertical: 0 },
});
