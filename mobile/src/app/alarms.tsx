import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { EmptyState, Loading, LoadError, Screen, SectionHeader, Text, TopBar, TopBarButton } from '@/components/ui';
import { listAppointments } from '@/features/alarm/api';
import { AppointmentAlarmCard } from '@/features/alarm/components/AppointmentAlarmCard';
import { useAppointmentToggle } from '@/features/alarm/hooks/useAppointmentToggle';
import { useNow } from '@/features/alarm/hooks/useNow';
import { dayHeading, groupByDay, splitUpcoming } from '@/features/alarm/schedule';
import { formatDateShort } from '@/lib/format';
import { backOrHome } from '@/lib/nav';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

const HIGHLIGHT_MS = 2600; // 방금 만든 일정 테두리가 남는 시간

// H02 알람 목록 — 오늘부터의 일정마다 기상 · 준비 · 출발 알람. 지난 일정은 맨 아래에 접어 둠
// ?highlight=<일정 id>: 새 일정(H05)을 저장하고 돌아왔을 때 그 카드에 잠깐 테두리
export default function AlarmsScreen() {
  const { highlight } = useLocalSearchParams<{ highlight?: string }>();
  const { data, error, reload } = useLoad(listAppointments);
  const current = useNow();
  const toggleAppointment = useAppointmentToggle(reload);
  const [showPast, setShowPast] = useState(false);
  const [expired, setExpired] = useState<string | null>(null);
  const lit = highlight && highlight !== expired ? highlight : null;
  const scrollRef = useRef<ScrollView>(null);
  const scrolledTo = useRef<string | null>(null);

  useEffect(() => {
    if (!highlight) return;
    const id = setTimeout(() => setExpired(highlight), HIGHLIGHT_MS);
    return () => clearTimeout(id);
  }, [highlight]);

  const { upcoming, past } = data ? splitUpcoming(data, current) : { upcoming: [], past: [] };

  return (
    <Screen onRefresh={reload} scrollRef={scrollRef}>
      <TopBar
        screenId="H02"
        onBack={backOrHome}
        right={<TopBarButton label="+ 새 일정" onPress={() => router.push({ pathname: '/schedule/new', params: { from: 'alarms' } })} />}
      />
      <Text variant="title" style={styles.title}>
        알람
      </Text>
      <Text variant="lead">일정마다 기상 · 준비 · 출발 알람을 계산해 두었어요.</Text>
      {!data && !error ? <Loading text="알람을 불러오는 중" /> : null}
      {data && !upcoming.length ? (
        <View style={styles.empty}>
          <EmptyState
            title="예정된 일정이 없어요"
            body="일정을 추가하면 기상 · 준비 · 출발 알람을 계산해 드려요."
            action={{ label: '새 일정', onPress: () => router.push({ pathname: '/schedule/new', params: { from: 'alarms' } }) }}
          />
        </View>
      ) : null}
      {groupByDay(upcoming).map((day) => (
        <View
          key={day[0].id}
          onLayout={(e) => {
            // 방금 만든 일정이 든 날로 한 번만 스크롤
            if (!lit || scrolledTo.current === lit || !day.some((a) => a.id === lit)) return;
            scrolledTo.current = lit;
            scrollRef.current?.scrollTo({ y: Math.max(0, e.nativeEvent.layout.y - 12), animated: true });
          }}
        >
          <SectionHeader title={dayHeading(day[0].at, current)} />
          {/* 날짜는 섹션 제목에 있으니 카드 머리줄에는 안 보임 */}
          {day.map((a) => (
            <AppointmentAlarmCard key={a.id} appointment={a} current={current} onToggle={(on) => toggleAppointment(a, on)} highlight={a.id === lit} showDate={false} />
          ))}
        </View>
      ))}
      {past.length ? (
        <>
          <Pressable
            onPress={() => setShowPast((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={showPast ? `지난 일정 ${past.length}개 접기` : `지난 일정 ${past.length}개 펼치기`}
            accessibilityState={{ expanded: showPast }}
            style={({ pressed }) => [styles.pastToggle, pressed && styles.pressed]}
          >
            <Text variant="rowLabel" tone="sub">
              지난 일정 {past.length}개
            </Text>
            <Text variant="rowLabel" tone="sub">
              {showPast ? '접기 ⌃' : '펼치기 ⌄'}
            </Text>
          </Pressable>
          {showPast
            ? groupByDay(past).map((day) => (
                <View key={day[0].id}>
                  <SectionHeader title={formatDateShort(day[0].at)} />
                  {day.map((a) => (
                    <AppointmentAlarmCard key={a.id} appointment={a} current={current} onToggle={(on) => toggleAppointment(a, on)} showDate={false} />
                  ))}
                </View>
              ))
            : null}
        </>
      ) : null}
      {!data && error ? <LoadError onRetry={reload} /> : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  empty: { marginTop: 18 },
  pastToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    marginTop: 12,
    paddingHorizontal: 4,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
  pressed: { opacity: 0.6 },
});
