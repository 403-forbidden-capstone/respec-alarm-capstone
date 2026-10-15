import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, LoadError, Loading, Screen, Segmented, Text, Timeline, toast, TopBar, type TimelineItem } from '@/components/ui';
import { getDay, getMonth, getWeek, recordToday, weekEmptyText } from '@/features/records/api';
import { dateOf, daysInMonth, shiftMonth, weekStart } from '@/features/records/calendar';
import { MonthCalendar } from '@/features/records/components/MonthCalendar';
import { ScoreBars } from '@/features/records/components/ScoreBars';
import { WeekStrip } from '@/features/records/components/WeekStrip';
import { useLoadOn } from '@/features/records/hooks/useLoadOn';
import type { MonthDay, TimelineRow, WeekSummary } from '@/features/records/types';
import { addDays, dateParts, dayKey, formatTime, isSameDay, timeParts } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';

type RecordView = 'month' | 'week' | 'day';

const VIEWS = [
  ['month', '월간'],
  ['week', '주간'],
  ['day', '일간'],
] as const;

const toItem = (row: TimelineRow): TimelineItem => ({ time: formatTime(row.at), label: row.label, source: row.source, past: row.past });

type Register = (reload: (() => Promise<unknown>) | null) => void;

// 04 기록 탭 · R02 나의 기록 — 월간 달력 · 주간 기상 흐름 · 일간(설정한 값과 실제로 일어난 일)
// 화살표로 앞뒤 달 · 주를 넘기고, 달력에서 오늘을 누르면 일간으로. 일정 추가 · 상세는 src/app/schedule/
// 보고 있는 날(anchor)을 월간 · 주간이 같이 씀 — 칸을 바꿔도 보던 기간이 그대로. 일간은 아직 오늘만 열림(D48)
export default function RecordsScreen() {
  const [view, setView] = useState<RecordView>('week'); // 목업 첫 화면은 주간
  const [anchor, setAnchor] = useState(() => recordToday());
  // 당겨서 새로고침 — 지금 보이는 구역이 자기 다시 읽기를 맡겨 둠
  const reloadRef = useRef<(() => Promise<unknown>) | null>(null);
  const register = useCallback<Register>((reload) => {
    reloadRef.current = reload;
  }, []);

  // 앞뒤 달 — 같은 날짜로, 그 달에 없으면 말일로 (31일 → 30일)
  function moveMonth(delta: number) {
    setAnchor((a) => {
      const { year, month, day } = dateParts(a);
      const next = shiftMonth(year, month, delta);
      return dateOf(next.year, next.month, Math.min(day, daysInMonth(next.year, next.month)));
    });
  }

  function openDay(date: Date) {
    setAnchor(date);
    setView('day');
  }

  // 목업은 오늘만 일간 기록이 있음 — 실데이터(#41)가 붙으면 기록 있는 날 모두 openDay로 (D48)
  function pressDay(d: MonthDay) {
    const { month } = dateParts(d.date);
    if (d.isToday) openDay(d.date);
    else if (d.isFuture) toast('아직 오지 않은 날이에요');
    else if (d.mark === 'none') toast(`${month}월 ${d.day}일에는 남은 기록이 없어요`);
    else toast(`${month}월 ${d.day}일 기록은 아직 열 수 없어요`);
  }

  return (
    <Screen onRefresh={() => reloadRef.current?.()}>
      <TopBar screenId="R02" />
      <Text variant="title" style={styles.title}>
        나의 기록
      </Text>
      <Text variant="lead" style={styles.lead}>
        실행 흐름과 하루의 변화를 확인해요.
      </Text>
      <Segmented options={VIEWS} value={view} onChange={setView} />

      <View style={styles.body}>
        {view === 'month' ? (
          <MonthSection
            anchor={anchor}
            onPrev={() => moveMonth(-1)}
            onNext={() => moveMonth(1)}
            onPressDay={pressDay}
            register={register}
          />
        ) : view === 'week' ? (
          <WeekSection
            anchor={anchor}
            onPrev={() => setAnchor((a) => addDays(a, -7))}
            onNext={() => setAnchor((a) => addDays(a, 7))}
            register={register}
          />
        ) : (
          <DaySection anchor={anchor} register={register} />
        )}
      </View>
    </Screen>
  );
}

// 보이는 구역의 다시 읽기를 화면에 맡기고, 구역이 사라지면 거둠
function useRegister(register: Register, reload: () => Promise<unknown>) {
  useEffect(() => {
    register(reload);
    return () => register(null);
  }, [register, reload]);
}

type MonthProps = {
  anchor: Date;
  onPrev: () => void;
  onNext: () => void;
  onPressDay: (d: MonthDay) => void;
  register: Register;
};

