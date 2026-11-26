import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Segmented, Sheet, Text } from '@/components/ui';
import { formatTime, minuteOfDay } from '@/lib/format';
import type { Weekday } from '@/lib/weekday';

import { dayHeading } from '../schedule';
import { defaultRingTime, firstRingAt } from '../standalone';
import { LEVELS, type Level } from '../types';
import { AlarmRepeatPicker } from './AlarmRepeatPicker';
import { TimePicker } from './TimePicker';

type Props = {
  visible: boolean;
  onClose: () => void;
  current: Date; // 화면의 지금 (useNow, 30초마다) — 처음 시각 · 다음 울림 안내가 따라 바뀜
  busy: boolean; // 저장 중
  onSave: (minuteOfDay: number, repeat: readonly Weekday[], level: Level) => Promise<boolean>; // 저장했으면 true → 시트를 닫고 입력을 비움
  // 고치기 (알람 카드를 누름) — 지금 값으로 채우고 강도 칸 · 삭제 버튼을 보임. 알람마다 화면이 key를 바꿔 다시 그림
  editing?: { at: Date; repeat: readonly Weekday[]; level: Level };
  onDelete?: () => Promise<boolean>; // 지웠으면 true → 시트를 닫음 (확인 팝업은 화면 쪽)
};

const LEVEL_OPTIONS = LEVELS.map((x, i) => [String(i), x.name] as const);

// 새 알람 (H02 알람 탭 위 줄 "+ 새 알람", #588) — 일정 없이 시각 · 반복만 고르는 기본 알람
// 일반 알람은 공용 시간 휠과 요일 선택(미선택이면 한 번만)을 사용한다.
// 날짜 칸은 없음 — 지금 뒤로 처음 오는 그 시각에 울림 (standalone.ts). 값만 고르고 저장은 화면이 함 (hooks/useStandaloneAlarmSave)
export function NewAlarmSheet({ visible, onClose, current, busy, onSave, editing, onDelete }: Props) {
  const [picked, setPicked] = useState<Date | null>(editing?.at ?? null); // 안 골랐으면 지금 다음 정각 — 탭을 오래 열어 둬도 지난 정각이 남지 않게
  const [repeat, setRepeat] = useState<Weekday[]>(editing ? [...editing.repeat] : []);
  const [level, setLevel] = useState<Level>(editing?.level ?? 1);
  const time = picked ?? defaultRingTime(current);
  const at = firstRingAt(minuteOfDay(time), repeat, current);

  const save = async () => {
    if (!(await onSave(minuteOfDay(time), repeat, level))) return;
    setPicked(null);
    setRepeat([]);
    onClose();
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={editing ? '알람 수정' : '새 알람'}>
      <TimePicker value={time} onChange={setPicked} />
      <View style={styles.repeat}>
        <AlarmRepeatPicker value={repeat} onChange={setRepeat} />
      </View>
      {editing ? (
        <View style={styles.repeat}>
          <Text variant="rowLabel" tone="sub" style={styles.label}>
            알람 강도
          </Text>
          <Segmented options={LEVEL_OPTIONS} value={String(level)} onChange={(v) => setLevel(Number(v) as Level)} />
        </View>
      ) : null}
      <Text variant="caption" tone="sub" align="center" style={styles.next} accessibilityLiveRegion="polite">
        {`${dayHeading(at, current)} ${formatTime(at)}에 울려요`}
      </Text>
      <Button label="알람 저장" loading={busy} onPress={() => void save()} />
      {onDelete ? (
        <View style={styles.delete}>
          <Button label="알람 삭제" variant="danger" disabled={busy} onPress={() => void onDelete().then((done) => done && onClose())} />
        </View>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  repeat: { marginTop: 16 },
  next: { marginTop: 12, marginBottom: 14 },
  label: { marginBottom: 8 },
  delete: { marginTop: 10 },
});
