import { StyleSheet, Text, View } from 'react-native';

// 01 홈 탭 — 목업이 들어올 자리
export default function HomeScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>01 홈</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '600' },
});
