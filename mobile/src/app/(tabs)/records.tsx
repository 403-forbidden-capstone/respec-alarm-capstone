import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Card, Screen, Segmented, Text, Timeline, toast, TopBar, type TimelineItem } from '@/components/ui';
import { getDay, getMonth, getWeek } from '@/features/records/api';
import { shiftMonth, weekStart } from '@/features/records/calendar';
import { MonthCalendar } from '@/features/records/components/MonthCalendar';
import { ScoreBars } from '@/features/records/components/ScoreBars';
import { WeekStrip } from '@/features/records/components/WeekStrip';
import type { MonthDay, TimelineRow, WeekSummary } from '@/features/records/types';
import { now } from '@/lib/clock';
import { addDays, dateParts, dayKey, formatTime, timeParts } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';

type RecordView = 'month' | 'week' | 'day';

const VIEWS = [
  ['month', '월간'],
  ['week', '주간'],
  ['day', '일간'],
] as const;

const toItem = (row: TimelineRow): TimelineItem => ({ time: formatTime(row.at), label: row.label, source: row.source, past: row.past });

// 04 기록 탭 · R02 나의 기록 — 월간 달력 · 주간 기상 흐름 · 일간(설정한 값과 실제로 일어난 일)
// 화살표로 앞뒤 달 · 주를 넘기고, 달력에서 오늘을 누르면 일간으로. 일정 추가 · 상세는 src/app/schedule/
export default function RecordsScreen() {
  const [view, setView] = useState<RecordView>('week'); // 목업 첫 화면은 주간
  const [month, setMonth] = useState(() => {
    const { year, month } = dateParts(now());
    return { year, month };
  });
  const [week, setWeek] = useState(() => weekStart(now()));

  // 목업은 오늘만 일간 기록이 있음 — 실데이터(#41)가 붙으면 기록 있는 날 모두 열리게
  function pressDay(d: MonthDay) {
    if (d.isToday) setView('day');
    else if (d.isFuture) toast('아직 오지 않은 날이에요');
    else toast(`${dateParts(d.date).month}월 ${d.day}일 기록은 이번 목업에 없어요`);
  }

  return (
    <Screen>
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
            key={`${month.year}-${month.month}`}
            year={month.year}
            month={month.month}
            onPrev={() => setMonth((m) => shiftMonth(m.year, m.month, -1))}
            onNext={() => setMonth((m) => shiftMonth(m.year, m.month, 1))}
            onPressDay={pressDay}
            onOpenToday={() => setView('day')}
          />
        ) : view === 'week' ? (
          <WeekSection
            key={dayKey(week)}
            anyDay={week}
            onPrev={() => setWeek((w) => addDays(w, -7))}
            onNext={() => setWeek((w) => addDays(w, 7))}
          />
        ) : (
          <DaySection />
        )}
      </View>
    </Screen>
  );
}

type MonthProps = {
  year: number;
  month: number;
  onPrev: () => void;
  onNext: () => void;
  onPressDay: (d: MonthDay) => void;
  onOpenToday: () => void;
};

// 월간 — 달력 + 오늘 기록 카드. 달이 바뀌면 key가 바뀌어 새로 읽음
function MonthSection({ year, month, onPrev, onNext, onPressDay, onOpenToday }: MonthProps) {
  const { data } = useLoad(() => getMonth(year, month));
  if (!data) return null;
  const today = dateParts(data.today.date);

  return (
    <>
      <MonthCalendar record={data} onPrev={onPrev} onNext={onNext} onPressDay={onPressDay} />
      {/* 목업은 A03 하루 기록(#48)으로 감 — 그 화면이 생기기 전까지는 오늘 일간 기록으로 */}
      <Card onPress={onOpenToday}>
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
    </>
  );
}

// 주간 — 날짜 줄 + 평균 기상 · 목표 기상률 · 날마다 실행 점수 · AI 코칭. 주가 바뀌면 key가 바뀌어 새로 읽음
function WeekSection({ anyDay, onPrev, onNext }: { anyDay: Date; onPrev: () => void; onNext: () => void }) {
  const { data } = useLoad(() => getWeek(anyDay));
  if (!data) return null;

  return (
    <>
      <WeekStrip record={data} onPrev={onPrev} onNext={onNext} />
      {data.summary ? (
        <WeekSummaryCards summary={data.summary} />
      ) : (
        <Card>
          <Text variant="body" tone="sub">
            이 주에는 기록이 없어요.
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

// 일간 — 그날 설정한 알람 · 실제로 일어난 일 (마지막 줄이 지금)
function DaySection() {
  const { data } = useLoad(() => getDay(now()));
  if (!data) return null;
  const { month, day } = dateParts(data.date);

  return (
    <>
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
});
