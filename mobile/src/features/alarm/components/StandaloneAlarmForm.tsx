import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Card, Text } from '@/components/ui';
import { formatTime, minuteOfDay } from '@/lib/format';
import type { Weekday } from '@/lib/weekday';
import { colors } from '@/theme';

import { dayHeading } from '../schedule';
import { defaultRingTime, firstRingAt } from '../standalone';
import { RepeatPicker } from './RepeatPicker';
import { TimeRow } from './TimeRow';

type Props = {
  current: Date; // 화면의 지금 (useNow, 30초마다) — 처음 시각 · 다음 울림 안내가 따라 바뀜
  busy: boolean; // 저장 중
  onSave: (minuteOfDay: number, repeat: readonly Weekday[]) => Promise<boolean>; // 저장했으면 true → 칸을 접고 입력을 비움
};

// 기본 알람 만들기 (H02 알람 탭, #588) — 일정 없이 시각 · 반복만 고르는 알람. 접어 두었다가 눌러서 펼침
// 시간 줄 · 반복 고르기는 H05 새 일정과 같은 부품. 날짜 칸은 없음 — 지금 뒤로 처음 오는 그 시각에 울림 (standalone.ts)
// 값만 고르고 저장은 화면이 함 (hooks/useStandaloneAlarmSave). 목록에는 제목 "알람" 카드로 보임
export function StandaloneAlarmForm({ current, busy, onSave }: Props) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<Date | null>(null); // 안 골랐으면 지금 다음 정각 — 탭을 오래 열어 둬도 지난 정각이 남지 않게
  const [repeat, setRepeat] = useState<Weekday[]>([]);
  const time = picked ?? defaultRingTime(current);
  const at = firstRingAt(minuteOfDay(time), repeat, current);

  const save = async () => {
    if (!(await onSave(minuteOfDay(time), repeat))) return;
    setOpen(false);
    setPicked(null);
    setRepeat([]);
  };

  return (
    <View style={styles.wrap}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityLabel={open ? '기본 알람 만들기 접기' : '기본 알람 만들기 펼치기'}
        accessibilityState={{ expanded: open }}
        style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
      >
        <Text variant="rowLabel">기본 알람 만들기</Text>
        <Text variant="rowLabel" tone="sub">
          {open ? '접기 ⌃' : '펼치기 ⌄'}
        </Text>
      </Pressable>
      {open ? (
        <Card>
          <TimeRow first label="시간" value={time} onChange={setPicked} />
          <RepeatPicker value={repeat} onChange={setRepeat} />
          <Text variant="caption" tone="sub" style={styles.next} accessibilityLiveRegion="polite">
            {`${dayHeading(at, current)} ${formatTime(at)}에 울려요`}
          </Text>
          <Button label="알람 저장" loading={busy} onPress={() => void save()} />
        </Card>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginTop: 12 },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingHorizontal: 4,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  pressed: { opacity: 0.6 },
  next: { marginTop: 14, marginBottom: 12 },
});
