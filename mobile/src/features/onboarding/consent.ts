// 개인정보 안내 문구 — 온보딩 동의 단계(views/ConsentStep)가 그림
// D93 기본안 A — 온보딩 1장 + 판 번호, 문구 초안은 L7, 확정은 팀. 문구를 고쳐 다시 동의받아야 하면 PRIVACY_VERSION을 올림
export const PRIVACY_VERSION = 1;

export type ConsentItem = {
  key: 'location' | 'screen' | 'voice' | 'wake-share';
  title: string;
  reads: string; // 읽는 것
  doesNotRead: string; // 안 읽는 것
  friends: string; // 친구에게 보이는 것
};

export const CONSENT_ITEMS: readonly ConsentItem[] = [
  {
    key: 'location',
    title: '위치',
    reads: '집을 나서고 목적지에 도착한 시각',
    doesNotRead: '이동 경로, 위치 기록',
    friends: '안 보임',
  },
  {
    key: 'screen',
    title: '화면 사용',
    reads: '알람을 끈 뒤 화면이 켜지고 잠금이 풀린 시각',
    doesNotRead: '어떤 앱을 쓰는지',
    friends: '안 보임',
  },
  {
    key: 'voice',
    title: '음성',
    reads: 'AI 대화 중 말한 내용(글로 바꿔 처리)',
    doesNotRead: '대화 밖의 소리, 음성 원본(저장하지 않음)',
    friends: '안 보임',
  },
  {
    key: 'wake-share',
    title: '기상 공유',
    reads: '알람 해제와 기상 확인 상태',
    doesNotRead: '수면 시간, 위치',
    friends: '그룹에서 허락한 사람에게만 기상 단계가 보임',
  },
];
