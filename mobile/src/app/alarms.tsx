import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { LoadError, Screen, SectionHeader, Text, TopBar, TopBarButton } from '@/components/ui';
import { listAppointments } from '@/features/alarm/api';
import { AppointmentAlarmCard } from '@/features/alarm/components/AppointmentAlarmCard';
import type { Appointment } from '@/features/alarm/types';
import { dayKey, formatDate } from '@/lib/format';
import { backOrHome } from '@/lib/nav';
import { useLoad } from '@/lib/useLoad';

// 날짜별로 묶음 (시각 순은 api가 맞춰 줌)
function byDay(list: Appointment[]) {
  const days = new Map<string, Appointment[]>();
  for (const a of list) days.set(dayKey(a.at), [...(days.get(dayKey(a.at)) ?? []), a]);
  return [...days.values()];
}

// H02 알람 목록 — 일정마다 기상 · 준비 · 출발 알람
export default function AlarmsScreen() {
  const { data, error, reload } = useLoad(listAppointments);

  return (
    <Screen>
      <TopBar
        screenId="H02"
        onBack={backOrHome}
        right={<TopBarButton label="+ 새 일정" onPress={() => router.push('/schedule/new')} />}
      />
      <Text variant="title" style={styles.title}>
        알람
      </Text>
      <Text variant="lead">일정마다 기상 · 준비 · 출발 알람을 계산해 두었어요.</Text>
      {data
        ? byDay(data).map((day) => (
            <View key={dayKey(day[0].at)}>
              <SectionHeader title={formatDate(day[0].at)} />
              {day.map((a) => (
                <AppointmentAlarmCard key={a.id} appointment={a} onChanged={reload} />
              ))}
            </View>
          ))
        : null}
      {!data && error ? <LoadError onRetry={reload} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
});
