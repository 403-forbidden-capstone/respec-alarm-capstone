import { useSegments } from 'expo-router';
import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { SafeAreaFrameContext, SafeAreaInsetsContext } from 'react-native-safe-area-context';

import {
  DEFAULT_DEVICE_ID,
  DEVICE_QUERY,
  DEVICE_STORAGE_KEY,
  PANEL_COLLAPSED_WIDTH,
  PANEL_WIDTH,
  STAGE_MARGIN,
  fitScale,
  frameSize,
  getDevice,
  isDeviceId,
  showFrame,
} from '@/dev/devices';
import { now, scenarioTime, setScenarioTime, type ScenarioTime } from '@/lib/clock';
import { formatTime24 } from '@/lib/format';
import { useMode } from '@/lib/mode';
import { colors } from '@/theme';

import { DevicePanel } from './DevicePanel';
import { DeviceCamera, DeviceGestureBar, DeviceStatusBar } from './DeviceStatusBar';

// 웹 미리보기 기종 프레임 — PC 브라우저에서 앱을 고른 기종 크기의 휴대폰 틀로 보여 줌 (배포 화면 포함)
//   왼쪽 패널: 기종 · 화면 목록 · 시나리오 시각 · 새 세션 · 주소 복사 / 가운데: 베젤 · 상태바 · 카메라 · 제스처 바가 있는 프레임
//   앱 화면은 기종의 CSS 크기(width × height) 그대로 그려지고, 상태바 · 제스처 바 높이는 안전 영역으로 넣어 실기기처럼 비움
//   창이 기종 폭 + 100보다 좁으면(실기기 브라우저 · 개발자 도구 기종 에뮬레이션) 프레임 · 패널 없이 앱만
//   네이티브는 DeviceFrame.tsx (틀 없음)

// 주소 ?device= → 저장값 → 기본 기종 순. 저장소를 막은 브라우저는 이번 실행에만 씀
function readDeviceId(): string {
  try {
    const fromUrl = new URLSearchParams(location.search).get(DEVICE_QUERY);
    if (isDeviceId(fromUrl)) return fromUrl;
    const saved = globalThis.localStorage?.getItem(DEVICE_STORAGE_KEY);
    if (isDeviceId(saved)) return saved;
  } catch {
    // 저장소를 막은 브라우저
  }
  return DEFAULT_DEVICE_ID;
}

// 저장하고, 주소에 ?device=가 있으면 그 값도 새 기종으로 바꿔 새로 고침해도 그대로 두게 함
function writeDeviceId(id: string) {
  try {
    globalThis.localStorage?.setItem(DEVICE_STORAGE_KEY, id);
  } catch {
    // 저장소를 막은 브라우저
  }
  try {
    const url = new URL(location.href);
    if (url.searchParams.has(DEVICE_QUERY)) {
      url.searchParams.set(DEVICE_QUERY, id);
      history.replaceState(history.state, '', url);
    }
  } catch {
    // 주소를 못 바꿔도 화면은 그대로
  }
}

// 상태바 시각 — 가짜 데이터 모드는 시나리오 시각, 실데이터 모드는 지금 시각. 다시 그릴 때마다 읽고 15초마다 한 번 더 그림
const subscribeTick = (listener: () => void) => {
  const timer = setInterval(listener, 15_000);
  return () => clearInterval(timer);
};
const readClock = () => formatTime24(now());

export function DeviceFrame({ children }: { children: ReactNode }) {
  const { width, height } = useWindowDimensions();
  const { mode } = useMode();
  const segments = useSegments() as string[];
  const [deviceId, setDeviceId] = useState(readDeviceId);
  const [collapsed, setCollapsed] = useState(false);
  const [scenario, setScenario] = useState<ScenarioTime>(scenarioTime);
  const [epoch, setEpoch] = useState(0); // 바뀔 때마다 앱 화면을 새로 그림
  const clock = useSyncExternalStore(subscribeTick, readClock, readClock);
  const device = getDevice(deviceId);

  // 앱이 보는 안전 영역 · 화면 크기 — 기존 SafeAreaView · 탭 막대가 실기기처럼 상태바 · 제스처 바를 비움
  const insets = useMemo(() => ({ top: device.insetTop, bottom: device.insetBottom, left: 0, right: 0 }), [device]);
  const safeFrame = useMemo(() => ({ x: 0, y: 0, width: device.width, height: device.height }), [device]);

  if (!showFrame(width, device)) return <>{children}</>;

  const panelWidth = collapsed ? PANEL_COLLAPSED_WIDTH : PANEL_WIDTH;
  const scale = fitScale({ width, height }, device, { width: panelWidth, margin: STAGE_MARGIN });
  const frame = frameSize(device);
  const ringing = segments.includes('ring'); // 알람 울림은 어두운 화면이라 상태바를 흰색으로

  function changeDevice(id: string) {
    setDeviceId(id);
    writeDeviceId(id);
  }

  // 시나리오 시각을 바꾸고 앱 화면을 새로 그려 새 시각으로 다시 읽게 함
  // 화면 묶음(Stack · 탭)을 key로 다시 올리면 지금 주소 · 쌓인 화면은 내비게이션 상태에서 그대로 이어짐 (router.replace는 같은 탭 화면을 다시 안 읽음)
  function changeScenario(next: ScenarioTime) {
    setScenarioTime(next);
    setScenario(next);
    setEpoch((v) => v + 1);
  }

  return (
    <View style={styles.page}>
      <DevicePanel
        device={device}
        scale={scale}
        onDevice={changeDevice}
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
        scenario={scenario}
        onScenario={changeScenario}
        canScenario={mode === 'mock'}
      />
      <View style={styles.stage}>
        {/* 바깥 칸은 줄인 크기, 안쪽 틀은 원래 크기로 그린 뒤 왼쪽 위 기준으로 줄임 */}
        <View style={{ width: frame.width * scale, height: frame.height * scale }}>
          <View
            style={[
              styles.shell,
              { width: frame.width, height: frame.height, padding: device.bezel, borderRadius: device.radius + device.bezel, transform: [{ scale }] },
            ]}
          >
            <View style={[styles.screen, { width: device.width, height: device.height, borderRadius: device.radius }]}>
              <SafeAreaFrameContext.Provider value={safeFrame}>
                <SafeAreaInsetsContext.Provider value={insets}>
                  <View key={epoch} style={styles.app}>
                    {children}
                  </View>
                </SafeAreaInsetsContext.Provider>
              </SafeAreaFrameContext.Provider>
              <DeviceStatusBar device={device} clock={clock} light={ringing} />
              <DeviceCamera device={device} />
              <DeviceGestureBar device={device} light={ringing} />
            </View>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, flexDirection: 'row', backgroundColor: colors.stage },
  stage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  shell: { position: 'absolute', top: 0, left: 0, backgroundColor: colors.device, transformOrigin: 'top left' },
  // 배경색은 두지 않음 — 앱 화면 바탕이 모서리 곡선에서 베젤 색 위에 직접 얹혀야 어두운 화면(알람 울림) 가장자리에 밝은 테두리가 안 보임
  screen: { overflow: 'hidden' },
  app: { flex: 1 },
});
