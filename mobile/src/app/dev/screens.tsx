import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Card, Screen, SectionHeader, Segmented, Text, toast, TopBar } from '@/components/ui';
import { scenarioTime, setScenarioTime, type ScenarioTime } from '@/lib/clock';
import { colors } from '@/theme';

// 개발용 화면 목록 — 탭에는 없고 주소로만 들어옴: /dev/screens (앱은 respecalarm://dev/screens)
// 목업의 데모 패널 대신 화면 번호로 바로 열고, 시나리오 시각(아침 · 전날 밤)을 바꿔 봄
type Row = { id: string; name: string; href: Href };

const SECTIONS: { title: string; issue: string; rows: Row[] }[] = [
  {
    title: '홈 · 알람',
    issue: '#30',
    rows: [
      { id: 'H01', name: '홈', href: '/' },
      { id: 'H02', name: '알람 목록', href: '/alarms' },
      { id: 'H03', name: '알람 설정 · 팀 주간회의', href: { pathname: '/alarm/[id]', params: { id: 'a1' } } },
      { id: 'H05', name: '새 일정 만들기', href: '/schedule/new' },
      { id: 'H07', name: '알람 울림 · 기상', href: { pathname: '/ring', params: { alarm: 'a1:WAKE' } } },
      { id: 'H07', name: '알람 울림 · 준비', href: { pathname: '/ring', params: { alarm: 'a1:PREPARE' } } },
      { id: 'H07', name: '알람 울림 · 출발', href: { pathname: '/ring', params: { alarm: 'a1:DEPARTURE' } } },
      { id: 'H08', name: '기상 확인', href: { pathname: '/wake', params: { alarm: 'a1:WAKE' } } },
    ],
  },
  {
    title: '그룹 · 친구',
    issue: '#43',
    rows: [
      { id: 'G01', name: '친구와 그룹', href: '/group' },
      { id: 'F02', name: '친구 권한 · 이수연', href: { pathname: '/friends/[id]', params: { id: 'sy' } } },
      { id: 'F03', name: '공유 권한 설정 · 캡스톤팀', href: { pathname: '/permissions', params: { relation: 'group:cap' } } },
      { id: 'G02', name: '그룹 상세 · 캡스톤팀', href: { pathname: '/groups/[id]', params: { id: 'cap' } } },
      {
        id: 'G03',
        name: '그룹원 기상 상태 · 수연',
        href: { pathname: '/groups/[id]/members/[userId]', params: { id: 'cap', userId: 'sy' } },
      },
      { id: 'G04', name: '공유받은 알람 · 수연', href: { pathname: '/friends/[id]/alarms', params: { id: 'sy' } } },
    ],
  },
  {
    title: '기록 · 제안',
    issue: '#38',
    rows: [
      { id: 'R02', name: '나의 기록', href: '/records' },
      { id: 'S01', name: '알람 조정 제안', href: { pathname: '/suggestion/[id]', params: { id: 's1' } } },
    ],
  },
  {
    title: 'AI · 루틴',
    issue: '#39',
    rows: [
      { id: 'A02', name: 'AI 대화', href: '/ai' },
      { id: 'A03', name: '하루 기록 · 일기', href: { pathname: '/journal/[date]', params: { date: '2025-05-22' } } },
      {
        id: 'A04',
        name: '루틴 편집 · 회의 전날 준비',
        href: { pathname: '/routine/[id]', params: { id: 'new', journal: '2025-05-22' } },
      },
    ],
  },
];

const TIMES = [
  ['morning', '아침 오전 7:55'],
  ['evening', '전날 밤 9:00'],
] as const;

export default function ScreenListScreen() {
  const [time, setTime] = useState<ScenarioTime>(scenarioTime());

  function changeTime(next: ScenarioTime) {
    setScenarioTime(next);
    setTime(next);
    toast('시나리오 시각을 바꿨어요. 화면을 다시 열면 반영돼요');
  }

  return (
    <Screen>
      <TopBar onBack={router.canGoBack() ? router.back : undefined} screenId="DEV" />
      <Text variant="title">목업 화면 목록</Text>
      <Text variant="lead">클릭 목업(mockup.html)의 화면 번호로 바로 열어요. 데이터는 목업과 같은 가짜 데이터예요.</Text>

      <SectionHeader title="시나리오 시각" right="5월 22일 목요일" />
      <Segmented options={TIMES} value={time} onChange={changeTime} />

      {SECTIONS.map((section) => (
        <View key={section.title}>
          <SectionHeader title={section.title} right={section.issue} />
          <Card>
            {section.rows.map((row, i) => (
              <Pressable
                key={`${row.id}-${row.name}`}
                onPress={() => router.push(row.href)}
                accessibilityRole="button"
                style={({ pressed }) => [styles.row, i > 0 && styles.divider, pressed && styles.pressed]}
              >
                <Text variant="screenId" style={styles.id}>
                  {row.id}
                </Text>
                <Text variant="body" style={styles.name}>
                  {row.name}
                </Text>
                <Text variant="body" tone="faint">
                  ›
                </Text>
              </Pressable>
            ))}
          </Card>
        </View>
      ))}

      <Text variant="caption" style={styles.note}>
        AI 화면(A02 · A03 · A04)은 AI 대기라 목업 대본대로 움직여요. 일기(A03)는 A02에서 대화를 마치면 생겨요. 실제 알람 울림은 알람 코어의 네이티브 화면이고, 울림 시험은 /dev/alarm-test에서 해요.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  divider: { borderTopWidth: 1, borderTopColor: colors.line },
  pressed: { opacity: 0.6 },
  id: { width: 36 },
  name: { flex: 1 },
  note: { marginTop: 4, marginHorizontal: 4 },
});
