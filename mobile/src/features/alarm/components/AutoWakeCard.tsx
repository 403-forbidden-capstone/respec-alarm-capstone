import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Card, Text, toast } from '@/components/ui';
import { formatTime } from '@/lib/format';

import { correctAutoWake } from '../api';
import { TextLink } from './TextLink';
import type { AutoWake } from '../types';

// 자동 판정(화면 사용)으로 기상이 확정되면 그 순간 홈에 뜨는 카드 — "기상 오전 7:11 [아니에요]" (D61 판정마다 그 자리에서 1탭 정정)
//   [아니에요] → 그 확정을 취소하고 H08 확인 단계로 되돌림(직접 [일어났어요]). 친구 화면은 자동 판정을 20분 늦게 공개하니 그 안에 고치면 친구에게는 안 보임
//   onDone = 취소한 뒤 부르는 쪽이 다시 읽음 (카드가 사라지고 H08 입구가 보임)
export function AutoWakeCard({ wake, onDone }: { wake: AutoWake; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);

  const press = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const fixed = await correctAutoWake(wake.alarmId, wake.at);
      onDone?.();
      if (fixed) router.push({ pathname: '/wake', params: { alarm: wake.alarmId } });
    } catch {
      toast('고치지 못했어요. 다시 눌러 주세요');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <View style={styles.row}>
        <View style={styles.text}>
          <Text variant="bodyStrong">{`기상 ${formatTime(wake.at)}`}</Text>
          <Text variant="small" tone="sub">
            폰 사용을 보고 일어난 것으로 확인했어요
          </Text>
        </View>
        <TextLink label="아니에요" onPress={press} accessibilityLabel={`기상 ${formatTime(wake.at)} 취소`} strong />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  text: { flex: 1, gap: 2 },
});
