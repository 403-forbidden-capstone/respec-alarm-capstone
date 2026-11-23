import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { EmptyState, Loading, LoadError, Screen, SectionHeader, Text, TopBar, TopBarButton } from '@/components/ui';
import { listAppointments } from '@/features/alarm/api';
import { ProposalCards } from '@/features/social/components/ProposalCards';
import { AppointmentAlarmCard } from '@/features/alarm/components/AppointmentAlarmCard';
import { NewAlarmSheet } from '@/features/alarm/components/NewAlarmSheet';
import { TextLink } from '@/features/alarm/components/TextLink';
import { useAppointmentToggle } from '@/features/alarm/hooks/useAppointmentToggle';
import { useNow } from '@/features/alarm/hooks/useNow';
import { useStandaloneAlarmSave } from '@/features/alarm/hooks/useStandaloneAlarmSave';
import { dayHeading, groupByDay, seriesInfo, splitUpcoming } from '@/features/alarm/schedule';
import { formatDateShort } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

const HIGHLIGHT_MS = 2600; // 방금 만든 일정 테두리가 남는 시간

// 02 알람 탭 · H02 알람 목록 — 오늘부터의 일정마다 기상 · 준비 · 출발 알람. 지난 일정은 맨 아래에 접어 둠
// 홈 '알람 전체'로 들어가던 화면을 2번 탭으로 올림 (D110). 주소는 /alarms 그대로라 다른 화면의 링크는 같음
// 반복 일정은 하나당 한 장 (지금 이후 가장 가까운 회차) — 카드에 "다음 회차 · 반복 요일"만, 회차 목록은 알람 설정(H03)에서
// ?highlight=<일정 id>: 새 일정(H05)을 저장하고 돌아왔을 때 그 카드에 잠깐 테두리. "+ 새 알람"(기본 알람, #588)을 저장했을 때도 같은 주소 값으로
export default function AlarmsScreen() {
  const { highlight } = useLocalSearchParams<{ highlight?: string }>();
  const { data, error, reload } = useLoad(listAppointments);
  const current = useNow();
  const toggleAppointment = useAppointmentToggle(reload);
  // 기본 알람(#588)을 저장하면 목록을 다시 읽고 새 카드에 테두리
  const standalone = useStandaloneAlarmSave((id) => {
    void reload();
    router.setParams({ highlight: id });
  });
  const [showPast, setShowPast] = useState(false);
  const [newAlarm, setNewAlarm] = useState(false);
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
        right={
          <View style={styles.topActions}>
            {/* 일정 없이 시각 · 반복만 정하는 기본 알람 (#588) */}
            <TopBarButton label="+ 새 알람" onPress={() => setNewAlarm(true)} />
            <TopBarButton label="+ 새 일정" onPress={() => router.push({ pathname: '/schedule/new', params: { from: 'alarms' } })} />
          </View>
        }
      />
      <Text variant="title" style={styles.title}>
        알람
      </Text>
      {/* 친구가 보낸 알람 시각 제안 — 푸시를 누르면 여기로 (친구 10장) */}
      <ProposalCards onChanged={() => void reload()} />
      <Text variant="lead">일정마다 기상 · 준비 · 출발 알람을 계산해 두었어요.</Text>
      <View style={styles.links}>
        <TextLink label="학교 시간표 · 반복 일정 지우기" onPress={() => router.push('/timetable')} />
      </View>
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
            <AppointmentAlarmCard key={a.id} appointment={a} current={current} onToggle={(on) => toggleAppointment(a, on)} highlight={a.id === lit} showDate={false} {...seriesInfo(a, current)} />
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
                    <AppointmentAlarmCard key={a.id} appointment={a} current={current} onToggle={(on) => toggleAppointment(a, on)} showDate={false} {...seriesInfo(a, current)} />
                  ))}
                </View>
              ))
            : null}
        </>
      ) : null}
      {!data && error ? <LoadError onRetry={reload} /> : null}
      <NewAlarmSheet visible={newAlarm} onClose={() => setNewAlarm(false)} current={current} busy={standalone.busy} onSave={standalone.save} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  topActions: { flexDirection: 'row', gap: 8 },
  links: { marginTop: 8, alignSelf: 'flex-start' },
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
