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
import { DEV_TOOLS, modeBlock } from '@/dev/panelModel';
import { sectionsFor } from '@/dev/screenList';
import { useAuth } from '@/features/auth/AuthProvider';
import { changeDataMode, goAfterRender } from '@/features/auth/DataModeToggle';
import type { ScenarioTime } from '@/lib/clock';
import { REAL_DATA_READY } from '@/lib/flags';
import { canUseRealData, devLoginVisible, modeLocked, useMode } from '@/lib/mode';
import { signOutAndCleanup } from '@/lib/session';
import { useAction } from '@/lib/useAction';
import { colors, radius } from '@/theme';

// 웹 미리보기 왼쪽 패널 (DeviceFrame.web.tsx만 씀) — 데이터 모드 · 시나리오 시각 · 개발 도구 · 기종 선택 · 화면 목록 · 세션 · 바로 가기
// 웹 미리보기는 개발 서버처럼 쓰므로 데이터 모드 전환 · 로그인 · 개발 화면(알람 테스트 등)은 /dev/screens까지 안 가고 여기서 바로

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

// 데이터 모드 고르기 — 웹 기본이 가짜라 가짜가 왼쪽 (/dev/screens 토글은 실데이터가 왼쪽)
const MODES = [
  ['mock', '가짜 데이터'],
  ['real', '실데이터'],
] as const;

// 새 탭에서 여는 곳 — 프레임 안 화면(/dev/*)은 "개발 도구"에 있음
const LINKS = [['/board', '개발 보드']] as const;

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
  const { mode } = useMode(); // 화면 목록은 지금 모드에서 열리는 줄만
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
        <ModeBlock />

        {canScenario ? (
          <Block title="시나리오 시각" hint="가짜 데이터 · 5월 22일 목요일">
            <Segmented options={TIMES} value={scenario} onChange={onScenario} />
          </Block>
        ) : null}

        <Block title="개발 도구" hint="누르면 이 프레임 안에서 열림">
          {DEV_TOOLS.map((tool) => (
            <Pressable
              key={tool.name}
              onPress={() => router.push(tool.href)}
              accessibilityRole="button"
              style={({ pressed }) => [styles.item, pressed && styles.pressed]}
            >
              <Text variant="rowLabel">{tool.name}</Text>
              <Text variant="caption" style={styles.note}>
                {tool.note}
              </Text>
            </Pressable>
          ))}
        </Block>

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

        <Block title="화면 목록" hint="누르면 이 프레임 안에서 열림">
          {sectionsFor(mode).map((section) => (
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

// 데이터 모드 — /dev/screens 맨 위 토글과 같은 함수(changeDataMode)로 바꾸고, 실데이터면 로그인한 계정 · 로그아웃 / 로그인 전 이메일 로그인 길
function ModeBlock() {
  const { mode } = useMode();
  const { session, profile } = useAuth();
  const { busy, run } = useAction();
  const block = modeBlock({
    mode,
    ready: REAL_DATA_READY,
    canUseReal: canUseRealData,
    locked: modeLocked,
    devLogin: devLoginVisible,
    signedIn: session != null,
    email: session?.user.email ?? null,
    nickname: profile?.nickname ?? null,
  });
  if (!block) return null;
  const { account } = block;

  // /dev/screens의 로그아웃 버튼과 같음 — 폰 알람 · 기록 정리까지 하는 signOutAndCleanup, 끝나면 로그인 화면으로
  const logout = () =>
    run(async () => {
      await signOutAndCleanup();
      toast('로그아웃했어요');
      goAfterRender('/login');
    }, '하지 못했어요');

  return (
    <Block title="데이터 모드" hint={mode === 'real' ? '로그인 · 서버 데이터' : '목업 시나리오'}>
      <Segmented options={MODES} value={mode} onChange={changeDataMode} disabled={block.realDisabled ? ['real'] : undefined} />
      {block.reason ? (
        <Text variant="caption" style={styles.reason}>
          {block.reason}
        </Text>
      ) : null}
      {account.kind === 'signedIn' ? (
        <View style={styles.account}>
          <View style={styles.grow}>
            <Text variant="rowLabel" numberOfLines={1}>
              {account.label ?? '로그인됨'}
            </Text>
            {account.label ? <Text variant="caption">로그인됨</Text> : null}
          </View>
          <Button small variant="ghost" label="로그아웃" loading={busy} onPress={logout} />
        </View>
      ) : null}
      {account.kind === 'signedOut' ? (
        <View style={styles.account}>
          <Text variant="rowLabel" tone="sub" style={styles.grow}>
            로그인 전
          </Text>
          {/* 이메일 로그인 폼은 개발 메뉴(/dev/screens)에 있음 — 로그인 화면의 "개발 메뉴에서 이메일로 로그인"과 같은 길 */}
          {account.devLogin ? <Button small variant="ghost" label="개발용 이메일 로그인" onPress={() => router.push('/dev/screens')} /> : null}
        </View>
      ) : null}
    </Block>
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
  note: { flex: 1, textAlign: 'right' }, // 개발 도구 줄의 짧은 설명 — 이름 오른쪽에 붙고 길면 줄바꿈
  reason: { marginTop: 2, marginHorizontal: 4 },
  account: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, paddingHorizontal: 4 },
  id: { width: 30 },
  buttons: { flexDirection: 'row', gap: 8 },
});
