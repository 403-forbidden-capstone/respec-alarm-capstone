import { router, useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Button, Card, confirm, EmptyState, Loading, LoadError, Screen, Text, toast, TopBar } from '@/components/ui';
import { deleteAppointment, listAppointments } from '@/features/alarm/api';
import { deleteConfirmCopy } from '@/features/alarm/editSheet';
import { useAuth } from '@/features/auth/AuthProvider';
import { CalendarPickSheet } from '@/features/onboarding/components/CalendarPickSheet';
import { ImportEntryCard } from '@/features/onboarding/components/ImportEntryCard';
import { useCalendarImport } from '@/features/onboarding/hooks/useCalendarImport';
import { usePhotoImport } from '@/features/onboarding/hooks/usePhotoImport';
import { setImportBatch } from '@/features/onboarding/importHandoff';
import { classSeriesOf, seriesLine, type ClassSeries } from '@/features/onboarding/timetableList';
import { TIMETABLE_PATHS } from '@/lib/flags';
import { isMock } from '@/lib/mode';
import { backOrHome } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { useLoad } from '@/lib/useLoad';
import { TextLink } from '@/features/alarm/components/TextLink';
import { colors } from '@/theme';

// 학교 시간표 — 매주 반복하는 일정을 요일 · 시각 순으로 보고 지움. 사진 · 캘린더로 한 번에 넣는 입구도 여기 (설정에서 옮김, 11/2)
//   들어오는 길: 홈 '오늘 일정' 옆 · 알람 목록 · 새 일정 맨 위
//   지우기 = 그 반복의 다음 회차부터 모두(following) — 지난 회차 기록은 남음. 남이 만든 공동 약속은 못 지움(N6)
//   내가 만든 공동 약속은 지우면 모두에게서 사라짐 → 확인 창에 그 문구(일정 지우기 창과 같은 글), [모두 지우기]에서는 뺌
//   가져오기는 실데이터 + 로그인일 때만 (설정에 있던 때와 같은 조건 — 사진 읽기 · 저장이 서버를 부름)
const KEEP_NOTE = '앞으로 회차와 알람이 모두 지워져요. 지난 기록은 남아요';
const SHARED_NOTE = `${deleteConfirmCopy({ shared: true, repeated: true }).message}. 지난 기록은 남아요`;

export default function TimetableScreen() {
  const { data, error, reload } = useLoad(listAppointments);
  const { session, enabled } = useAuth();
  const { busy, run } = useAction();
  const photoImport = usePhotoImport();
  const calendarImport = useCalendarImport((batch) => {
    setImportBatch(batch);
    router.push('/timetable-import');
  });
  const canImport = enabled && session != null && (TIMETABLE_PATHS.photo || TIMETABLE_PATHS.calendar);
  const { preview } = useLocalSearchParams<{ preview?: string }>(); // 가짜 데이터 모드에서만: /timetable?preview=empty로 수업 없는 화면을 봄 (시안 확인용)
  const series = data && !(isMock() && preview === 'empty') ? classSeriesOf(data) : [];
  const empty = data != null && series.length === 0; // 수업이 하나도 없음 — 입구 줄에 [직접 넣기]
  const deletable = series.filter((s) => !s.shared);

  // 하나씩 차례로 지움 — 중간에 실패해도 그때까지 지운 것이 목록에 반영되게 끝나면 늘 다시 읽음
  const remove = (targets: ClassSeries[], title: string, message = KEEP_NOTE) =>
    void run(async () => {
      if (!(await confirm({ title, message, okLabel: '삭제', destructive: true }))) return;
      try {
        for (const s of targets) await deleteAppointment(s.id, 'following');
      } finally {
        await reload();
      }
      toast(targets.length > 1 ? `반복 일정 ${targets.length}개를 지웠어요` : `'${targets[0].title}' 일정을 지웠어요`);
    }, '지우지 못했어요');

  return (
    <Screen onRefresh={reload}>
      <TopBar onBack={backOrHome} />
      <Text variant="title" style={styles.title}>
        학교 시간표
      </Text>
      <Text variant="lead" tone="sub" style={styles.lead}>
        매주 반복하는 일정(수업 포함)이에요. 일정마다 알람이 따로 맞춰져요
      </Text>

      {canImport || empty ? (
        <>
          <ImportEntryCard
            onPhoto={
              TIMETABLE_PATHS.photo
                ? async () => {
                    const batch = await photoImport.pick();
                    if (batch) {
                      setImportBatch(batch);
                      router.push('/timetable-import');
                    }
                  }
                : undefined
            }
            onCalendar={TIMETABLE_PATHS.calendar ? calendarImport.start : undefined}
            onManual={empty ? () => router.push('/schedule/new') : undefined}
            busy={photoImport.reading || calendarImport.busy}
            reading={photoImport.reading ? 'photo' : calendarImport.reading ? 'calendar' : null}
          />
          <CalendarPickSheet
            visible={calendarImport.pickerOpen}
            calendars={calendarImport.calendars}
            picked={calendarImport.picked}
            onToggle={calendarImport.toggle}
            onConfirm={calendarImport.confirm}
            onClose={calendarImport.closePicker}
          />
        </>
      ) : null}

      {!data && !error ? <Loading text="시간표를 불러오는 중" /> : null}
      {!data && error ? <LoadError onRetry={reload} /> : null}
      {data && !series.length ? <EmptyState title="반복 일정이 없어요" /> : null}
      {series.length ? (
        <Card>
          {series.map((s, i) => (
            <View key={s.id} style={[styles.row, i > 0 && styles.divider]}>
              <View style={styles.rowText}>
                <Text variant="label" tone="ink">
                  {s.title}
                </Text>
                <Text variant="small" tone="sub">
                  {seriesLine(s)}
                </Text>
              </View>
              <TextLink label="···" accessibilityLabel={`${s.title} 지우기`} onPress={() => remove([s], `'${s.title}' 일정을 지울까요?`, s.shared ? SHARED_NOTE : KEEP_NOTE)} disabled={busy} />
            </View>
          ))}
        </Card>
      ) : null}
      {deletable.length > 1 ? (
        <Button variant="ghost" label={`반복 일정 ${deletable.length}개 모두 지우기`} onPress={() => remove(deletable, `반복 일정 ${deletable.length}개를 모두 지울까요?`)} disabled={busy} />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 4 },
  lead: { marginTop: 6, marginBottom: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12 },
  divider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  rowText: { flex: 1, gap: 2 },
});
