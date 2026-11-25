import { StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';

import type { ImportNotice } from '../timetableImport';

type Props = {
  notice: ImportNotice;
  onDismiss: () => void;
};

// 안내 카드 한 장 — 빨간 글 대신 카드가 안내임을 보여 줌 (경고여도 글자는 본문 색)
// 사진 · 캘린더에서 가져온 직후 확인 화면 맨 위 안내 — 몇 개를 가져왔는지, 뭘 확인해야 하는지. 값 · 콜백만 받음
export function ImportNoticeCard({ notice, onDismiss }: Props) {
  return (
    <Card style={styles.card}>
      <View accessibilityLiveRegion="polite">
        <Text variant="rowLabel" weight={600} tone="ink">
          {notice.headline}
        </Text>
        {notice.details.map((line) => (
          <Text key={line} variant="small" tone="sub" style={styles.line}>
            {line}
          </Text>
        ))}
      </View>
      <View style={styles.foot}>
        <TextLink label="닫기" onPress={onDismiss} accessibilityLabel="안내 닫기" />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { marginBottom: 12 },
  line: { marginTop: 4 },
  foot: { alignItems: 'flex-end', marginTop: 8 },
});
