// 알람 배경음 3개를 직접 합성해 res/raw에 씀 (#312, 결정 D1 A · Q7)
//   외부 샘플을 쓰지 않음 — 사인 · 사각(홀수 배음 합) 파형에 볼륨 곡선(엔벨로프)만 입혀서 만듦 → 라이선스 문제 없음
//   실행: mobile/에서 `node scripts/make-alarm-sounds.mjs` (결과 wav를 커밋함. 소리를 바꿀 때만 다시 돌림)
//   형식: PCM 16bit · 모노 · 44.1kHz (기존 alarm_siren.wav와 같음). 안드로이드가 isLooping으로 반복해서 틂
//   이음매: 모든 소리가 루프 처음 · 끝이 무음(엔벨로프 0)이라 반복해도 딸깍 소리가 안 남. 쓰고 나서 이 사실도 다시 읽어 확인함
//   출력 이름은 안드로이드 raw 규칙(소문자 · 밑줄) + 앱이 받는 soundKey와 같음: theme_calm · theme_default · theme_urgent
//   볼륨은 파일이 아니라 울림 계획(plan.volumePercent)이 정함. 파일은 소리의 성격만 다르게 함
//
// 파라미터 (초 · Hz)
//   theme_calm    2.0초  낮은 음(G4 392Hz 사인 + 2배음 약하게) · 한 번 울림 1.3초: 0.35초 동안 천천히 커지고 0.65초 동안 사라짐 · 0.7초 쉼 → 느린 반복
//   theme_default 1.0초  기본 비프(A5 880Hz 사인 + 3배음 약하게) · 0.22초 소리 × 2번(0.0 · 0.5초에 시작) · 5ms 켜짐 / 20ms 꺼짐 곡선
//   theme_urgent  1.0초  높은 음(A6 1760Hz 사각파) · 0.09초 소리 × 8번(0.125초마다) · 3ms 켜짐 / 8ms 꺼짐 → 빠른 반복
//   최대 진폭: calm 0.7 · default 0.8 · urgent 0.9 (1.0 = 풀스케일, 클리핑 안 나게 여유를 둠). urgent는 RMS 0.55 이상(옛 사이렌과 같거나 큼)을 쓰고 나서 확인함
//   theme_default(보통)는 폰 기본 알람음을 먼저 틀고 이 파일은 예비 (AlarmProfiles.playsOwnFileFirst) — 파일은 약 theme_calm · 강 theme_urgent만 먼저 틂

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SAMPLE_RATE = 44100;
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'modules', 'alarm-core', 'android', 'src', 'main', 'res', 'raw');

// 사각파 = 홀수 배음의 합 (1/n 크기). 나이퀴스트 아래 배음만 더해 소리가 지글거리지(에일리어싱) 않게 함
function squareWave(freq, t, maxHarmonic = 9) {
  let sum = 0;
  for (let n = 1; n <= maxHarmonic; n += 2) {
    if (freq * n >= SAMPLE_RATE / 2) break;
    sum += Math.sin(2 * Math.PI * freq * n * t) / n;
  }
  return sum * (4 / Math.PI);
}

// 선형 켜짐 / 꺼짐 곡선. 소리 길이 dur 안에서 처음 attack초 동안 0→1, 마지막 release초 동안 1→0
function ramp(t, dur, attack, release) {
  if (t < 0 || t >= dur) return 0;
  if (t < attack) return t / attack;
  if (t > dur - release) return (dur - t) / release;
  return 1;
}

// 부드러운 곡선(사인 제곱) — 선형보다 시작 · 끝이 덜 날카로움
function softRamp(t, dur, attack, release) {
  const v = ramp(t, dur, attack, release);
  return Math.sin((v * Math.PI) / 2) ** 2;
}