// 월간 — 달력 + 오늘 기록 카드(오늘이 든 달일 때만). 달이 바뀌어도 앞 달력을 둔 채 새로 읽음
function MonthSection({ anchor, onPrev, onNext, onPressDay, register }: MonthProps) {
  const { year, month } = dateParts(anchor);
  const { data, error, reload } = useLoadOn(() => getMonth(year, month), `${year}-${month}`);
  useRegister(register, reload);
  if (!data) return error ? <LoadError onRetry={reload} /> : <Loading />;
  const today = dateParts(data.today.date);
  const viewingThisMonth = today.year === year && today.month === month;

  return (
    <>
      <MonthCalendar record={data} onPrev={onPrev} onNext={onNext} onPressDay={onPressDay} />
      {/* 오늘 기록 카드 → A03 하루 기록 (목업 recMonth data-to="journal") */}
      {viewingThisMonth ? (
        <Card
          onPress={() => router.push({ pathname: '/journal/[date]', params: { date: dayKey(data.today.date) } })}
          accessibilityLabel={`${today.month}월 ${today.day}일 하루 기록 열기`}
        >
          <View style={styles.between}>
            <View style={styles.grow}>
              <Text variant="small">
                {today.month}월 {today.day}일 기록
              </Text>
              <Text variant="bodyStrong" style={styles.cardMain}>
                실행 기록 {data.today.eventCount}개 · AI 일기 {data.today.journalWritten ? '작성됨' : '아직 없음'}
              </Text>
            </View>
            <Text variant="big" tone="sub" weight={400}>
              →
            </Text>
          </View>
        </Card>
      ) : null}
    </>
  );
}

// 주간 — 날짜 줄 + 평균 기상 · 목표 기상률 · 날마다 실행 점수 · AI 코칭. 주가 바뀌어도 앞 날짜 줄을 둔 채 새로 읽음
function WeekSection({ anchor, onPrev, onNext, register }: { anchor: Date; onPrev: () => void; onNext: () => void; register: Register }) {
  const { data, error, reload } = useLoadOn(() => getWeek(anchor), dayKey(weekStart(anchor)));
  useRegister(register, reload);
  if (!data) return error ? <LoadError onRetry={reload} /> : <Loading />;

  return (
    <>
      <WeekStrip record={data} onPrev={onPrev} onNext={onNext} />
      {data.summary ? (
        <WeekSummaryCards summary={data.summary} />
      ) : (
        <Card>
          <Text variant="body" tone="sub">
            {weekEmptyText(data)}
          </Text>
        </Card>
      )}
    </>
  );
}

function WeekSummaryCards({ summary: s }: { summary: WeekSummary }) {
  return (
    <>
      <View style={styles.stats}>
        <Stat label="평균 기상" value={timeParts(s.averageWake).hm} sub={s.averageText} />
        <Stat label="목표 기상률" value={`${s.goalRate}%`} sub={s.goalText} />
      </View>
      <Card>
        <Text variant="label" style={styles.label}>
          주간 실행 흐름
        </Text>
        <ScoreBars bars={s.bars} />
        {s.todayPending ? (
          <Text variant="caption" style={styles.note}>
            오늘 기록은 기상 확인 뒤에 더해져요.
          </Text>
        ) : null}
      </Card>
      <Card>
        <Text variant="label" style={styles.label}>
          이번 주 AI 코칭
        </Text>
        <Text variant="reading">{s.coaching}</Text>
        {/* 일기(A03)의 루틴 제안과 같은 화면(A04) — 오늘 기록을 바탕으로 만든 초안 */}
        <View style={styles.coachAction}>
          <Button
            small
            variant="ghost"
            label="루틴 만들기"
            onPress={() => router.push({ pathname: '/routine/[id]', params: { id: 'new', journal: dayKey(recordToday()) } })}
          />
        </View>
      </Card>
    </>
  );
}

// 숫자 하나 카드 (.stat)
function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <Card style={styles.stat}>
      <Text variant="label">{label}</Text>
      <Text variant="stat" style={styles.statValue}>
        {value}
      </Text>
      <Text variant="label">{sub}</Text>
    </Card>
  );
}

// 일간 — 그날 설정한 알람 · 실제로 일어난 일 (마지막 줄이 지금). 목업은 오늘만 있어서 다른 기간을 보다 와도 오늘을 보여 줌
function DaySection({ anchor, register }: { anchor: Date; register: Register }) {
  const date = recordToday();
  const { data, error, reload } = useLoad(() => getDay(date));
  useRegister(register, reload);
  if (!data) return error ? <LoadError onRetry={reload} /> : <Loading />;
  const { month, day } = dateParts(data.date);

  return (
    <>
      {isSameDay(anchor, date) ? null : (
        <Text variant="label" tone="sub" style={styles.dayNote}>
          다른 날 기록은 아직 열 수 없어요. 오늘 기록을 보여 드려요.
        </Text>
      )}
      <Card>
        <Text variant="label" style={styles.label}>
          {month}월 {day}일 · 설정한 값
        </Text>
        {data.planned.length ? (
          <Timeline items={data.planned.map(toItem)} />
        ) : (
          <Text variant="body" tone="sub">
            설정한 알람이 없어요.
          </Text>
        )}
      </Card>
      <Card>
        <Text variant="label" style={styles.label}>
          실제로 일어난 일
        </Text>
        {data.actual.length ? (
          <Timeline items={data.actual.map(toItem)} highlightLast />
        ) : (
          <Text variant="body" tone="sub">
            아직 기록이 없어요.
          </Text>
        )}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  title: { marginTop: 8, marginBottom: 4 },
  lead: { marginBottom: 18 },
  body: { marginTop: 12 },
  label: { marginBottom: 8 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  grow: { flex: 1 },
  cardMain: { marginTop: 2 },
  stats: { flexDirection: 'row', gap: 10 },
  stat: { flex: 1 },
  statValue: { marginVertical: 4 },
  note: { marginTop: 10 },
  coachAction: { marginTop: 12 },
  dayNote: { marginBottom: 10, marginHorizontal: 4 },
});
