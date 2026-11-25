import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card, Text } from '@/components/ui';
import { colors, size } from '@/theme';

import { AGE_CHECK_HINT, AGE_CHECK_LABEL, type ConsentItem } from '../consent';
import { useAccent } from '@/lib/skyTone';

type Props = {
  items: readonly ConsentItem[];
  ageChecked?: boolean; // 만 14세 이상 확인 — 없으면(이미 이 판에 동의한 계정) 체크 줄을 안 그림
  onAgeChange?: (next: boolean) => void;
};

// 개인정보 안내 단계 (L02-7) — 항목마다 읽는 것 / 안 읽는 것 / 친구에게 보이는 것. 동의 저장은 부르는 화면이 함
export function ConsentStep({ items, ageChecked, onAgeChange }: Props) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set()); // 펼친 항목
  const toggle = (key: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  return (
    <>
      <Text variant="small" tone="sub" style={styles.summary}>
        {items.length}가지를 읽어요. 눌러서 자세히 볼 수 있어요
      </Text>
      <Card style={styles.list}>
        {items.map((item, i) => {
          const on = open.has(item.key);
          return (
            <View key={item.key} style={i > 0 && styles.divider}>
              <Pressable
                onPress={() => toggle(item.key)}
                accessibilityRole="button"
                accessibilityLabel={item.title}
                accessibilityState={{ expanded: on }}
                style={({ pressed }) => [styles.head, pressed && styles.pressed]}
              >
                <Text variant="bodyStrong">{item.title}</Text>
                <Text variant="bodyStrong" tone="faint">
                  {on ? '⌃' : '›'}
                </Text>
              </Pressable>
              {on ? (
                <View style={styles.detail}>
                  <Line label="읽는 것" text={item.reads} />
                  <Line label="안 읽는 것" text={item.doesNotRead} />
                  <Line label="친구에게 보이는 것" text={item.friends} />
                </View>
              ) : null}
            </View>
          );
        })}
      </Card>
      {onAgeChange ? <AgeCheck checked={!!ageChecked} onChange={onAgeChange} /> : null}
    </>
  );
}

// 만 14세 이상 확인 줄 — 온보딩은 이걸 틀(OnboardingFrame)의 aboveFooter로 [동의하고 계속] 바로 위에 둠. 다시 동의 화면(reconsent)은 ConsentStep 안에 그림
export function AgeCheck({ checked, onChange, showHint = true }: { checked: boolean; onChange: (next: boolean) => void; showHint?: boolean }) {
  const accent = useAccent(); // 포인트 색 — 그 시각 하늘과 같은 계열 (lib/skyTone)
  return (
    <Pressable
      onPress={() => onChange(!checked)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={AGE_CHECK_LABEL}
      style={styles.age}
    >
      <View style={[styles.box, checked && [styles.boxOn, { backgroundColor: accent }]]}>{checked ? <Text variant="small" style={styles.tick}>✓</Text> : null}</View>
      <View style={styles.ageText}>
        <Text variant="bodyStrong">{AGE_CHECK_LABEL}</Text>
        {!checked && showHint ? (
          <Text variant="small" tone="sub">
            {AGE_CHECK_HINT}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

function Line({ label, text }: { label: string; text: string }) {
  return (
    <View style={styles.line}>
      <Text variant="small">{label}</Text>
      <Text variant="body">{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  summary: { marginBottom: 10 },
  list: { paddingVertical: 4 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: size.touch },
  pressed: { opacity: 0.6 },
  detail: { paddingBottom: 14 },
  line: { marginTop: 8, gap: 2 },
  age: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 },
  box: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  boxOn: { backgroundColor: colors.ink },
  tick: { color: colors.card },
  ageText: { flex: 1, minWidth: 0 },
});
