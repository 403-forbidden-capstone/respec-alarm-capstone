import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Card, LoadError, Loading, Screen, Segmented, Text, Timeline, toast, TopBar, type TimelineItem } from '@/components/ui';
import { getDay, getMonth, getWeek, recordToday, weekEmptyText } from '@/features/records/api';
import { dayRelative, weekStart } from '@/features/records/calendar';
import { CalendarHeader } from '@/features/records/components/CalendarHeader';
import { MonthCalendar } from '@/features/records/components/MonthCalendar';
import { ScoreBars } from '@/features/records/components/ScoreBars';
import { WeekStrip } from '@/features/records/components/WeekStrip';
import { useLoadOn } from '@/features/records/hooks/useLoadOn';
import {
  canMoveNextDay,
  goToday,
  initialNav,
  moveDay,
  moveMonth,
  moveWeek,
  openDay,
  selectView,
} from '@/features/records/navigation';
import type { TimelineRow, WeekSummary } from '@/features/records/types';
import { dateParts, dayKey, formatDate, formatTime, isSameDay, timeParts } from '@/lib/format';

const VIEWS = [
  ['month', '월간'],
  ['week', '주간'],
  ['day', '일간'],
] as const;

const toItem = (row: TimelineRow): TimelineItem => ({ time: formatTime(row.at), label: row.label, source: row.source, past: row.past });

type Register = (reload: (() => Promise<unknown>) | null) => void;

// 달력 · 주간 줄의 날짜 · 주간 막대를 눌렀을 때 — MonthDay · WeekDay · WeekBar가 모두 맞음
type PressDay = (d: { date: Date; isFuture: boolean }) => void;

