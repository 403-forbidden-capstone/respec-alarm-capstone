import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Button, Card, confirm, EmptyState, Loading, LoadError, Screen, Text, toast, TopBar } from '@/components/ui';
import { deleteAppointment, listAppointments } from '@/features/alarm/api';
import { useAuth } from '@/features/auth/AuthProvider';
import { CalendarPickSheet } from '@/features/onboarding/components/CalendarPickSheet';
import { ImportEntryCard } from '@/features/onboarding/components/ImportEntryCard';
import { useCalendarImport } from '@/features/onboarding/hooks/useCalendarImport';
import { usePhotoImport } from '@/features/onboarding/hooks/usePhotoImport';
import { setImportBatch } from '@/features/onboarding/importHandoff';
import { classSeriesOf, seriesLine, type ClassSeries } from '@/features/onboarding/timetableList';
import { TIMETABLE_PATHS } from '@/lib/flags';
import { backOrHome } from '@/lib/nav';
import { useAction } from '@/lib/useAction';
import { useLoad } from '@/lib/useLoad';
import { colors } from '@/theme';

// 학교 시간표 — 매주 반복하는 일정을 요일 · 시각 순으로 보고 지움. 사진 · 캘린더로 한 번에 넣는 입구도 여기 (설정에서 옮김, 11/2)
//   들어오는 길: 홈 '오늘 일정' 옆 · 알람 목록 · 새 일정 맨 위
//   지우기 = 그 반복의 다음 회차부터 모두(following) — 지난 회차 기록은 남음. 남이 만든 공동 약속은 못 지움(N6)
//   가져오기는 실데이터 + 로그인일 때만 (설정에 있던 때와 같은 조건 — 사진 읽기 · 저장이 서버를 부름)
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
  const series = data ? classSeriesOf(data) : [];
  const deletable = series.filter((s) => s.canDelete);

  // 하나씩 차례로 지움 — 중간에 실패해도 그때까지 지운 것이 목록에 반영되게 끝나면 늘 다시 읽음
  const remove = (targets: ClassSeries[], title: string) =>
    void run(async () => {
      if (!(await confirm({ title, message: '앞으로 회차와 알람이 모두 지워져요. 지난 기록은 남아요', okLabel: '삭제', destructive: true }))) return;
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
        매주 반복하는 일정이에요. 수업마다 알람이 따로 맞춰져요
      </Text>

      {canImport ? (
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
      {data && !series.length ? <EmptyState title="반복 일정이 없어요" body="시간표 사진이나 폰 캘린더에서 수업을 한 번에 넣을 수 있어요." /> : null}
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
              {s.canDelete ? (
                <Button variant="ghost" small label="삭제" onPress={() => remove([s], `'${s.title}' 일정을 지울까요?`)} disabled={busy} />
              ) : (
                <Text variant="small" tone="sub">
                  공동 약속
                </Text>
              )}
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
