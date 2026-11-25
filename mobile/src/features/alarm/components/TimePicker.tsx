import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Segmented, Sheet, Stepper, Text } from '@/components/ui';
import { addMinutes, formatTime, minuteOfDay, startOfDay } from '@/lib/format';

import { TextLink } from './TextLink';

type PickerProps = {
  value: Date; // 고른 날짜의 그 시각
  onChange: (next: Date) => void; // 날짜는 그대로, 시 · 분만 바뀜
  error?: string; // 붉게 (예: 이미 지난 시각이에요)
  minuteStep?: number; // 분 [−][+] 한 칸 (기본 1분, 새 알람 시트는 5분). 숫자를 눌러 적는 값은 1분 단위 그대로
};

const AMPM = [
  ['am', '오전'],
  ['pm', '오후'],
] as const;

// 12시간 표기의 시(1~12) + 오전/오후 → 0~23
const toHour24 = (hour12: number, pm: boolean) => (hour12 % 12) + (pm ? 12 : 0);

// 시 · 분 고르기 (목업의 input type="time") — 시트 안에 놓는 본문. TimeRow(H05 시간 칸) · TimeSheet(H03 알람 시각) · H05 확인 시트가 같이 씀
// 맨 위 큰 글자(오후 2:07)와 같은 12시간 표기로 고름: 오전/오후 + 시(1~12, 12 다음 1) + 분(1분 단위, 59 다음 0, D42 C · D53)
// 시 · 분은 숫자를 눌러 직접 적을 수 있음 (범위 밖은 범위 안으로 맞춤). 큰 글자는 조절하는 대로 바뀜
export function TimePicker({ value, onChange, error, minuteStep = 1 }: PickerProps) {
  const minutes = minuteOfDay(value);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60; // 대화에서 찾은 14:07 같은 값도 그대로
  const pm = hour >= 12;
  const hour12 = hour % 12 || 12;
  const set = (h: number, m: number) => onChange(addMinutes(startOfDay(value), h * 60 + m));

  return (
    <>
      <Text variant="stat" align="center" style={styles.preview} accessibilityLiveRegion="polite">
        {formatTime(value)}
      </Text>
      <Segmented options={AMPM} value={pm ? 'pm' : 'am'} onChange={(v) => set(toHour24(hour12, v === 'pm'), minute)} />
      <Stepper first label="시" value={hour12} step={1} min={1} max={12} unit="시" wrap onChange={(h) => set(toHour24(h, pm), minute)} />
      <Stepper label="분" value={minute} step={minuteStep} min={0} max={59} unit="분" wrap typeExact onChange={(m) => set(hour, m)} />
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
  onDone: (picked: Date) => void; // "확인" — 그때 보이던 시각을 줌 (안 건드리고 확인만 눌러도 그 시각)
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
        <Button label="확인" onPress={() => onDone(picked)} />
      </View>
    </>
  );
}

type SheetProps = Omit<BodyProps, 'onDone'> & {
  visible: boolean;
  onConfirm?: (picked: Date) => void; // "확인"을 눌렀을 때만 (닫기 · 바깥 누름은 안 불림)
  onClose: () => void;
  title: string;
};

// 알람 시각을 고르는 시트 (H03) — 닫기 · 확인 모두 고른 값을 그대로 둠
export function TimeSheet({ visible, onClose, onConfirm, title, ...body }: SheetProps) {
  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <TimePickBody
        {...body}
        onDone={(picked) => {
          onConfirm?.(picked);
          onClose();
        }}
      />
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
