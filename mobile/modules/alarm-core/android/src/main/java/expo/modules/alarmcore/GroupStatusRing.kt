package expo.modules.alarmcore

/**
 * 기상 알람 한 울림 회차(알람 id + 울림 번호, key)의 그룹 상태 안내 기록 — 서버 호출 횟수를 여기서만 정함 (안드로이드 API 없이 JVM 시험: GroupStatusRingTest)
 *   조회는 회차마다 1번 (첫 조회에 그때 단계의 음성 생성도 같이 → 그 단계는 요청한 것으로 셈). 실패 · 시간 초과면 문장이 없어 이 회차엔 더 부르지 않음
 *   음성 생성(3 · 4단계 Gemini)은 단계마다 1번 — 결과가 실패여도 같은 단계는 다시 안 부르고 Android TTS로. 1 · 2단계는 폰 Android TTS라 서버를 안 부름
 *   안내는 회차마다 1번 (읽은 뒤에는 단계가 바뀌어도 음성을 새로 만들지 않음). 새 회차(미루기 뒤 다시 울림)는 새 기록
 *   audio 값 = 그 단계 음성 파일 경로, null = 생성 실패 · 음성 없음(Android TTS로)
 */
internal class GroupStatusRing(val key: String) {
  var text: String? = null
    private set
  var token: String? = null
    private set
  var played = false
    private set
  private var queried = false
  private val requested = mutableSetOf<Int>()
  private val audio = mutableMapOf<Int, String?>()

  /** 지금 조회할지 — 회차마다 처음 한 번만 true */
  fun startQuery(level: Int): Boolean {
    if (queried) return false
    queried = true
    if (level >= 3) requested += level
    return true
  }

  /** 조회 결과 (실패면 text = null → 이 회차는 안내 없음, 더 부르지 않음). level = 조회 때 보낸 단계 */
  fun onQuery(text: String?, token: String?, level: Int, audioPath: String?) {
    this.text = text?.takeIf { it.isNotBlank() }
    this.token = token
    if (level in requested) audio[level] = audioPath
  }

  /** 이 단계 음성을 서버에 따로 만들어 달라고 할지 — 문장이 있고 · 아직 안 읽었고 · 3 · 4단계이고 · 이 회차에 그 단계를 처음 요청할 때만 */
  fun startAudio(level: Int): Boolean {
    if (text == null || token == null || played || level < 3 || level in requested) return false
    requested += level
    return true
  }

  /** 음성 생성 결과 (실패면 null — 같은 단계는 다시 안 부름) */
  fun onAudio(level: Int, audioPath: String?) {
    if (level in requested) audio[level] = audioPath
  }

  /** 지금 단계로 읽을 수 있는지 — 문장이 있고 안 읽었고, 그 단계 음성을 요청했으면 결과(성공 · 실패)가 나온 뒤 */
  fun ready(level: Int): Boolean = text != null && !played && (level !in requested || level in audio)

  /** 이 단계의 음성 파일 — 다른 단계 것은 주지 않음(앞 단계 음성을 잘못 틀지 않게) */
  fun audioFor(level: Int): String? = audio[level]

  fun markPlayed() {
    played = true
  }
}
