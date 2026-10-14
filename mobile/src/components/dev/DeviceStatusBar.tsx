import { StyleSheet, View } from 'react-native';

import { Text } from '@/components/ui';
import type { Device } from '@/dev/devices';
import { colors } from '@/theme';

// 웹 미리보기 기종 프레임의 화면 위 겉모습 — 카메라 · 상태바 · 제스처 바 (DeviceFrame.web.tsx만 씀)
// 모두 absolute로 앱 위에 얹고 터치는 통과시킴. 앱이 보는 안전 영역은 DeviceFrame이 따로 넣어 줌

type Props = { device: Device; clock: string; light: boolean }; // light = 어두운 화면(알람 울림) 위라 흰색으로

// 카메라 구멍 — 펀치홀(가운데 원) · 노치(위에서 내려온 판) · 다이내믹 아일랜드(알약)
export function DeviceCamera({ device }: { device: Device }) {
  const center = device.insetTop / 2;
  if (device.camera === 'notch') {
    return <View style={[styles.notch, { height: Math.round(device.insetTop * 0.6) }]} />;
  }
  if (device.camera === 'island') {
    return <View style={[styles.island, { top: Math.round(center - ISLAND.height / 2) }]} />;
  }
  return <View style={[styles.hole, { top: Math.round(center - HOLE / 2) }]} />;
}

// 상태바 — 왼쪽 시각, 오른쪽 신호 · 와이파이 · 배터리. 높이는 기종의 상단 inset
export function DeviceStatusBar({ device, clock, light }: Props) {
  const color = light ? colors.inverse : colors.ink;
  const side = Math.min(36, Math.max(20, device.radius));
  return (
    <View style={[styles.bar, { height: device.insetTop, paddingHorizontal: side }]}>
      <Text variant="bodyStrong" tone={light ? 'inverse' : 'ink'} style={styles.clock}>
        {clock}
      </Text>
      <View style={styles.icons}>
        <Signal color={color} />
        <Wifi color={color} />
        <Battery color={color} />
      </View>
    </View>
  );
}

// 아래 제스처 바(알약)
export function DeviceGestureBar({ device, light }: { device: Device; light: boolean }) {
  return (
    <View style={[styles.gesture, { height: device.insetBottom }]}>
      <View style={[styles.pill, { backgroundColor: light ? colors.inverse : colors.ink }]} />
    </View>
  );
}

// 신호 막대 4개
function Signal({ color }: { color: string }) {
  return (
    <View style={styles.signal}>
      {[4, 6, 8, 10].map((h) => (
        <View key={h} style={{ width: 3, height: h, borderRadius: 1, backgroundColor: color }} />
      ))}
    </View>
  );
}

// 와이파이 — 위쪽 테두리만 칠한 동그라미 두 겹(부채꼴) + 점
function Wifi({ color }: { color: string }) {
  return (
    <View style={styles.wifi}>
      {[22, 14].map((size) => (
        <View
          key={size}
          style={{
            position: 'absolute',
            top: 11 - size / 2,
            left: 8 - size / 2,
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: 2,
            borderColor: 'transparent',
            borderTopColor: color,
          }}
        />
      ))}
      <View style={{ position: 'absolute', top: 9, left: 6, width: 4, height: 4, borderRadius: 2, backgroundColor: color }} />
    </View>
  );
}

// 배터리 — 테두리 + 채움 + 오른쪽 꼭지
function Battery({ color }: { color: string }) {
  return (
    <View style={styles.batteryRow}>
      <View style={[styles.battery, { borderColor: color }]}>
        <View style={[styles.charge, { backgroundColor: color }]} />
      </View>
      <View style={[styles.nub, { backgroundColor: color }]} />
    </View>
  );
}

const HOLE = 11;
const ISLAND = { width: 124, height: 36 };

const styles = StyleSheet.create({
  hole: {
    position: 'absolute',
    alignSelf: 'center',
    width: HOLE,
    height: HOLE,
    borderRadius: HOLE / 2,
    backgroundColor: colors.camera,
    pointerEvents: 'none',
  },
  notch: {
    position: 'absolute',
    top: 0,
    alignSelf: 'center',
    width: 160,
    backgroundColor: colors.camera,
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 18,
    pointerEvents: 'none',
  },
  island: {
    position: 'absolute',
    alignSelf: 'center',
    width: ISLAND.width,
    height: ISLAND.height,
    borderRadius: ISLAND.height / 2,
    backgroundColor: colors.camera,
    pointerEvents: 'none',
  },
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    pointerEvents: 'none',
  },
  clock: { fontSize: 14, lineHeight: 18, fontVariant: ['tabular-nums'] },
  icons: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  signal: { flexDirection: 'row', alignItems: 'flex-end', gap: 1.5, height: 10 },
  wifi: { width: 16, height: 12, overflow: 'hidden' },
  batteryRow: { flexDirection: 'row', alignItems: 'center' },
  battery: { width: 22, height: 11, borderWidth: 1.5, borderRadius: 3, padding: 1.5 },
  charge: { flex: 1, borderRadius: 1, opacity: 0.9 },
  nub: { width: 2, height: 4, borderTopRightRadius: 1, borderBottomRightRadius: 1 },
  gesture: { position: 'absolute', bottom: 0, left: 0, right: 0, alignItems: 'center', justifyContent: 'center', pointerEvents: 'none' },
  pill: { width: 120, height: 4, borderRadius: 2, opacity: 0.85 },
});
