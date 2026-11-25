import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { confirm, Text, toast } from '@/components/ui';
import { formatTime } from '@/lib/format';

import { confirmEarlyWake } from '../api';
import type { EarlyWake } from '../types';

import { TextLink } from './TextLink';

// [먼저 깼어요] 한 줄 — 기상 알람이 울리기 전 60분 안에 깼을 때 (D61 · 친구 7장). 지금 시각으로 기상 확인, 그룹에는 바로 '일어났어요'
//   홈 다음 알람 아래(입구, 11/9 결정표) · H08 해제 전 화면이 같이 씀. 폰 알람은 그대로 울림(미리 끄기는 알람 코어 몫)
//   카드 한 장이던 것을 한 줄로 줄임 — 왼쪽 질문, 오른쪽 글자 버튼
//   onDone = 기록한 뒤 부르는 쪽이 다시 읽음 (홈은 줄이 사라지고 내 상태가 '일어났어요'로)
export function EarlyWakeCard({ early, onDone }: { early: EarlyWake; onDone?: () => void }) {
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  if (done) {
    return (
      <View style={styles.row}>
        <Text variant="small" tone="sub">
          일어났어요로 기록했어요
        </Text>
      </View>
    );
  }

  const press = async () => {
    if (busy) return;
    // 누르면 오늘 기상 알람이 꺼지고 그룹에도 바로 보여서 되돌릴 수 없음 — 누르기 전에 알림
    const ok = await confirm({
      title: '먼저 깼다고 기록할까요?',
      message: '오늘 기상 알람이 꺼지고, 그룹에도 바로 일어났어요로 보여요.',
      okLabel: '기록',
    });
    if (!ok) return;
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
    <View style={styles.row}>
      <Text variant="small" tone="sub">{`${formatTime(early.at)} 알람 전에 깼나요?`}</Text>
      <TextLink label="먼저 깼어요 ›" onPress={press} disabled={busy} strong />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 28, marginTop: -2, marginBottom: 4, paddingHorizontal: 4 },
});
