import { StyleSheet, Text, View } from 'react-native';

// 04 일정 탭 — 목업이 들어올 자리 (일정 추가 · 상세는 src/app/schedule/)
export default function CalendarScreen() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>04 일정</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 20, fontWeight: '600' },
});
