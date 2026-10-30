import { useState } from 'react';
import { StyleSheet } from 'react-native';

import { Button, Screen, Text, toast, TopBar } from '@/components/ui';
import { listPlaces } from '@/features/alarm/api';
import { PlaceSearchSheet } from '@/features/alarm/components/PlaceSearchSheet';
import { TimeSheet } from '@/features/alarm/components/TimePicker';
import { homeOf } from '@/features/alarm/placeSheet';
import { useAuth } from '@/features/auth/AuthProvider';
import { CampusCard } from '@/features/onboarding/components/CampusCard';
import { ImportNoticeCard } from '@/features/onboarding/components/ImportNoticeCard';
import { TimetableStep } from '@/features/onboarding/components/TimetableStep';
import { useTimetableStep } from '@/features/onboarding/hooks/useTimetableStep';
import { rowStatus } from '@/features/onboarding/timetable';
import { getImportBatch } from '@/lib/importHandoff';
import { now } from '@/lib/clock';
import { addMinutes, minuteOfDay, startOfDay } from '@/lib/format';
import { backOrHome } from '@/lib/nav';
import { useAction } from '@/lib/useAction';

// 시간표 가져오기 확인 — 사진 · 캘린더에서 읽어 온 수업을 줄마다 고치고 빼고, 학교 위치를 한 번 정한 뒤 [저장]
// 줄 편집 · 저장은 온보딩 시간표 단계와 같은 부품(TimetableStep · useTimetableStep) — 설정에서 들어온 길이라 온보딩 밖에서도 같은 화면
// 읽어 온 수업은 화면을 열 때 lib/importHandoff에서 받음. 저장은 줄마다 길찾기 → 일정 만들기를 차례로 하고, 실패한 줄만 남아 고쳐서 다시 저장
export default function TimetableImportScreen() {
  const { profile } = useAuth();
  const { busy, run } = useAction();
  const [batch] = useState(() => getImportBatch());
  const timetable = useTimetableStep(profile?.default_transport ?? 'TRANSIT', batch);
  const noHome = homeOf(profile) == null;
  const count = timetable.rows.filter((row) => rowStatus(row) === 'complete').length; // 저장할 수업 수 (이미 저장한 줄 포함)

  // 줄 하나라도 못 만들면 save()가 false — 이 화면에 머물러 실패한 줄을 고침. 다 만들었으면 이전 화면으로
  const save = () =>
    run(async () => {
      if (!(await timetable.save())) return;
      toast(`수업 ${count}개를 저장했어요`);
      backOrHome();
    }, '저장하지 못했어요');

  const head = <TopBar onBack={backOrHome} />;
  const footer = <Button label={count ? `수업 ${count}개 저장` : '저장'} onPress={save} loading={busy} disabled={!timetable.canSave || noHome} />;

  return (
    <Screen footer={footer}>
      {head}
      <Text variant="title" style={styles.title}>
        가져온 수업 확인
      </Text>
      <Text variant="lead" tone="sub" style={styles.lead}>
        맞는 줄만 저장해요. 저장하면 수업 전 알람이 자동으로 맞춰져요
      </Text>
      {timetable.notice ? <ImportNoticeCard notice={timetable.notice} onDismiss={timetable.dismissNotice} /> : null}
      {noHome ? (
        <Text variant="small" tone="warn" style={styles.noHome}>
          집 위치를 정하지 않아서 이동시간을 구하지 못해요. 설정에서 집을 먼저 정해 주세요
        </Text>
      ) : null}
      <CampusCard campus={timetable.campus} onOpen={timetable.openCampus} disabled={busy} />
      <TimetableStep
        rows={timetable.rows}
        onChangeRow={timetable.onChangeRow}
        onAddRow={timetable.onAddRow}
        onRemoveRow={timetable.onRemoveRow}
        onPickPlace={timetable.onPickPlace}
        onPickTime={timetable.onPickTime}
        saving={busy}
      />
      <PlaceSearchSheet
        visible={timetable.campusOpen}
        onClose={timetable.closeCampus}
        onPick={timetable.pickCampus}
        search={(query) => listPlaces(query)}
        title="학교 찾기"
      />
      <PlaceSearchSheet
        visible={timetable.placeOpen}
        onClose={timetable.closePlace}
        onPick={timetable.pickPlace}
        search={(query) => listPlaces(query)}
        title="수업 장소 찾기"
      />
      {timetable.timeRow?.startMinutes != null ? (
        <TimeSheet
          visible
          onClose={timetable.closeTime}
          title="시작 시각"
          value={addMinutes(startOfDay(now()), timetable.timeRow.startMinutes)}
          onChange={(at) => timetable.changeTime(minuteOfDay(at))}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8 },
  lead: { marginTop: 4, marginBottom: 16 },
  noHome: { marginBottom: 12 },
});
