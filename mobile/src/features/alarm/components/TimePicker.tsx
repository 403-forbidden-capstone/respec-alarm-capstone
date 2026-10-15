import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Sheet, Stepper, Text } from '@/components/ui';
import { addMinutes, formatTime, minuteOfDay, startOfDay } from '@/lib/format';

import { TextLink } from './TextLink';

type PickerProps = {
  value: Date; // 고른 날짜의 그 시각
  onChange: (next: Date) => void; // 날짜는 그대로, 시 · 분만 바뀜
  error?: string; // 붉게 (예: 이미 지난 시각이에요)
};

// 시 · 분 고르기 (목업의 input type="time") — 시트 안에 놓는 본문. TimeRow(H05 시간 칸) · TimeSheet(H03 알람 시각) · H05 확인 시트가 같이 씀
// 시는 24시간(23 다음 0), 분은 1분 단위(59 다음 0), 둘 다 숫자를 눌러 직접 적을 수 있음 (범위 밖은 범위 안으로 맞춤)
// 맨 위 큰 글자는 화면의 시각과 같은 12시간 표기(오후 2:07) — 조절하는 대로 바뀜
export function TimePicker({ value, onChange, error }: PickerProps) {
  const minutes = minuteOfDay(value);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60; // 대화에서 찾은 14:07 같은 값도 그대로
  const set = (h: number, m: number) => onChange(addMinutes(startOfDay(value), h * 60 + m));

  return (
    <>
      <Text variant="stat" align="center" style={styles.preview} accessibilityLiveRegion="polite">
        {formatTime(value)}
      </Text>
      <Stepper first label="시 (24시간)" value={hour} step={1} min={0} max={23} unit="시" wrap onChange={(h) => set(h, minute)} />
      <Stepper label="분" value={minute} step={1} min={0} max={59} unit="분" wrap onChange={(m) => set(hour, m)} />
      {error ? (
        <Text variant="caption" tone="warn" align="center" style={styles.error} accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : null}
    </>
  );
}

type BodyProps = {
  value: Date; // 처음 시각 — 열려 있는 동안 고른 값은 이 본문이 들고 있음 (부모가 다시 계산하는 중에도 숫자가 안 밀리게)
  onChange: (next: Date) => void; // 바뀔 때마다
  onDone: () => void; // "확인"
  autoAt?: Date; // 직접 고른 시각이면 자동 계산값 — 있으면 "자동으로 되돌리기"가 보임
  onReset?: () => void;
  note?: string; // 시각 아래 안내 (예: 준비 알람도 같이 움직여요)
  error?: string;
};

// 알람 시각 하나를 고르는 시트 본문 (H03 · H05 확인 시트, D42 C · D43) — 직접 고른 시각은 자동 계산보다 먼저 쓰임
export function TimePickBody({ value, onChange, onDone, autoAt, onReset, note, error }: BodyProps) {
  const [picked, setPicked] = useState(value);

  return (
    <>
      <TimePicker
        value={picked}
        error={error}
        onChange={(next) => {
          setPicked(next);
          onChange(next);
        }}
      />
      {note ? (
        <Text variant="caption" tone="faint" align="center" style={styles.note}>
          {note}
        </Text>
      ) : null}
      {autoAt && onReset ? (
        <View style={styles.reset}>
          <TextLink
            label={`자동으로 되돌리기 · ${formatTime(autoAt)}`}
            onPress={() => {
              setPicked(autoAt);
              onReset();
            }}
          />
        </View>
      ) : null}
      <View style={styles.done}>
        <Button label="확인" onPress={onDone} />
      </View>
    </>
  );
}

type SheetProps = Omit<BodyProps, 'onDone'> & {
  visible: boolean;
  onClose: () => void;
  title: string;
};

// 알람 시각을 고르는 시트 (H03) — 닫기 · 확인 모두 고른 값을 그대로 둠
export function TimeSheet({ visible, onClose, title, ...body }: SheetProps) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <TimePickBody {...body} onDone={onClose} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  preview: { marginTop: 10, marginBottom: 14 },
  error: { marginTop: 8 },
  note: { marginTop: 10 },
  reset: { marginTop: 10, alignItems: 'center' },
  done: { marginTop: 16 },
});
