import { Stack } from 'expo-router';
import { Platform, StyleSheet, useWindowDimensions, View } from 'react-native';

// 웹 데모를 PC 브라우저로 열면 휴대폰 크기 화면으로 가운데에 보여 준다.
const PHONE = { width: 390, height: 844 };

export default function RootLayout() {
  const { width, height } = useWindowDimensions();
  const stack = <Stack screenOptions={{ headerShown: false }} />;

  const wide = Platform.OS === 'web' && width > PHONE.width + 80;
  if (!wide) return stack;

  return (
    <View style={styles.page}>
      <View style={[styles.phone, { height: Math.min(PHONE.height, height - 48) }]}>{stack}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#EEF0F3' },
  phone: {
    width: PHONE.width,
    overflow: 'hidden',
    borderRadius: 32,
    borderWidth: 8,
    borderColor: '#1F2328',
    backgroundColor: '#FFFFFF',
  },
});
