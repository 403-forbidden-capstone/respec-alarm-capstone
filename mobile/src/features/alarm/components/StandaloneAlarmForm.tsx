import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Card, Text, toast } from '@/components/ui';
import { askNotifications } from '@/features/permissions';
import { now } from '@/lib/clock';
import { formatTime, minuteOfDay } from '@/lib/format';
import { useAction } from '@/lib/useAction';
import type { Weekday } from '@/lib/weekday';
import { colors } from '@/theme';

import { createStandaloneAlarm } from '../api';
import { saveNotice } from '../saveNotice';
import { dayHeading } from '../schedule';
import { defaultRingTime, firstRingAt } from '../standalone';
import { RepeatPicker } from './RepeatPicker';
import { TimeRow } from './TimeRow';

type Props = {
  current: Date; // 화면의 지금 (1분마다 바뀜) — 다음 울림 안내가 따라 바뀜
  onSaved: (id: string) => void; // 저장한 알람 id — 목록을 다시 읽고 그 카드를 강조
};

// 기본 알람 만들기 (H02 알람 탭, #588) — 일정 없이 시각 · 반복만 고르는 알람. 접어 두었다가 눌러서 펼침
// 시간 줄 · 반복 고르기는 H05 새 일정과 같은 부품. 날짜 칸은 없음 — 지금 뒤로 처음 오는 그 시각에 울림 (standalone.ts)
// 저장은 alarm-commit STANDALONE (api.ts createStandaloneAlarm, 실데이터 전용). 목록에는 제목 "알람" 카드로 보임
export function StandaloneAlarmForm({ current, onSaved }: Props) {
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState(() => defaultRingTime(now()));
  const [repeat, setRepeat] = useState<Weekday[]>([]);
  const { busy, run } = useAction();
  const at = firstRingAt(minuteOfDay(time), repeat, current);

  const save = () =>
    run(async () => {
      const first = firstRingAt(minuteOfDay(time), repeat, now()); // 화면의 지금은 1분 늦을 수 있어 저장 순간으로 다시
      const saved = await createStandaloneAlarm({ at: first, repeat });
      toast(saveNotice(saved.followUp, '알람은 저장했지만') ?? `알람을 만들었어요 · ${dayHeading(first, now())} ${formatTime(first)}`);
      void askNotifications('alarm');
      setOpen(false);
      setRepeat([]);
      onSaved(saved.id);
    }, '알람을 저장하지 못했어요');

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
          <TimeRow first label="시간" value={time} onChange={setTime} />
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
