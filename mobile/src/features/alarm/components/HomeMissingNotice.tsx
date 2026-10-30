import { StyleSheet, View } from 'react-native';

import { Button, Card, Text } from '@/components/ui';
import { keepWords } from '@/lib/format';

type Props = {
  onPickHome: () => void; // [집 정하기] — 집 찾기 시트를 여는 일은 부르는 쪽
  busy?: boolean; // 집을 저장하는 중 — 버튼이 돌아가고 누를 수 없음
};

// 새 일정 계산이 집 위치를 몰라 막혔을 때 (H05) — 이유 + 집 정하기. 점선 카드 방식은 LoadError와 같음
// 진한 버튼은 화면 아래 [알람 계산하기] 하나만 두려고 ghost 버튼
// <HomeMissingNotice onPickHome={() => setHomeSheetOpen(true)} busy={saving} />
export function HomeMissingNotice({ onPickHome, busy }: Props) {
  return (
    <Card variant="dash">
      <View accessibilityLiveRegion="polite">
        <Text variant="bodyStrong">{keepWords('집 위치를 몰라 이동시간을 구하지 못했어요')}</Text>
        <Text variant="body" tone="sub" style={styles.body}>
          {keepWords('집을 정해 두면 집에서 출발하는 시각까지 계산해요')}
        </Text>
      </View>
      <View style={styles.button}>
        <Button variant="ghost" label="집 정하기" onPress={onPickHome} loading={busy} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { marginTop: 4 },
  button: { marginTop: 12 },
});
