import { StyleSheet } from 'react-native';

import { Card, Text } from '@/components/ui';
import { useLoad } from '@/lib/useLoad';

import { getReceivedWakePings } from '../api';
import { receivedPingLine } from '../wakeTexts';

// 오늘 받은 깨우기 한 줄 '수연님이 7:12에 깨웠어요' (친구 8장 · 8-18) — 홈 · H08. 없으면 아무것도 안 그림, 못 읽어도 조용히 숨김(덤 정보)
//   화면에 들어올 때마다 다시 읽음(useLoad). 가짜 모드는 받은 깨우기가 없어 안 보임
export function ReceivedWakePingLine() {
  const { data } = useLoad(getReceivedWakePings);
  const line = data ? receivedPingLine(data) : null;
  if (!line) return null;
  return (
    <Card>
      <Text variant="bodyStrong" style={styles.line} accessibilityLiveRegion="polite">
        {line}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({ line: { lineHeight: 22 } });