const SOUNDS = {
  // 약: 낮고 부드럽게 시작해서 천천히 반복
  theme_calm: {
    seconds: 2.0,
    peak: 0.7,
    sample: (t) => {
      const env = softRamp(t, 1.3, 0.35, 0.65);
      return env * (Math.sin(2 * Math.PI * 392 * t) + 0.25 * Math.sin(2 * Math.PI * 784 * t));
    },
  },
  // 보통: 기본 비프 두 번 → 쉼
  theme_default: {
    seconds: 1.0,
    peak: 0.8,
    sample: (t) => {
      const beep = (start) => {
        const local = t - start;
        const env = ramp(local, 0.22, 0.005, 0.02);
        return env * (Math.sin(2 * Math.PI * 880 * local) + 0.2 * Math.sin(2 * Math.PI * 2640 * local));
      };
      return beep(0) + beep(0.5);
    },
  },
  // 강: 높은 음을 짧게 여덟 번 빠르게
  theme_urgent: {
    seconds: 1.0,
    peak: 0.9, // 옛 사이렌(alarm_siren.wav, 피크 0.9 · RMS 0.55)보다 작지 않게 (지형님 10/30). 아래 minRms로 확인
    minRms: 0.55,
    sample: (t) => {
      const index = Math.floor(t / 0.125);
      const local = t - index * 0.125;
      return ramp(local, 0.09, 0.003, 0.008) * squareWave(1760, local);
    },
  },
};

function render({ seconds, peak, sample }) {
  const count = Math.round(seconds * SAMPLE_RATE);
  const values = new Float64Array(count);
  let max = 0;
  for (let i = 0; i < count; i += 1) {
    values[i] = sample(i / SAMPLE_RATE);
    max = Math.max(max, Math.abs(values[i]));
  }
  // 가장 큰 값이 peak가 되도록 맞춤 (클리핑 방지)
  const scale = max > 0 ? peak / max : 0;
  const pcm = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i += 1) {
    pcm.writeInt16LE(Math.round(values[i] * scale * 32767), i * 2);
  }
  return pcm;
}

// 44바이트 WAV 머리말 + PCM (16bit 모노)
function wav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 모노
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28); // 초당 바이트
  header.writeUInt16LE(2, 32); // 샘플 한 칸 바이트
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// 쓴 파일을 다시 읽어 형식 · 길이 · 피크 · 이음매(처음 · 끝 샘플)를 확인함. 어긋나면 실패
function verify(name, file, expected) {
  const buf = readFileSync(file);
  const fail = (why) => {
    throw new Error(`${name}: ${why}`);
  };
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') fail('RIFF/WAVE 머리말이 아님');
  if (buf.readUInt16LE(20) !== 1) fail('PCM이 아님');
  if (buf.readUInt16LE(22) !== 1) fail('모노가 아님');
  if (buf.readUInt32LE(24) !== SAMPLE_RATE) fail('44.1kHz가 아님');
  if (buf.readUInt16LE(34) !== 16) fail('16bit가 아님');
  const dataBytes = buf.readUInt32LE(40);
  if (dataBytes !== buf.length - 44) fail('data 길이가 파일과 안 맞음');
  const count = dataBytes / 2;
  let peak = 0;
  let clipped = 0;
  let squares = 0;
  for (let i = 0; i < count; i += 1) {
    const raw = buf.readInt16LE(44 + i * 2);
    const v = Math.abs(raw);
    if (v > peak) peak = v;
    if (v >= 32767) clipped += 1;
    squares += (raw / 32768) ** 2;
  }
  const rms = Math.sqrt(squares / count);
  const first = buf.readInt16LE(44);
  const last = buf.readInt16LE(44 + (count - 1) * 2);
  const seconds = count / SAMPLE_RATE;
  if (Math.abs(seconds - expected.seconds) > 0.001) fail(`길이 ${seconds}초 (기대 ${expected.seconds}초)`);
  if (peak / 32768 > expected.peak + 0.01) fail(`피크 ${peak / 32768}가 ${expected.peak}를 넘음`);
  if (expected.minRms != null && rms < expected.minRms) fail(`RMS ${rms.toFixed(3)}가 ${expected.minRms}보다 작음 (옛 사이렌보다 작으면 안 됨)`);
  if (clipped > 0) fail(`클리핑 ${clipped}개`);
  if (first !== 0 || last !== 0) fail(`이음매가 무음이 아님 (처음 ${first} · 끝 ${last})`);
  console.log(`${name}.wav  ${seconds.toFixed(2)}초  ${SAMPLE_RATE}Hz 모노 16bit  피크 ${(peak / 32768).toFixed(3)}  RMS ${rms.toFixed(3)}  ${buf.length}바이트  처음/끝 샘플 ${first}/${last}`);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, spec] of Object.entries(SOUNDS)) {
  const file = join(OUT_DIR, `${name}.wav`);
  writeFileSync(file, wav(render(spec)));
  verify(name, file, spec);
}
