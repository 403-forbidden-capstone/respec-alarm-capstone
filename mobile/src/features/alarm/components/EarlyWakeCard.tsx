import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, Text, toast } from '@/components/ui';
import { formatTime } from '@/lib/format';

import { confirmEarlyWake } from '../api';
import type { EarlyWake } from '../types';

// [먼저 깼어요] 카드 — 기상 알람이 울리기 전 60분 안에 깼을 때 (D61 · 친구 7장). 지금 시각으로 기상 확인, 그룹에는 바로 '일어났어요'
//   홈 다음 알람 아래(입구, 11/9 결정표) · H08 해제 전 화면이 같이 씀. 폰 알람은 그대로 울림(미리 끄기는 알람 코어 몫)
//   onDone = 기록한 뒤 부르는 쪽이 다시 읽음 (홈은 카드가 사라지고 내 상태가 '일어났어요'로)
export function EarlyWakeCard({ early, onDone }: { early: EarlyWake; onDone?: () => void }) {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  if (done) {
    return (
      <Card>
        <Text variant="bodyStrong">일어났어요로 기록했어요</Text>
        <Text variant="small" tone="sub" style={styles.sub}>
          그룹 약속이 있는 날이면 그룹에도 바로 보여요.
        </Text>
      </Card>
    );
  }

  const press = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await confirmEarlyWake(early.alarmId);
      setDone(true);
      onDone?.();
    } catch {
      toast('기록하지 못했어요. 다시 눌러 주세요');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Text variant="bodyStrong">{`${formatTime(early.at)} 알람 전에 깼나요?`}</Text>
      <Text variant="small" tone="sub" style={styles.sub}>
        누르면 지금 시각으로 기상을 기록해요.
      </Text>
      <View style={styles.button}>
        <Button label="먼저 깼어요" small loading={busy} onPress={press} />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  sub: { marginTop: 4 },
  button: { marginTop: 12, alignItems: 'flex-start' },
});
