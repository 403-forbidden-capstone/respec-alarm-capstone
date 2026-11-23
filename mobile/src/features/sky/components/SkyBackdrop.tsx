import { useEffect, useState } from 'react';
import { AccessibilityInfo, Animated, Easing, Platform, StyleSheet, View, type ImageSourcePropType } from 'react-native';

import { SKY_HEIGHT, skyBase, skyColorAt, skyTop, type SkyKind, type SkyPhase } from '../sky';

type Props = { kind: SkyKind; phase: SkyPhase };

// 그림은 scripts/make-sky-assets.py가 만든 PNG (가장자리가 흐린 구름 · 번지는 해 등) — 모양 · 색은 그 파일에서 고침
const CLOUD_WHITE = [require('../../../../assets/sky/cloud-1.png'), require('../../../../assets/sky/cloud-2.png'), require('../../../../assets/sky/cloud-3.png')];
const CLOUD_GRAY = [require('../../../../assets/sky/cloud-gray-1.png'), require('../../../../assets/sky/cloud-gray-2.png'), require('../../../../assets/sky/cloud-gray-3.png')];
const IMG = {
  sunDay: require('../../../../assets/sky/sun-day.png'),
  sunLow: require('../../../../assets/sky/sun-low.png'),
  rays: require('../../../../assets/sky/rays.png'),
  flare: require('../../../../assets/sky/flare.png'),
  moon: require('../../../../assets/sky/moon.png'),
  moonGlow: require('../../../../assets/sky/glow-moon.png'),
  ball: require('../../../../assets/sky/ball.png'),
  crystal: require('../../../../assets/sky/crystal.png'),
  rain: require('../../../../assets/sky/rain.png'),
  shooting: require('../../../../assets/sky/shooting.png'),
  star: require('../../../../assets/sky/star.png'),
} satisfies Record<string, ImageSourcePropType>;

const STRIP = 3; // 색 띠 하나의 높이 — 띠마다 색을 조금씩 바꿔 그러데이션을 만듦 (패키지 없이 폰 · 웹 같게)
const STRIPS = Array.from({ length: SKY_HEIGHT / STRIP }, (_, i) => i);
const NATIVE = Platform.OS !== 'web';
// 눈 · 비가 떨어지는 높이 — 그 아래는 카드가 덮어 안 보이므로 위쪽에 모음
const FALL = 210;

// 번호마다 늘 같은 0~1 값 — 눈송이 · 빗줄기 자리가 다시 그릴 때마다 바뀌지 않게
function spread(i: number, salt: number) {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return x - Math.floor(x);
}

// 0 → 1을 되풀이하는 값. 움직임 줄이기를 켠 폰에서는 멈춘 그림 (still)
//   start: 처음 한 바퀴를 어디서부터 돌지 — 눈 · 비 · 구름이 화면을 열자마자 전체에 퍼져 있게
function useLoop(duration: number, start: number, still: boolean) {
  const [value] = useState(() => new Animated.Value(start));
  useEffect(() => {
    value.setValue(start);
    if (still) return;
    let loop: Animated.CompositeAnimation | null = null;
    const first = Animated.timing(value, { toValue: 1, duration: duration * (1 - start), easing: Easing.linear, useNativeDriver: NATIVE });
    first.start(({ finished }) => {
      if (!finished) return;
      value.setValue(0);
      loop = Animated.loop(Animated.timing(value, { toValue: 1, duration, easing: Easing.linear, useNativeDriver: NATIVE }));
      loop.start();
    });
    return () => {
      first.stop();
      loop?.stop();
    };
  }, [value, duration, start, still]);
  return value;
}

function useReduceMotion() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((v) => alive && setOn(v));
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setOn);
    return () => {
      alive = false;
      sub.remove();
    };
  }, []);
  return on;
}

type Layer = 'far' | 'near';

// 눈 — 먼 것은 작은 눈 뭉치(느리게), 가까운 것은 여섯 갈래 눈 결정(크고 빠르게, 천천히 돎)
function Flake({ i, layer, still }: { i: number; layer: Layer; still: boolean }) {
  const near = layer === 'near';
  const salt = near ? 40 : 0;
  const p = useLoop(near ? 5200 + spread(i, salt + 1) * 1800 : 9500 + spread(i, salt + 1) * 4000, spread(i, salt + 2), still);
  const d = near ? 18 + spread(i, salt + 3) * 18 : 6 + spread(i, salt + 3) * 7;
  const spin = spread(i, salt + 6) < 0.5 ? '200deg' : '-200deg';
  const sway = (spread(i, salt + 5) - 0.5) * (near ? 60 : 30);
  return (
    <Animated.Image
      source={near ? IMG.crystal : IMG.ball}
      style={[
        styles.abs,
        { left: `${spread(i, salt + 4) * 100}%`, width: d, height: d },
        {
          opacity: p.interpolate({ inputRange: [0, 0.06, 0.65, 0.95], outputRange: [0, 0.95, 0.95, 0], extrapolate: 'clamp' }),
          transform: [
            { translateY: p.interpolate({ inputRange: [0, 1], outputRange: [-30, FALL] }) },
            { translateX: p.interpolate({ inputRange: [0, 0.25, 0.75, 1], outputRange: [0, sway, -sway, 0] }) },
            { rotate: near ? p.interpolate({ inputRange: [0, 1], outputRange: ['0deg', spin] }) : '0deg' },
          ],
        },
      ]}
    />
  );
}

