import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

import { colors } from '@/theme';

const BARS = 16;

// 음성 안내 파형 (.wave) — 막대 16개가 세 박자로 나눠 오르내림
export function VoiceWave() {
  const [phase] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(phase, { toValue: 1, duration: 1000, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
    );
    loop.start();
    return () => loop.stop();
  }, [phase]);

  return (
    <View style={styles.wave} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: BARS }, (_, i) => {
        const shift = i % 3 === 2 ? 0.36 : i % 2 === 1 ? 0.18 : 0; // CSS의 nth-child 지연
        const height = phase.interpolate({
          inputRange: [0, 0.5, 1],
          outputRange: shift ? [4 + 12 * shift, 16 - 12 * shift, 4 + 12 * shift] : [4, 16, 4],
        });
        return <Animated.View key={i} style={[styles.bar, { height }]} />;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  wave: { flexDirection: 'row', gap: 3, alignItems: 'center', height: 18, marginTop: 10 },
  bar: { width: 3, borderRadius: 2, backgroundColor: colors.ringWave },
});
