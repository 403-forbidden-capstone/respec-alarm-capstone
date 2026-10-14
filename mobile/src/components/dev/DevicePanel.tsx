import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Button, Segmented, Text, toast } from '@/components/ui';
import {
  DEVICE_QUERY,
  DEVICE_STORAGE_KEY,
  DEVICES,
  PANEL_COLLAPSED_WIDTH,
  PANEL_WIDTH,
  type Device,
} from '@/dev/devices';
import { SECTIONS } from '@/dev/screenList';
import type { ScenarioTime } from '@/lib/clock';
import { colors, radius } from '@/theme';

// 웹 미리보기 왼쪽 패널 (DeviceFrame.web.tsx만 씀) — 기종 선택 · 화면 목록 · 시나리오 시각 · 세션 · 바로 가기

type Props = {
  device: Device;
  scale: number;
  onDevice: (id: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  scenario: ScenarioTime;
  onScenario: (next: ScenarioTime) => void;
  canScenario: boolean; // 가짜 데이터 모드에서만 시나리오 시각이 있음
};

const TIMES = [
  ['morning', '아침 07:55'],
  ['evening', '전날 밤 21:00'],
] as const;

const LINKS = [
  ['/board', '개발 보드'],
  ['/lab/', 'AI 실험실'],
  ['/dev/ui', 'UI 견본'],
] as const;

// 이 앱이 localStorage에 쓰는 키 — 데이터 모드(respec.dataMode) · 로그인 세션(sb-). 기종 선택과 보드 · 결정 페이지 키는 남김
const isSessionKey = (key: string) => key !== DEVICE_STORAGE_KEY && (key.startsWith('respec.') || key.startsWith('sb-'));

function resetSession() {
  try {
    const storage = globalThis.localStorage;
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (key && isSessionKey(key)) keys.push(key);
    }
    keys.forEach((key) => storage.removeItem(key));
  } catch {
    // 저장소를 막은 브라우저 — 다시 읽기만 함
  }
  location.reload();
}

// 고른 기종이 들어간 주소를 복사
function copyAddress(device: Device) {
  const url = new URL(location.href);
  url.searchParams.set(DEVICE_QUERY, device.id);
  const clipboard = navigator.clipboard;
  if (!clipboard) {
    toast('복사 불가 (https 필요)');
    return;
  }
  clipboard.writeText(url.toString()).then(
    () => toast('주소 복사함'),
    () => toast('복사 실패'),
  );
}

export function DevicePanel({ device, scale, onDevice, collapsed, onToggle, scenario, onScenario, canScenario }: Props) {
  if (collapsed) {
    return (
      <View style={[styles.panel, styles.folded]}>
        <Pressable onPress={onToggle} accessibilityRole="button" accessibilityLabel="패널 펼치기" style={styles.foldButton}>
          <Text variant="bodyLarge" tone="sub">
            ›
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.panel}>
      <View style={styles.head}>
        <Text variant="section">웹 미리보기</Text>
        <Pressable onPress={onToggle} accessibilityRole="button" accessibilityLabel="패널 접기" hitSlop={8}>
          <Text variant="small">접기</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <Block title="기종" hint={`${device.width} × ${device.height} · 비율 ${Math.round(scale * 100)}%`}>
          {DEVICES.map((d) => {
            const on = d.id === device.id;
            return (
              <Pressable
                key={d.id}
                onPress={() => onDevice(d.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                style={[styles.item, on && styles.itemOn]}
              >
                <Text variant="rowLabel" tone={on ? 'ink' : 'sub'} weight={on ? 600 : 400} style={styles.grow}>
                  {d.name}
                </Text>
                <Text variant="caption">
                  {d.width} × {d.height}
                </Text>
              </Pressable>
            );
          })}
        </Block>

        {canScenario ? (
          <Block title="시나리오 시각" hint="가짜 데이터 · 5월 22일 목요일">
            <Segmented options={TIMES} value={scenario} onChange={onScenario} />
          </Block>
        ) : null}

        <Block title="화면 목록" hint="누르면 이 프레임 안에서 열림">
          {SECTIONS.map((section) => (
            <View key={section.title} style={styles.group}>
              <Text variant="label" weight={600}>
                {section.title}
              </Text>
              {section.rows.map((row) => (
                <Pressable
                  key={`${row.id}-${row.name}`}
                  onPress={() => router.push(row.href)}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.item, pressed && styles.pressed]}
                >
                  <Text variant="screenId" style={styles.id}>
                    {row.id}
                  </Text>
                  <Text variant="rowLabel" style={styles.grow}>
                    {row.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          ))}
        </Block>

        <Block title="세션">
          <View style={styles.buttons}>
            <Button small variant="ghost" label="새 세션" onPress={resetSession} />
            <Button small variant="ghost" label="주소 복사" onPress={() => copyAddress(device)} />
          </View>
        </Block>

        <Block title="바로 가기" hint="새 탭에서 열림">
          {LINKS.map(([path, label]) => (
            <Pressable
              key={path}
              onPress={() => window.open(path, '_blank', 'noopener')}
              accessibilityRole="link"
              style={({ pressed }) => [styles.item, pressed && styles.pressed]}
            >
              <Text variant="rowLabel" style={styles.grow}>
                {label}
              </Text>
              <Text variant="caption">{path}</Text>
            </Pressable>
          ))}
        </Block>
      </ScrollView>
    </View>
  );
}

function Block({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <View style={styles.block}>
      <View style={styles.blockHead}>
        <Text variant="bodyStrong">{title}</Text>
        {hint ? <Text variant="caption">{hint}</Text> : null}
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    width: PANEL_WIDTH,
    backgroundColor: colors.card,
    borderRightWidth: 1,
    borderRightColor: colors.line,
  },
  folded: { width: PANEL_COLLAPSED_WIDTH, alignItems: 'center', paddingTop: 12 },
  foldButton: { width: 32, height: 32, borderRadius: radius.icon, backgroundColor: colors.chip, alignItems: 'center', justifyContent: 'center' },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  body: { paddingHorizontal: 12, paddingBottom: 24 },
  block: { marginTop: 16 },
  blockHead: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingHorizontal: 4, marginBottom: 6 },
  group: { marginTop: 4, marginBottom: 6 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 34, paddingVertical: 6, paddingHorizontal: 8, borderRadius: radius.segmentItem },
  itemOn: { backgroundColor: colors.chip },
  pressed: { backgroundColor: colors.chip },
  grow: { flex: 1 },
  id: { width: 30 },
  buttons: { flexDirection: 'row', gap: 8 },
});
