import { StyleSheet } from 'react-native';

import { Text } from '@/components/ui';
import { keepWords } from '@/lib/format';

// 기상 공유 안내 단계 (L02-9) — 안내만, 저장 없음
// D94 기본안 A — 그룹에 들어갈 때 기상 공유를 물어보고, 사람별로 숨길 수 있음
export function ShareStep() {
  return (
    <>
      <Text variant="body">{keepWords('그룹에 들어갈 때 기상 공유를 물어요')}</Text>
      <Text variant="body" style={styles.second}>
        {keepWords('사람별로 숨길 수 있어요')}
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  second: { marginTop: 8 },
});
