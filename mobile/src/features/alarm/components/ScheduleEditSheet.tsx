import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Field, Sheet, Text } from '@/components/ui';
import { formatDateShort, formatTime } from '@/lib/format';
import { colors } from '@/theme';

import { isEditChanged, type ScheduleEditValue } from '../editSheet';

import { RepeatPicker } from './RepeatPicker';

type Props = {
  visible: boolean;
  onClose: () => void;
  initial: ScheduleEditValue; // 처음 값 — 바뀐 게 없으면 [저장]을 흐리게
  value: ScheduleEditValue;
  onChange: (patch: Partial<ScheduleEditValue>) => void;
  onPickPlace: () => void; // 장소 · 날짜 · 시간 고르는 시트는 시트 안에 또 시트를 못 둬서 부르는 쪽이 엶 (시트는 한 번에 하나)
  onPickDate: () => void;
  onPickTime: () => void;
  onSave: () => void;
  onDelete: () => void;
  saving?: boolean;
  onLeave?: () => void; // [나는 빠지기] — 공동 약속만 (만든 사람도, #619)
};

// 일정 편집 시트 (U14, H03 연결 일정 카드를 누르면) — 일정명 · 날짜 · 시간 · 장소 · 반복. 알람 강도 3축은 H03의 알람 강도 카드에서 고름. 맨 아래 진한 버튼은 [저장] 하나, 그 아래 글자 버튼 [일정 삭제] (공동 약속은 [나는 빠지기]도)
// 공동 약속도 그룹원 누구나 고치고 지움 (#619 — 만든 사람은 기록일 뿐)
// 값 · 콜백만 받음 — 저장 · 삭제는 부르는 쪽(features/alarm/hooks/useScheduleEdit)이 함
export function ScheduleEditSheet({ visible, onClose, initial, value, onChange, onPickPlace, onPickDate, onPickTime, onSave, onDelete, saving, onLeave }: Props) {
  return (
    <Sheet visible={visible} onClose={onClose} title="일정 고치기">
      <Field
        first
        label="일정명"
        accessibilityLabel="일정명 (필수)"
        value={value.title}
        onChangeText={(title) => onChange({ title })}
        placeholder="예: 스터디"
        maxLength={30}
      />
      <PickLine label="날짜" value={formatDateShort(value.at)} onPress={onPickDate} />
      <PickLine label="시간" value={formatTime(value.at)} onPress={onPickTime} />
      <PickLine label="장소" value={value.place} placeholder="장소 고르기" onPress={onPickPlace} />
      <Text variant="small" tone="sub" style={styles.optLabel}>
        배경음 · 말소리 · 진동은 이 창을 닫고 알람 설정의 「알람 강도」에서 각각 골라요.
      </Text>
      <View style={styles.repeat}>
        <RepeatPicker value={value.repeatDays} onChange={(repeatDays) => onChange({ repeatDays })} />
      </View>
      <View style={styles.stack}>
        <Button label="저장" onPress={onSave} disabled={!isEditChanged(initial, value)} loading={saving} />
        <DangerLink label="일정 삭제" onPress={onDelete} disabled={saving} />
        {onLeave ? <Button label="나는 빠지기" variant="plain" onPress={onLeave} disabled={saving} /> : null}
      </View>
    </Sheet>
  );
}

// 누르면 고르는 곳이 열리는 줄 — 오른쪽 끝에 ›. 시트는 이 줄이 열지 않음 (부르는 쪽이 엶)
function PickLine({ label, value, placeholder, onPress }: { label: string; value: string; placeholder?: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label} ${value || placeholder || ''}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Text variant="rowLabel" tone="sub">
        {label}
      </Text>
      <View style={styles.rowValue}>
        <Text variant="bodyStrong" tone={value ? 'ink' : 'faint'} numberOfLines={1} style={styles.rowText}>
          {value || placeholder}
        </Text>
        <Text variant="bodyStrong" tone="faint">
          ›
        </Text>
      </View>
    </Pressable>
  );
}

// 위험 톤 글자 버튼 — 진한 버튼은 시트마다 하나라 삭제는 글자만 (경고색)
function DangerLink({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [styles.danger, pressed && styles.pressed, disabled && styles.disabled]}
    >
      <Text variant="button" tone="warn" weight={400}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 14, minHeight: 52, borderTopWidth: 1, borderTopColor: colors.line },
  rowValue: { flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1 },
  rowText: { flexShrink: 1 },
  optLabel: { marginTop: 12, marginBottom: 8 },
  repeat: { marginTop: 16 },
  stack: { gap: 4, marginTop: 20 },
  danger: { height: 44, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  disabled: { opacity: 0.35 },
});
