import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  Avatar,
  Button,
  Card,
  Chip,
  Field,
  KeyValueRow,
  ProgressBar,
  Screen,
  SectionHeader,
  Segmented,
  Stepper,
  Text,
  toast,
  Toggle,
  TopBar,
  TopBarButton,
} from '@/components/ui';
import { HomeMissingNotice } from '@/features/alarm/components/HomeMissingNotice';
import { ChatNotice } from '@/features/voice/components/ChatNotice';
import { colors, radius } from '@/theme';

// 개발용 UI 견본 — 탭에는 없고 주소로만 들어옴: /dev/ui (앱은 respecalarm://dev/ui)
// 목업과 나란히 놓고 색 · 글꼴 · 간격이 같은지 보는 화면
const SWATCHES = ['bg', 'card', 'line', 'chip', 'ink', 'sub', 'faint', 'ok', 'mid', 'zz', 'warn'] as const;

export default function UiSampleScreen() {
  const [on, setOn] = useState(true);
  const [seg, setSeg] = useState<'friend' | 'group'>('friend');
  const [nickname, setNickname] = useState('지형');
  const [prepare, setPrepare] = useState(60);

  return (
    <Screen>
      <TopBar onBack={router.canGoBack() ? router.back : undefined} screenId="DEV" right={<TopBarButton label="설정" />} />
      <Text variant="title">UI 견본</Text>
      <Text variant="lead">목업과 같은 색 · 글꼴 · 간격인지 확인하는 화면이에요.</Text>

      <SectionHeader title="색" />
      <View style={styles.swatches}>
        {SWATCHES.map((name) => (
          <View key={name} style={styles.swatch}>
            <View style={[styles.chipColor, { backgroundColor: colors[name] }]} />
            <Text variant="caption">{name}</Text>
          </View>
        ))}
      </View>

      <SectionHeader title="글자" right="Pretendard" />
      <Card>
        <Text variant="screenId">H01 화면 번호</Text>
        <Text variant="title">좋은 아침이에요</Text>
        <Text variant="lead">약속 정보를 바탕으로 필요한 알람을 계산해요.</Text>
        <Text variant="section">오늘 일정</Text>
        <Text variant="big">오전 8:00 기상</Text>
        <Text variant="body">본문 14 — 준비 20분 · 이동 50분 · 여유 10분</Text>
        <Text variant="small">보조 12.5 — 최근 3번의 준비가 평균 12분 더 걸렸어요.</Text>
        <Text variant="caption">설명 11.5 — 응답은 오늘의 기상 기록에 반영돼요.</Text>
      </Card>

      <SectionHeader title="알람 카드 예" />
      <Card>
        <View style={styles.between}>
          <Chip label="중요" variant="ink" />
          <Toggle value={on} onChange={setOn} label="팀 주간회의 알람" />
        </View>
        <View style={[styles.between, !on && styles.off]}>
          <View style={styles.bigTime}>
            <Text variant="body" tone="sub">
              오전
            </Text>
            <Text variant="number">8:00</Text>
            <Text variant="small">기상</Text>
          </View>
          <View style={styles.chain}>
            <Text variant="label" weight={600}>
              오전 8:30 준비
            </Text>
            <Text variant="label" weight={600}>
              오전 9:00 출발
            </Text>
          </View>
        </View>
        <Text variant="caption">팀 주간회의 · 세종대학교 · 오전 10:00</Text>
      </Card>

      <SectionHeader title="이름 — 값" />
      <Card>
        <KeyValueRow first label="일정명" value="팀 주간회의" />
        <KeyValueRow label="날짜" value="5월 22일 (목)" />
        <KeyValueRow label="이동 시간" value="50분" sub="길찾기 + 내 실측 3회" />
        <KeyValueRow label="알람 받기" value={<Toggle value={on} onChange={setOn} label="알람 받기" />} />
      </Card>

      <SectionHeader title="입력 · 숫자" right="온보딩 · 설정" />
      <Card>
        <Field first label="닉네임" value={nickname} onChangeText={setNickname} maxLength={30} placeholder="이름" />
        <Stepper label="준비 시간" value={prepare} onChange={setPrepare} min={10} max={180} unit="분" />
      </Card>

      <SectionHeader title="고르기 · 사람 · 진행" />
      <Segmented
        options={[
          ['friend', '친구'],
          ['group', '그룹'],
        ]}
        value={seg}
        onChange={setSeg}
      />
      <Card>
        <View style={styles.people}>
          <Avatar initial="수" dot="ok" />
          <Avatar initial="지" dot="mid" />
          <Avatar initial="준" dot="zz" />
          <Avatar initial="나" small />
        </View>
        <Text variant="small">화면 사용 1.4분 / 기준 1분</Text>
        <ProgressBar value={0.7} threshold={0.5} thick />
      </Card>
      <Card variant="dash">
        <Text variant="body" tone="sub">
          아직 루틴이 없어요. AI 대화에서 제안받을 수 있어요.
        </Text>
      </Card>

      <SectionHeader title="버튼" />
      <View style={styles.stack}>
        <Button label="저장하고 알람 설정하기" onPress={() => {}} />
        <Button label="그대로 두기" variant="ghost" onPress={() => {}} />
        <Button label="취소" variant="plain" onPress={() => {}} />
        <Button label="+ 새 일정" small onPress={() => {}} />
        <Button label="저장 (비활성)" disabled />
      </View>

      <SectionHeader title="칩" />
      <View style={styles.row}>
        <Chip label="매주 목요일" />
        <Chip label="길찾기" variant="fill" />
        <Chip label="강" variant="ink" />
      </View>

      <SectionHeader title="AI 대화 안내" right="A02" />
      <View style={styles.stack}>
        <ChatNotice
          kind="failed"
          onRetry={() => toast('다시 시도')}
          onManual={() => toast('직접 일정 만들기')}
          onDone={() => toast('대화 마치기')}
        />
        <ChatNotice kind="failed" busy onRetry={() => {}} onManual={() => {}} onDone={() => {}} />
        <ChatNotice kind="limit" onManual={() => toast('직접 일정 만들기')} onDone={() => toast('대화 마치기')} />
      </View>

      <SectionHeader title="집 위치 안내" />
      <HomeMissingNotice onPickHome={() => toast('집 찾기 시트가 열려요')} />
      <HomeMissingNotice onPickHome={() => {}} busy />
    </Screen>
  );
}

const styles = StyleSheet.create({
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  swatch: { alignItems: 'center', gap: 4, width: 52 },
  chipColor: { width: 40, height: 40, borderRadius: radius.icon, borderWidth: 1, borderColor: colors.line },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  off: { opacity: 0.45 },
  bigTime: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 6 },
  chain: { alignItems: 'flex-end', gap: 2 },
  people: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  stack: { gap: 10 },
  row: { flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
});
