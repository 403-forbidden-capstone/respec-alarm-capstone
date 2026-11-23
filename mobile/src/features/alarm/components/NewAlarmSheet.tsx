import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Sheet, Text } from '@/components/ui';
import { formatTime, minuteOfDay } from '@/lib/format';
import type { Weekday } from '@/lib/weekday';

import { dayHeading } from '../schedule';
import { defaultRingTime, firstRingAt } from '../standalone';
import { RepeatPicker } from './RepeatPicker';
import { TimePicker } from './TimePicker';

type Props = {
  visible: boolean;
  onClose: () => void;
  current: Date; // 화면의 지금 (useNow, 30초마다) — 처음 시각 · 다음 울림 안내가 따라 바뀜
  busy: boolean; // 저장 중
  onSave: (minuteOfDay: number, repeat: readonly Weekday[]) => Promise<boolean>; // 저장했으면 true → 시트를 닫고 입력을 비움
};

// 새 알람 (H02 알람 탭 위 줄 "+ 새 알람", #588) — 일정 없이 시각 · 반복만 고르는 기본 알람
// 시 · 분 고르기 · 반복 고르기는 H05 새 일정과 같은 부품. 시트는 한 번에 하나만 뜨므로(SheetHost) 시간은 시트 안에서 바로 고름
// 날짜 칸은 없음 — 지금 뒤로 처음 오는 그 시각에 울림 (standalone.ts). 값만 고르고 저장은 화면이 함 (hooks/useStandaloneAlarmSave)
export function NewAlarmSheet({ visible, onClose, current, busy, onSave }: Props) {
  const [picked, setPicked] = useState<Date | null>(null); // 안 골랐으면 지금 다음 정각 — 탭을 오래 열어 둬도 지난 정각이 남지 않게
  const [repeat, setRepeat] = useState<Weekday[]>([]);
  const time = picked ?? defaultRingTime(current);
  const at = firstRingAt(minuteOfDay(time), repeat, current);

  const save = async () => {
    if (!(await onSave(minuteOfDay(time), repeat))) return;
    setPicked(null);
    setRepeat([]);
    onClose();
  };

  return (
    <Sheet visible={visible} onClose={onClose} title="새 알람">
      <TimePicker value={time} onChange={setPicked} />
      <View style={styles.repeat}>
        <RepeatPicker value={repeat} onChange={setRepeat} />
      </View>
      <Text variant="caption" tone="sub" align="center" style={styles.next} accessibilityLiveRegion="polite">
        {`${dayHeading(at, current)} ${formatTime(at)}에 울려요`}
      </Text>
      <Button label="알람 저장" loading={busy} onPress={() => void save()} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  repeat: { marginTop: 16 },
  next: { marginTop: 12, marginBottom: 14 },
});
