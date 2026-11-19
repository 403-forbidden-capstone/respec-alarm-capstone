// 해석 결과(GeoAction) 적용 — 상태와 함께 쓸 기록을 보관함에 먼저 남기고, 서버에 쓰고, 못 쓴 것은 보관해 둔 채 다음에 다시
//   · 쓸 기록(DEPART · ARRIVE)은 상태를 저장할 때 같이 보관함(location:v1:actions)에 올림 → 앱이 중간에 꺼져도 상태만 앞서 나가 기록이 사라지는 일이 없음
//   · flushActions가 보관함 앞에서부터 차례로 서버에 씀: 성공하면 뺌, 일시 오류(네트워크 · 로그인 없음 · 5xx)는 거기서 멈추고 다음에,
//     다시 해도 소용없는 오류(lib/alarmSync/events isPermanentInsertError)는 버림. 쓰기는 같은 입력이면 같은 결과라 두 번 가도 안전 (participantTimes)
//   · 안내만 하는 것(DEPART_PENDING · DEPART_CANCEL)은 보관하지 않고 notice.ts를 바로 부름
//   · 도착(ARRIVE) 안내는 서버에 쓴 뒤에 부름 — 못 쓴 채 "도착 감지"만 뜨지 않게 (출발 안내는 이탈 순간 DEPART_PENDING에서 이미 나감)
import { recordParticipantTimes } from '@/features/alarm/participantTimes';
import { isPermanentInsertError } from '@/lib/alarmSync/events';
import { now } from '@/lib/clock';
import { isMock } from '@/lib/mode';

import { minutesMs } from './constants';
import { withLock } from './lock';
import { errorText } from './native';
import { onDetectionNotice } from './notice';
import { settlePhoneAlarms } from './settleAlarms';
import { commit, isWriteAction, loadActions, MAX_QUEUED_ACTIONS, type Change, type WriteAction } from './store';
import type { GeoAction, StepResult } from './transitions';

// 줄(withLock) 안에서 부름 — 해석 결과의 상태와 쓸 기록을 한 번에 저장하고, 안내만 하는 것을 돌려줌 (줄 밖에서 announce)
//   more = 같이 저장할 계획 · 등록 목록 (register.ts)
export async function commitStep(result: StepResult, more: Pick<Change, 'plan' | 'regions'> = {}): Promise<GeoAction[]> {
  await commit({ ...more, state: result.state, append: result.actions.filter(isWriteAction) });
  return result.actions.filter((action) => !isWriteAction(action));
}

// 안내 알림 부르기 — 안내 실패가 기록을 막지 않게 삼킴
export function announce(notices: readonly GeoAction[]): void {
  for (const action of notices) {
    try {
      onDetectionNotice(action);
    } catch (e) {
      if (__DEV__) console.warn('[location] 감지 안내 실패', errorText(e));
    }
  }
}

type Outcome = 'done' | 'drop' | 'retry';

// 도착 안내는 감지 뒤 이만큼(분) 안에 쓴 것만 — 오프라인 보관함에서 한참 뒤에 쓰인 도착은 이미 지난 일이라 알리지 않음 (근거 없음 — 작성자 판단)
const ARRIVE_NOTICE_MAX_DELAY_MINUTES = 60;

// wrote = 서버에 출발 · 도착을 실제로 썼음(새로 쓰거나 바꿈). 이른 위치 출발이라 건너뜀 · 창 밖 · 이미 응답 값이 있어 그대로 둠(keep) · 참여 조건 없음이면 false
async function send(action: WriteAction): Promise<{ outcome: Outcome; wrote: boolean }> {
  try {
    const result =
      action.type === 'DEPART'
        ? await recordParticipantTimes({ participantId: action.participantId, departedAt: action.at, source: 'LOCATION' })
        : await recordParticipantTimes({ participantId: action.participantId, arrivedAt: action.at, source: 'LOCATION' });
    const decision = action.type === 'DEPART' ? result?.departed : result?.arrived;
    return { outcome: 'done', wrote: decision === 'new' || decision === 'override' };
  } catch (e) {
    if (isPermanentInsertError(e as { code?: string | null })) {
      if (__DEV__) console.warn('[location] 다시 해도 소용없는 오류라 기록을 버림', action.type, errorText(e));
      return { outcome: 'drop', wrote: false };
    }
    if (__DEV__) console.warn('[location] 기록을 못 써서 보관해 둠 — 다음에 다시', action.type, errorText(e));
    return { outcome: 'retry', wrote: false };
  }
}

// 맨 앞 기록이 방금 보낸 그것이면 뺌 (그 사이 로그아웃으로 비워졌거나 달라졌으면 그대로 둠)
async function dropHead(sent: WriteAction): Promise<void> {
  const [head, ...rest] = await loadActions();
  if (head && head.type === sent.type && head.participantId === sent.participantId && head.at === sent.at) await commit({ actions: rest });
}

async function flushPass(): Promise<void> {
  if (isMock()) return;
  try {
    // 보내다 앞에서 막히면(일시 오류) 순서가 뒤바뀌지 않게 거기서 멈춤. 반복 상한은 무한 반복 방지용
    for (let i = 0; i < MAX_QUEUED_ACTIONS * 2; i += 1) {
      const [head] = await withLock(loadActions);
      if (!head) return;
      const { outcome, wrote } = await send(head);
      if (outcome === 'retry') return;
      // 쓰기에 성공한 도착만 안내 — 버린 것(drop)은 서버에 없음. 보내고 보관함에서 빼기 전에 앱이 꺼져 다시 보내도 알림 번호가 같아 한 장으로 덮어씀
      if (outcome === 'done' && head.type === 'ARRIVE' && now().getTime() - head.at <= minutesMs(ARRIVE_NOTICE_MAX_DELAY_MINUTES)) announce([head]);
      // 서버에 실제로 쓴 경우에만(이른 위치 출발 · 창 밖 · 이미 응답 값이 있어 안 쓴 경우는 알람을 그대로 둠) 그 약속의 남은 준비 · 출발(· 도착) 알람을 폰에서 바로 정리 — 이미 나섰는데 "곧 출발하세요"가, 이미 도착했는데 "도착했어요?"가 울리지 않게 (G3). 못 지워도 기록은 그대로
      if (wrote) await settlePhoneAlarms(head.participantId, head.type);
      await withLock(() => dropHead(head));
    }
  } catch (e) {
    if (__DEV__) console.warn('[location] 못 쓴 기록 보내기 중단', errorText(e));
  }
}

// 보관함에 못 쓴 기록을 서버에 씀 — 던지지 않음. 쓰는 동안은 줄(withLock)을 잡지 않음 (네트워크가 늦어도 신호 해석이 막히지 않게)
//   여러 곳에서 겹쳐 불러도 한 번에 하나씩 (같은 기록을 동시에 두 번 보내지 않게)
let flushTail: Promise<unknown> = Promise.resolve();
export function flushActions(): Promise<void> {
  const run = flushTail.then(flushPass, flushPass);
  flushTail = run.catch(() => {});
  return run;
}