// 04 기록 탭 · R02 나의 기록 — 월간 달력 · 주간 기상 흐름 · 일간(설정한 값과 실제로 일어난 일)
// 화살표로 앞뒤 달 · 주 · 날을 넘기고, 달력 · 주간 줄의 날짜 · 주간 막대를 누르면 그 날의 일간으로 (D48). 일정 추가 · 상세는 src/app/schedule/
// 보던 달 · 주(period)와 일간으로 보는 날(day)은 따로 — 일간에서 날을 넘겨도 월간 · 주간은 보던 그대로 (규칙은 features/records/navigation.ts)
export default function RecordsScreen() {
  const today = recordToday();
  const [nav, setNav] = useState(() => initialNav(today));
  // 당겨서 새로고침 — 지금 보이는 구역이 자기 다시 읽기를 맡겨 둠
  const reloadRef = useRef<(() => Promise<unknown>) | null>(null);
  const register = useCallback<Register>((reload) => {
    reloadRef.current = reload;
  }, []);

  // 월간 · 주간의 날짜 · 주간 막대 → 그 날의 일간. 아직 오지 않은 날은 남은 기록이 없어 열지 않음
  const pressDay: PressDay = (d) => {
    if (d.isFuture) toast('아직 오지 않은 날이에요');
    else setNav((n) => openDay(n, d.date));
  };

  return (
    <Screen onRefresh={() => reloadRef.current?.()}>
      <TopBar screenId="R02" />
      <Text variant="title" style={styles.title}>
        나의 기록
      </Text>
      <Text variant="lead" style={styles.lead}>
        실행 흐름과 하루의 변화를 확인해요.
      </Text>
      <Segmented options={VIEWS} value={nav.view} onChange={(view) => setNav((n) => selectView(n, view))} />

      <View style={styles.body}>
        {nav.view === 'month' ? (
          <MonthSection
            period={nav.period}
            onPrev={() => setNav((n) => moveMonth(n, -1))}
            onNext={() => setNav((n) => moveMonth(n, 1))}
            onPressDay={pressDay}
            register={register}
          />
        ) : nav.view === 'week' ? (
          <WeekSection
            period={nav.period}
            onPrev={() => setNav((n) => moveWeek(n, -1))}
            onNext={() => setNav((n) => moveWeek(n, 1))}
            onPressDay={pressDay}
            register={register}
          />
        ) : (
          <DaySection
            day={nav.day}
            today={today}
            canNext={canMoveNextDay(nav, today)}
            onPrev={() => setNav((n) => moveDay(n, -1, today))}
            onNext={() => setNav((n) => moveDay(n, 1, today))}
            onToday={() => setNav((n) => goToday(n, today))}
            register={register}
          />
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
  period: Date;
  onPrev: () => void;
  onNext: () => void;
  onPressDay: PressDay;
  register: Register;
};

// 월간 — 달력 + 오늘 기록 카드(오늘이 든 달일 때만). 달이 바뀌어도 앞 달력을 둔 채 새로 읽음
function MonthSection({ period, onPrev, onNext, onPressDay, register }: MonthProps) {
  const { year, month } = dateParts(period);
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

type WeekProps = { period: Date; onPrev: () => void; onNext: () => void; onPressDay: PressDay; register: Register };

// 주간 — 날짜 줄 + 평균 기상 · 목표 기상률 · 날마다 실행 점수 · AI 코칭. 주가 바뀌어도 앞 날짜 줄을 둔 채 새로 읽음
function WeekSection({ period, onPrev, onNext, onPressDay, register }: WeekProps) {
  const { data, error, reload } = useLoadOn(() => getWeek(period), dayKey(weekStart(period)));
  useRegister(register, reload);
  if (!data) return error ? <LoadError onRetry={reload} /> : <Loading />;

  return (
    <>
      <WeekStrip record={data} onPrev={onPrev} onNext={onNext} onPressDay={onPressDay} />
      {data.summary ? (
        <WeekSummaryCards summary={data.summary} relative={data.relative} onPressDay={onPressDay} />
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

function WeekSummaryCards({ summary: s, relative, onPressDay }: { summary: WeekSummary; relative: string; onPressDay: PressDay }) {
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
        <ScoreBars bars={s.bars} onPressDay={onPressDay} />
        {s.todayPending ? (
          <Text variant="caption" style={styles.note}>
            오늘 기록은 기상 확인 뒤에 더해져요.
          </Text>
        ) : null}
      </Card>
      {/* AI 코칭 글이 없으면(실데이터에서 그 주 일기가 없을 때) 카드를 접음 */}
      {s.coaching ? (
        <Card>
          <Text variant="label" style={styles.label}>
            {relative} AI 코칭
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
      ) : null}
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

type DayProps = {
  day: Date;
  today: Date;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  register: Register;
};

// 일간 — 그날 설정한 알람 · 실제로 일어난 일 (오늘은 마지막 줄이 지금) · 그날 일기 열기. 이전 · 다음 날, 오늘로 돌아가기 (D48)
// 날이 바뀌어도 앞 기록을 둔 채 새로 읽음
function DaySection({ day, today, canNext, onPrev, onNext, onToday, register }: DayProps) {
  const { data, error, reload } = useLoadOn(() => getDay(day), dayKey(day));
  useRegister(register, reload);
  if (!data) return error ? <LoadError onRetry={reload} /> : <Loading />;
  const { month, day: d } = dateParts(data.date);

  return (
    <>
      <CalendarHeader
        title={formatDate(data.date)}
        sub={dayRelative(data.date, today)}
        unit="날"
        onPrev={onPrev}
        onNext={onNext}
        nextDisabled={!canNext}
      />
      {isSameDay(day, today) ? null : (
        <View style={styles.todayRow}>
          <Button small variant="ghost" label="오늘" onPress={onToday} />
        </View>
      )}
      <Card>
        <Text variant="label" style={styles.label}>
          {month}월 {d}일 · 설정한 값
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
          <Timeline items={data.actual.map(toItem)} highlightLast={data.isToday} />
        ) : (
          <Text variant="body" tone="sub">
            {data.isToday ? '아직 기록이 없어요.' : '이 날은 남은 기록이 없어요.'}
          </Text>
        )}
      </Card>
      {/* 그날 일기(A03) — 일기가 없는 날도 열려서 이유를 보여 줌 */}
      {data.isFuture ? null : (
        <Card
          onPress={() => router.push({ pathname: '/journal/[date]', params: { date: dayKey(data.date) } })}
          accessibilityLabel={`${month}월 ${d}일 하루 기록 열기`}
        >
          <View style={styles.between}>
            <View style={styles.grow}>
              <Text variant="small">
                {month}월 {d}일 하루 기록
              </Text>
              <Text variant="bodyStrong" style={styles.cardMain}>
                AI 일기 {data.journalWritten ? '작성됨' : data.isToday ? '아직 없음' : '없음'}
              </Text>
            </View>
            <Text variant="big" tone="sub" weight={400}>
              →
            </Text>
          </View>
        </Card>
      )}
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
  todayRow: { marginBottom: 12 },
});