function Drop({ i, layer, still }: { i: number; layer: Layer; still: boolean }) {
  const near = layer === 'near';
  const salt = near ? 60 : 20;
  const p = useLoop(near ? 620 + spread(i, salt + 1) * 200 : 1000 + spread(i, salt + 1) * 350, spread(i, salt + 2), still);
  const h = near ? 46 + spread(i, salt + 3) * 22 : 24 + spread(i, salt + 3) * 12;
  const peak = near ? 0.85 : 0.5;
  return (
    <Animated.Image
      source={IMG.rain}
      resizeMode="stretch"
      style={[
        styles.abs,
        { left: `${spread(i, salt + 4) * 118}%`, width: near ? 5 : 3, height: h },
        {
          opacity: p.interpolate({ inputRange: [0, 0.08, 0.7, 0.98], outputRange: [0, peak, peak, 0], extrapolate: 'clamp' }),
          transform: [
            { translateY: p.interpolate({ inputRange: [0, 1], outputRange: [-70, FALL] }) },
            { translateX: p.interpolate({ inputRange: [0, 1], outputRange: [0, -60] }) },
            { rotate: '12deg' },
          ],
        },
      ]}
    />
  );
}

// 구름 — 뒤(작고 느리고 흐림) · 가운데 · 앞(크고 빠름) 세 겹이 왼쪽에서 오른쪽으로 흘러 지나감
//   w: 너비, top: 위에서 거리, ms: 화면을 한 번 건너는 시간, start: 처음 자리(0 왼쪽 밖 ~ 1 오른쪽 밖)
const CLOUDS = [
  { img: 2, w: 150, top: 58, ms: 150_000, start: 0.3, alpha: 0.5 },
  { img: 0, w: 170, top: 96, ms: 135_000, start: 0.72, alpha: 0.5 },
  { img: 1, w: 230, top: 22, ms: 100_000, start: 0.12, alpha: 0.75 },
  { img: 2, w: 250, top: 66, ms: 90_000, start: 0.6, alpha: 0.7 },
  { img: 0, w: 330, top: -14, ms: 62_000, start: 0.5, alpha: 0.95 },
] as const;
// 맑은 날은 뒤쪽 작은 구름 하나만 지나감
const CLEAR_CLOUDS = [0] as const;
const ALL_CLOUDS = [0, 1, 2, 3, 4] as const;

function Cloud({ i, width, gray, dim, still }: { i: number; width: number; gray: boolean; dim: number; still: boolean }) {
  const c = CLOUDS[i];
  const p = useLoop(c.ms, c.start, still);
  return (
    <Animated.Image
      source={(gray ? CLOUD_GRAY : CLOUD_WHITE)[c.img]}
      resizeMode="contain"
      style={[
        styles.abs,
        { left: 0, top: c.top, width: c.w, height: (c.w * 300) / 720, opacity: c.alpha * dim },
        { transform: [{ translateX: p.interpolate({ inputRange: [0, 1], outputRange: [-c.w, width] }) }] },
      ]}
    />
  );
}

const SUN = 300;
// 해에서 화면 가운데 쪽으로 늘어선 빛 번짐 — [해 중심에서 거리 비율, 크기, 진하기]
const FLARES = [
  [0.38, 34, 0.5],
  [0.62, 18, 0.7],
  [0.95, 58, 0.35],
] as const;

// 해 — 숨 쉬듯 커졌다 작아지고, 낮에는 빛줄기가 천천히 돌고 빛 번짐이 따라 움직임. 해 질 녘은 붉고 낮게
function Sun({ low, still }: { low: boolean; still: boolean }) {
  const pulse = useLoop(7000, 0, still);
  const turn = useLoop(90_000, 0, still);
  const scale = pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1.07, 1] });
  const drift = pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 6, 0] });
  return (
    <View style={[styles.abs, low ? styles.sunLowAt : styles.sunAt]}>
      {low ? null : (
        <Animated.Image
          source={IMG.rays}
          style={[styles.abs, styles.sunFill, { transform: [{ rotate: turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }, { scale: 1.25 }] }]}
        />
      )}
      <Animated.Image source={low ? IMG.sunLow : IMG.sunDay} style={[styles.abs, styles.sunFill, { transform: [{ scale }] }]} />
      {low
        ? null
        : FLARES.map(([at, d, alpha]) => (
            <Animated.Image
              key={at}
              source={IMG.flare}
              style={[
                styles.abs,
                { width: d, height: d, opacity: alpha, left: SUN / 2 - d / 2 - at * 190, top: SUN / 2 - d / 2 + at * 120 },
                { transform: [{ translateX: drift }, { translateY: drift }] },
              ]}
            />
          ))}
    </View>
  );
}

