import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

import { Text } from '@/components/ui';
import { addMinutes, minuteOfDay, startOfDay } from '@/lib/format';
import { colors, radius } from '@/theme';

const ROW = 44;
const ROWS = 5;
const PAD = ROW * 2;
const HOURS = Array.from({ length: 12 }, (_, i) => String(i + 1));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));
const PERIODS = ['오전', '오후'];

type WheelProps = {
  label: string;
  options: readonly string[];
  value: number;
  onChange: (index: number) => void;
  loop?: boolean;
};

// 동일한 요일/시각 저장 계약을 유지하고 스크롤 위치만 선택값으로 변환한다.
export function wheelIndex(offset: number, length: number) {
  return Math.max(0, Math.min(length - 1, Math.round(offset / ROW)));
}

function Wheel({ label, options, value, onChange, loop = false }: WheelProps) {
  const count = options.length;
  const entries = loop ? [...options, ...options, ...options] : options;
  const middle = (index: number) => index + (loop ? count : 0);
  const initial = useRef({ x: 0, y: middle(value) * ROW }).current;
  const scroll = useRef<ScrollView>(null);
  const ready = useRef(false);
  const selected = useRef(middle(value));
  const logical = useRef(value);
  const offset = useRef(initial.y);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [active, setActive] = useState(selected.current);
  const change = useRef(onChange);
  change.current = onChange;

  const position = (index: number) => {
    selected.current = index;
    offset.current = index * ROW;
    setActive(index);
    scroll.current?.scrollTo({ y: index * ROW, animated: false });
  };

  const emit = (index: number) => {
    selected.current = index;
    setActive(index);
    const next = index % count;
    if (logical.current !== next) {
      logical.current = next;
      change.current(next);
    }
  };

  // 외부에서 값이 바뀌는 경우(직접 입력, 초기값 갱신)만 휠을 이동한다.
  useEffect(() => {
    if (logical.current === value) return;
    logical.current = value;
    if (timer.current) clearTimeout(timer.current);
    position(middle(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const settle = () => {
    const index = wheelIndex(offset.current, entries.length);
    emit(index);
    const target = loop && (index < count || index >= count * 2) ? middle(index % count) : index;
    if (Math.abs(offset.current - target * ROW) > 1) position(target);
  };

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!ready.current) return;
    offset.current = event.nativeEvent.contentOffset.y;
    const index = wheelIndex(offset.current, entries.length);
    if (index !== selected.current) emit(index);
    if (timer.current) clearTimeout(timer.current);
    // RN Web에는 native snap 동작이 없을 수 있어 휠 정지 후에도 가운데로 맞춘다.
    timer.current = setTimeout(settle, 160);
  };

  const choose = (index: number) => {
    if (timer.current) clearTimeout(timer.current);
    emit(index);
    position(loop ? middle(index % count) : index);
  };

  return (
    <View style={styles.column} accessible accessibilityRole="adjustable"
      accessibilityLabel={label} accessibilityValue={{ text: options[value] }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => {
        const delta = event.nativeEvent.actionName === 'increment' ? 1 : -1;
        const next = loop ? (value + delta + count) % count : Math.max(0, Math.min(count - 1, value + delta));
        choose(middle(next));
      }}>
      <ScrollView
        ref={scroll}
        style={styles.scroll}
        contentContainerStyle={styles.content}
        contentOffset={initial}
        onContentSizeChange={() => {
          if (ready.current) return;
          ready.current = true;
          scroll.current?.scrollTo({ y: selected.current * ROW, animated: false });
        }}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
        snapToInterval={ROW}
        decelerationRate="fast"
        bounces={false}
        overScrollMode="never"
        scrollEventThrottle={16}
        onScroll={onScroll}
      >
        {entries.map((item, index) => {
          const distance = Math.abs(index - active);
          return (
            <Pressable key={index} style={styles.item} onPress={() => choose(index)}
              accessibilityLabel={label + ' ' + item} accessibilityRole="button" accessibilityState={{ selected: distance === 0 }}>
              <Text variant="compare" weight={distance === 0 ? 600 : 400} tone={distance === 0 ? 'ink' : 'faint'}
                style={distance > 1 ? styles.outer : undefined}>
                {item}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

export function changeWheelTime(value: Date, part: 'hour' | 'minute' | 'period', index: number): Date {
  const current = minuteOfDay(value);
  const h = Math.floor(current / 60);
  const m = current % 60;
  const nextHour = part === 'hour' ? ((index + 1) % 12) + (h >= 12 ? 12 : 0)
    : part === 'period' ? h % 12 + index * 12 : h;
  return addMinutes(startOfDay(value), nextHour * 60 + (part === 'minute' ? index : m));
}

export function AlarmWheelPicker({ value, onChange }: { value: Date; onChange: (next: Date) => void }) {
  const latest = useRef(value);
  latest.current = value;
  const minute = minuteOfDay(value);
  const hour = Math.floor(minute / 60);
  // 두 열을 빠르게 연달아 움직여도 직전에 선택한 다른 열의 값을 유지한다.
  const update = (part: 'hour' | 'minute' | 'period', index: number) => {
    const next = changeWheelTime(latest.current, part, index);
    latest.current = next;
    onChange(next);
  };
  return (
    <View style={styles.wrap}>
      <View pointerEvents="none" style={styles.selection} />
      <Wheel label="오전 오후" options={PERIODS} value={hour >= 12 ? 1 : 0} onChange={(i) => update('period', i)} />
      <Wheel label="시" options={HOURS} value={(hour % 12 || 12) - 1} loop onChange={(i) => update('hour', i)} />
      <View pointerEvents="none" style={styles.separator}><Text variant="compare">:</Text></View>
      <Wheel label="분" options={MINUTES} value={minute % 60} loop onChange={(i) => update('minute', i)} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', height: ROW * ROWS, paddingHorizontal: 16 },
  selection: { position: 'absolute', left: 0, right: 0, top: PAD, height: ROW, backgroundColor: colors.chip, borderRadius: radius.field },
  column: { flex: 1, minWidth: 0, height: ROW * ROWS },
  scroll: { flex: 1 },
  content: { paddingVertical: PAD },
  item: { height: ROW, alignItems: 'center', justifyContent: 'center' },
  outer: { opacity: 0.58 },
  separator: { width: 12, alignItems: 'center' },
});
