import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button, Card, LoadError, Loading, SectionHeader, Segmented, Text, Timeline, toast, type TimelineItem } from '@/components/ui';
import { TextLink } from '@/features/alarm/components/TextLink';
import { dayRelative } from '@/features/records/calendar';
import { CalendarHeader } from '@/features/records/components/CalendarHeader';
import { MonthCalendar } from '@/features/records/components/MonthCalendar';
import { ScoreBars } from '@/features/records/components/ScoreBars';
import { WeekStrip } from '@/features/records/components/WeekStrip';
import { useDayRecord, useMonthRecord, useRecordToday, useWeekRecord } from '@/features/records/hooks/useRecords';
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
import { useAccent } from '@/lib/skyTone';
import { colors } from '@/theme';

const VIEWS = [
  ['month', '월간'],
  ['week', '주간'],
  ['day', '일간'],
] as const;

const toItem = (row: TimelineRow): TimelineItem => ({ time: formatTime(row.at), label: row.label, source: row.source, past: row.past });

// 당겨서 새로고침 — 보이는 구역(월간 · 주간 · 일간)이 자기 다시 읽기를 홈에 맡겨 둠
export type Register = (reload: (() => Promise<unknown>) | null) => void;

// 달력 · 주간 줄의 날짜 · 주간 막대를 눌렀을 때 — MonthDay · WeekDay · WeekBar가 모두 맞음
type PressDay = (d: { date: Date; isFuture: boolean }) => void;

// R02 나의 기록 — 월간 달력 · 주간 기상 흐름 · 일간(설정한 값과 실제로 일어난 일)
// 홈에서는 접힌 요약(이번 주 날짜 줄 · 평균 기상 · 목표 기상률 · AI 코칭 한 카드)만 보이고, "자세히"를 누르면 그 자리에서 월간 · 주간 · 일간이 펴짐
// 기록 탭이 없어지고 홈(H01) 맨 아래에 붙음 (D110). 당겨서 새로고침은 홈이 register로 받은 다시 읽기를 같이 부름
// 읽기는 features/records/hooks/useRecords (부품은 api.ts를 직접 부르지 않음 — CLAUDE.md 화면 절)
// 화살표로 앞뒤 달 · 주 · 날을 넘기고, 달력 · 주간 줄의 날짜 · 주간 막대를 누르면 그 날의 일간으로 (D48). 일정 추가 · 상세는 src/app/schedule/
// 보던 달 · 주(period)와 일간으로 보는 날(day)은 따로 — 일간에서 날을 넘겨도 월간 · 주간은 보던 그대로 (규칙은 features/records/navigation.ts)
export function RecordsSection({ register }: { register: Register }) {
  const today = useRecordToday();
  const [nav, setNav] = useState(() => initialNav(today));
  const [open, setOpen] = useState(false); // 접힘 = 이번 주 요약 한 카드

  // 월간 · 주간의 날짜 · 주간 막대 → 그 날의 일간. 아직 오지 않은 날은 남은 기록이 없어 열지 않음
  const pressDay: PressDay = (d) => {
    if (d.isFuture) toast('아직 오지 않은 날이에요');
    else setNav((n) => openDay(n, d.date));
  };

  return (
    <>
      <SectionHeader title="나의 기록" right={<TextLink label={open ? '접기' : '자세히 ›'} onPress={() => setOpen((v) => !v)} />} />
      {open ? null : <WeekDigest today={today} onPressDay={(d) => { pressDay(d); if (!d.isFuture) setOpen(true); }} register={register} />}
      {open ? (
      <>
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
      </>
      ) : null}
    </>
  );
}

// 접힌 요약 — 이번 주 한 카드: 날짜 줄(기록 있는 날 점) · 평균 기상 · 목표 기상률 · AI 코칭 한 문단 + 루틴 만들기
function WeekDigest({ today, onPressDay, register }: { today: Date; onPressDay: PressDay; register: Register }) {
  const accent = useAccent(); // 오늘 날짜 · 기록 점 — 포인트 색 (lib/skyTone)
  const { data, error, reload, emptyText } = useWeekRecord(today);
  useRegister(register, reload);
  if (!data) return error ? <LoadError onRetry={reload} /> : <Loading />;
  const s = data.summary;

  return (
    <Card>
      <View style={styles.digestWeek}>
        {data.strip.map((d) => (
          <Pressable
            key={d.day}
            onPress={() => onPressDay(d)}
            style={({ pressed }) => [styles.digestCell, pressed && styles.digestPressed]}
            accessibilityRole="button"
            accessibilityLabel={`${d.weekday}요일 ${d.day}일${d.isToday ? ' 오늘' : ''}${d.isFuture ? ' 아직 오지 않은 날' : ''}${d.recorded ? ' 기록 있음' : ''}`}
          >
            <Text variant="caption" tone="sub">
              {d.weekday}
            </Text>
            <View style={[styles.digestDay, d.isToday && { backgroundColor: accent }]}>
              <Text variant="small" tone={d.isToday ? 'inverse' : d.isFuture ? 'faint' : 'ink'} weight={600}>
                {d.day}
              </Text>
            </View>
            <View style={[styles.digestDot, d.recorded && { backgroundColor: accent }]} />
          </Pressable>
        ))}
      </View>
      {s ? (
        <>
          <View style={styles.digestStats}>
            <View style={styles.digestStat}>
              <Text variant="label">평균 기상</Text>
              <Text variant="section">{timeParts(s.averageWake).hm}</Text>
              <Text variant="caption">{s.averageText}</Text>
            </View>
            <View style={styles.digestStat}>
              <Text variant="label">목표 기상률</Text>
              <Text variant="section">{`${s.goalRate}%`}</Text>
              <Text variant="caption">{s.goalText}</Text>
            </View>
          </View>
          {/* AI 코칭 글이 없으면(실데이터에서 그 주 일기가 없을 때) 이 칸을 접음 */}
          {s.coaching ? (
            <View style={styles.digestCoach}>
              <Text variant="label">{data.relative} AI 코칭</Text>
              <Text variant="body">{s.coaching}</Text>
              <View style={styles.digestLink}>
                <TextLink label="루틴 만들기 ›" onPress={() => router.push({ pathname: '/routine/[id]', params: { id: 'new', journal: dayKey(today) } })} strong />
              </View>
            </View>
          ) : null}
        </>
      ) : (
        <Text variant="body" tone="sub" style={styles.digestEmpty}>
          {emptyText}
        </Text>
      )}
    </Card>
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
  const { data, error, reload } = useMonthRecord(year, month);
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
  const { data, error, reload, emptyText } = useWeekRecord(period);
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
            {emptyText}
          </Text>
        </Card>
      )}
    </>
  );
}

function WeekSummaryCards({ summary: s, relative, onPressDay }: { summary: WeekSummary; relative: string; onPressDay: PressDay }) {
  const today = useRecordToday();
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
              onPress={() => router.push({ pathname: '/routine/[id]', params: { id: 'new', journal: dayKey(today) } })}
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
  const { data, error, reload } = useDayRecord(day);
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
  digestWeek: { flexDirection: 'row', justifyContent: 'space-between' },
  digestCell: { flex: 1, alignItems: 'center', gap: 4, minHeight: 44 },
  digestPressed: { opacity: 0.6 },
  digestDay: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  digestDot: { width: 4, height: 4, borderRadius: 2 },
  digestStats: { flexDirection: 'row', marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.line },
  digestStat: { flex: 1, gap: 1 },
  digestCoach: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.line, gap: 4 },
  digestLink: { alignItems: 'flex-start', marginTop: 4 },
  digestEmpty: { marginTop: 12 },
});