function Star({ i, dim, still }: { i: number; dim: number; still: boolean }) {
  const p = useLoop(2200 + spread(i, 9) * 2800, spread(i, 10), still);
  const d = 6 + spread(i, 11) * 10;
  return (
    <Animated.Image
      source={IMG.star}
      style={[
        styles.abs,
        { left: `${2 + spread(i, 12) * 94}%`, top: 4 + spread(i, 13) * 170, width: d, height: d },
        { opacity: p.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.25 * dim, dim, 0.25 * dim] }) },
      ]}
    />
  );
}

// 별똥별 — 9초에 한 번 왼쪽 아래로 짧게 지나감
function ShootingStar({ still }: { still: boolean }) {
  const p = useLoop(9000, 0.7, still);
  if (still) return null;
  return (
    <Animated.Image
      source={IMG.shooting}
      resizeMode="stretch"
      style={[
        styles.abs,
        styles.shooting,
        {
          opacity: p.interpolate({ inputRange: [0, 0.9, 0.93, 0.98, 1], outputRange: [0, 0, 1, 0, 0] }),
          transform: [
            { translateX: p.interpolate({ inputRange: [0.9, 1], outputRange: [0, -150], extrapolate: 'clamp' }) },
            { translateY: p.interpolate({ inputRange: [0.9, 1], outputRange: [0, 86], extrapolate: 'clamp' }) },
            { rotate: '60deg' },
          ],
        },
      ]}
    />
  );
}

const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const FLAKES_FAR = range(60);
const FLAKES_NEAR = range(12);
const DROPS_FAR = range(30);
const DROPS_NEAR = range(16);
const STARS = range(26);
const FADE_STRIP = 6;
const FADE = range(20).map((i) => ((i + 1) / 20) ** 1.6);

// 탭 화면 위쪽 하늘 — 맨 위 색이 아래로 풀리는 바탕 + 날씨 그림(해 · 달과 별 · 세 겹 구름 · 두 겹 비 · 두 겹 눈)
// 값만 받아 그림. 누르는 것을 가리지 않게 터치는 통과
export function SkyBackdrop({ kind, phase }: Props) {
  const still = useReduceMotion();
  const [width, setWidth] = useState(393);
  const top = skyTop(kind, phase);
  const night = phase === 'night';
  const clear = kind === 'clear';
  const wet = kind === 'rain' || kind === 'snow';
  const base = skyBase(top);
  return (
    <>
      {/* 화면 전체 바탕 — 하늘 색을 살짝 섞은 톤. 카드 · 탭 막대는 그대로 흰색 */}
      <View style={[StyleSheet.absoluteFill, { backgroundColor: base }]} pointerEvents="none" />
      <View
        style={styles.wrap}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      >
        {STRIPS.map((i) => (
          <View key={i} style={{ height: STRIP, backgroundColor: skyColorAt(top, i * STRIP) }} />
        ))}
        <View style={StyleSheet.absoluteFill}>
          {night && !wet ? STARS.map((i) => <Star key={i} i={i} dim={clear ? 1 : 0.5} still={still} />) : null}
          {night && clear ? (
            <>
              <ShootingStar still={still} />
              <View style={[styles.abs, styles.moonAt]}>
                <Animated.Image source={IMG.moonGlow} style={[styles.abs, styles.moonGlow]} />
                <Animated.Image source={IMG.moon} style={styles.moon} />
              </View>
            </>
          ) : null}
          {clear && !night ? <Sun low={phase === 'dusk'} still={still} /> : null}
          {wet ? (kind === 'rain' ? DROPS_FAR.map((i) => <Drop key={i} i={i} layer="far" still={still} />) : FLAKES_FAR.map((i) => <Flake key={i} i={i} layer="far" still={still} />)) : null}
          {(clear ? CLEAR_CLOUDS : ALL_CLOUDS).map((i) => (
            <Cloud key={i} i={i} width={width} gray={kind === 'rain'} dim={clear ? 0.7 : night ? 0.8 : 1} still={still} />
          ))}
          {kind === 'rain' ? DROPS_NEAR.map((i) => <Drop key={i} i={i} layer="near" still={still} />) : null}
          {kind === 'snow' ? FLAKES_NEAR.map((i) => <Flake key={i} i={i} layer="near" still={still} />) : null}
        </View>
        {/* 그림이 아래 끝에서 뚝 끊기지 않게 바탕 색으로 덮어 풀어 줌 */}
        <View style={styles.fade}>
          {FADE.map((a, i) => (
            <View key={i} style={{ height: FADE_STRIP, backgroundColor: base, opacity: a }} />
          ))}
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, height: SKY_HEIGHT, overflow: 'hidden' },
  fade: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  abs: { position: 'absolute', top: 0 },
  sunAt: { top: -78, right: -62, width: SUN, height: SUN },
  sunLowAt: { top: -70, right: -40, width: SUN, height: SUN },
  sunFill: { left: 0, width: SUN, height: SUN },
  moonAt: { top: 26, right: 30, width: 64, height: 64, alignItems: 'center', justifyContent: 'center' },
  moonGlow: { left: -48, top: -48, width: 160, height: 160 },
  moon: { width: 64, height: 64 },
  shooting: { top: 18, left: '62%', width: 3, height: 70 },
});
