package expo.modules.alarmcore

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale

// 브리핑 재생 — 기상·출발은 사용자가 해제하기 전까지 같은 음성을 로컬에서 반복 (네트워크·Gemini 재호출 없음)
//   3 · 4단계: 개인화 Gemini 캐시 → 앱에 든 그 단계 예비 WAV → 폰의 Android TTS로 같은 문장 전체 (MediaPlayer, 앞 것이 못 열리거나 재생 중 오류면 다음 것)
//   알람 볼륨 스트림(USAGE_ALARM)으로 읽음. 볼륨 크기 자체는 알람 계획 · 폰 설정이 정함
//   onStart · onDone은 메인 스레드에서 부름 (기상 알람음을 줄였다 되돌리는 데 씀). 어떤 실패든 onDone으로 끝남 — 알람은 멈추지 않음
//   holdAtNextBoundary · resume: 기상 알람 그룹 상태 안내를 끼울 때 — Android TTS는 지금 문장 끝, WAV는 지금 바퀴(파일) 끝, 쉬는 중이면 바로 멈췄다가 이어 읽음
internal class BriefingSpeaker(
  private val context: Context,
  private val onStart: () -> Unit,
  private val onDone: () -> Unit,
) {
  companion object {
    private const val TAG = "AlarmCore"
    private const val UTTERANCE = "alarm_briefing"
    // TTS 엔진이 켜지거나 말을 시작하기까지 기다리는 최대 시간 — 넘으면 브리핑 없이 알람음만 (작성자 판단)
    private const val INIT_TIMEOUT_MILLIS = 8_000L
    private const val START_TIMEOUT_MILLIS = 8_000L
    private const val REPEAT_PAUSE_MILLIS = 1_500L

    // 마지막 재생 상태 한 줄 (개발 화면 표시용 — 판단에는 안 씀)
    @Volatile
    var lastStatus: String? = null

    // 마지막으로 실제 소리를 낸 출처 (BriefingRules.source 값: GEMINI_CACHE · GEMINI_FALLBACK · ANDROID · ANDROID_FALLBACK) — 개발 화면 표시용
    @Volatile
    var lastSource: String? = null
  }

  private val handler = Handler(Looper.getMainLooper())
  private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
  private var player: MediaPlayer? = null
  private var tts: TextToSpeech? = null
  private var finished = false
  private var repeating = false
  private var currentSpeech: VoiceBriefing.Speech? = null
  // Android TTS는 문장마다 따로 읽음 — 문장 사이에 그룹 상태 안내를 끼울 수 있게 (BriefingRules.sentences)
  private var sentences: List<String> = emptyList()
  private var sentenceIndex = 0
  // 한 바퀴를 다 읽고 다시 읽기 전 쉬는 중
  private var pausing = false
  // 다음 경계에서 멈추고 부를 것 (holdAtNextBoundary). 부르면 비움
  private var onHold: (() -> Unit)? = null
  private val repeatSpeech = Runnable {
    pausing = false
    val engine = tts
    val speech = currentSpeech
    if (!finished && engine != null && speech != null) speakUtterance(engine, speech)
  }
  private val initTimeout = Runnable {
    Log.w(TAG, "Android TTS가 켜지지 않음 — 알람음만")
    lastStatus = "Android TTS가 켜지지 않음 — 알람음만"
    finish()
  }
  private val startTimeout = Runnable {
    Log.w(TAG, "Android TTS가 말을 시작하지 않음 — 알람음만")
    lastStatus = "Android TTS가 말을 시작하지 않음 — 알람음만"
    finish()
  }

  private data class WavSource(val source: String, val label: String, val uri: Uri)

  private var wavSources: List<WavSource> = emptyList()

  fun speak(speech: VoiceBriefing.Speech, repeat: Boolean = false) {
    repeating = repeat
    currentSpeech = speech
    lastStatus = "음성 준비 중"
    wavSources = listOfNotNull(
      speech.wav?.let { WavSource("GEMINI_CACHE", "개인화 Gemini 캐시", Uri.fromFile(it)) },
      speech.bundled?.let { WavSource("GEMINI_FALLBACK", "Gemini 기본 예비 음성", Uri.parse("android.resource://${context.packageName}/$it")) },
    )
    playFrom(speech, 0)
  }

  // index번째 WAV부터 차례로 — 다 못 틀면 Android TTS로 같은 단계 문장
  private fun playFrom(speech: VoiceBriefing.Speech, index: Int) {
    for (i in index until wavSources.size) if (playWav(speech, i)) return
    speakAndroid(speech)
  }

  private fun playWav(speech: VoiceBriefing.Speech, index: Int): Boolean {
    val src = wavSources[index]
    val p = MediaPlayer()
    return try {
      p.setAudioAttributes(attributes)
      p.setDataSource(context, src.uri)
      p.prepare()
      p.isLooping = repeating
      // 반복 중에는 끝나지 않음(isLooping) — 끼울 안내가 있으면 holdAtNextBoundary가 반복을 풀어 이번 바퀴 끝에서 여기로 옴
      p.setOnCompletionListener { if (!hold()) finish() }
      p.setOnErrorListener { _, what, extra ->
        // 재생 도중 오류 — 다음 출처로 (예비 WAV → Android TTS). 알람음 · 진동은 그대로
        Log.w(TAG, "${src.label} 재생 오류($what/$extra) — 다음 출처로")
        releasePlayer()
        if (!finished) playFrom(speech, index + 1)
        true
      }
      player = p
      onStart()
      p.start()
      // 재생 속도만 바꾸고 높낮이는 그대로 (PlaybackParams, API 23+). 못 바꿔도 원래 속도로 계속
      if (speech.speed != 1f) runCatching { p.playbackParams = p.playbackParams.setSpeed(speech.speed).setPitch(1f) }.onFailure { Log.w(TAG, "재생 속도를 못 바꿈", it) }
      Log.i(TAG, "브리핑: ${src.label} ${speech.level}단계 ${speech.speed}배")
      lastSource = src.source
      lastStatus = "${src.label} ${speech.level}단계 재생 중 · ${speech.speed}배${if (repeating) " (반복)" else ""}"
      true
    } catch (e: Exception) {
      // 파일이 깨졌거나 없음 — 다음 출처로 (아직 아무것도 안 읽었으니 엔진이 섞이지 않음)
      Log.w(TAG, "${src.label}을 못 틀어 다음 출처로", e)
      lastStatus = "${src.label}을 못 틀어 다음으로 대체"
      runCatching { p.release() }
      player = null
      false
    }
  }

  private fun releasePlayer() {
    player?.let { p ->
      runCatching { if (p.isPlaying) p.stop() }
      runCatching { p.release() }
    }
    player = null
  }

  private fun speakAndroid(speech: VoiceBriefing.Speech) {
    handler.postDelayed(initTimeout, INIT_TIMEOUT_MILLIS)
    tts = TextToSpeech(context.applicationContext) { status ->
      handler.post {
        handler.removeCallbacks(initTimeout)
        val engine = tts
        if (finished || engine == null) return@post
        if (status != TextToSpeech.SUCCESS) {
          Log.w(TAG, "Android TTS를 못 켬 — 알람음만")
          lastStatus = "Android TTS를 못 켬 — 알람음만"
          finish()
          return@post
        }
        runCatching {
          // 오프라인 한국어만: 데이터가 없거나 인터넷이 필요한 목소리뿐이면 읽지 않음(알람음 · 진동은 그대로). 하나뿐이면 높낮이 · 속도로만 달라짐
          val all = engine.voices.orEmpty()
          val infos = all.map { BriefingRules.VoiceInfo(it.name, it.locale.language, it.isNetworkConnectionRequired) }
          when (val choice = BriefingRules.offlineVoice(engine.setLanguage(Locale.KOREAN), infos, speech.voiceIndex)) {
            is BriefingRules.VoiceChoice.Skip -> {
              Log.w(TAG, "Android TTS 안 씀(${choice.reason}) — 알람음만")
              lastStatus = "Android TTS 안 씀(${choice.reason}) — 알람음만"
              finish()
              return@post
            }
            is BriefingRules.VoiceChoice.Use -> all.firstOrNull { it.name == choice.name }?.let { engine.setVoice(it) }
            BriefingRules.VoiceChoice.EngineDefault -> Unit
          }
          engine.setPitch(speech.pitch)
          engine.setSpeechRate(speech.rate)
          engine.setAudioAttributes(attributes)
          engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {
              handler.post {
                handler.removeCallbacks(startTimeout)
                if (!finished) onStart()
              }
            }

            override fun onDone(utteranceId: String?) {
              handler.post {
                handler.removeCallbacks(startTimeout)
                val current = tts
                if (finished || current == null) return@post
                sentenceIndex += 1
                // 문장 사이 — 끼울 안내가 있으면 여기서 멈춤(다음 문장은 resume에서)
                if (sentenceIndex < sentences.size) {
                  if (!hold()) speakUtterance(current, speech)
                  return@post
                }
                sentenceIndex = 0
                lastStatus = if (repeating) "다 읽음 — 해제 전까지 다시 읽음" else "다 읽음 (한 번으로 끝)"
                if (!repeating) finish()
                else if (!hold()) {
                  pausing = true
                  handler.postDelayed(repeatSpeech, REPEAT_PAUSE_MILLIS)
                }
              }
            }

            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
              handler.post {
                lastStatus = "Android TTS 읽기 오류 — 알람음만"
                finish()
              }
            }
          })
          sentences = BriefingRules.sentences(speech.text)
          sentenceIndex = 0
          speakUtterance(engine, speech)
        }.onFailure {
          Log.w(TAG, "Android TTS 실패 — 알람음만", it)
          lastStatus = "Android TTS 실패 — 알람음만"
          finish()
        }
      }
    }
  }

  // 이미 초기화된 오프라인 TTS 엔진을 재사용하여 같은 문장을 반복 (다시 API를 부르지 않음). sentenceIndex번째 문장 하나만 읽음
  private fun speakUtterance(engine: TextToSpeech, speech: VoiceBriefing.Speech) {
    if (finished) return
    // 느낌표는 소리 내 읽히므로 지운 문장(BriefingRules.sentences)으로 (3 · 4단계 Gemini 대사를 대신 읽을 때도). 높낮이 · 속도는 그대로
    val sentence = sentences.getOrNull(sentenceIndex) ?: return finish()
    handler.removeCallbacks(startTimeout)
    handler.postDelayed(startTimeout, START_TIMEOUT_MILLIS)
    if (engine.speak(sentence, TextToSpeech.QUEUE_FLUSH, null, UTTERANCE) != TextToSpeech.SUCCESS) {
      handler.removeCallbacks(startTimeout)
      finish()
    } else if (sentenceIndex == 0) {
      Log.i(TAG, "브리핑: Android TTS ${speech.level}단계${if (repeating) " 반복" else ""}")
      lastSource = BriefingRules.source(speech.level, cache = false, bundled = false)
      val fallback = if (speech.level >= 3) " (Gemini 음성 대체)" else ""
      lastStatus = "Android TTS ${speech.level}단계 읽는 중$fallback${if (repeating) " (반복)" else ""}"
    }
  }

  /**
   * 다음 경계에서 멈추고 callback을 부름 (메인 스레드) — Android TTS는 지금 문장 끝, WAV는 지금 바퀴 끝, 다시 읽기 전 쉬는 중이면 바로.
   * 문장 · 파일을 가운데서 끊지 않음. 이어 읽기는 resume(). 이미 끝났으면 아무것도 안 함 (부른 쪽이 onDone에서 처리)
   */
  fun holdAtNextBoundary(callback: () -> Unit) {
    if (finished) return
    onHold = callback
    if (pausing) {
      handler.removeCallbacks(repeatSpeech)
      pausing = false
      hold()
      return
    }
    player?.let { p -> runCatching { p.isLooping = false } }
  }

  /** holdAtNextBoundary로 멈춘 뒤 이어 읽기 — Android TTS는 다음 문장(바퀴 끝이었으면 처음)부터, WAV는 처음부터 다시 반복 */
  fun resume() {
    if (finished) return
    val p = player
    if (p != null) {
      runCatching {
        p.isLooping = repeating
        p.seekTo(0)
        p.start()
      }.onFailure {
        Log.w(TAG, "그룹 안내 뒤 음성을 다시 못 틂 — 알람음만", it)
        finish()
      }
      return
    }
    val engine = tts
    val speech = currentSpeech
    if (engine != null && speech != null) speakUtterance(engine, speech)
  }

  private fun hold(): Boolean {
    val callback = onHold ?: return false
    onHold = null
    callback()
    return true
  }

  private fun finish() {
    if (finished) return
    finished = true
    release()
    onDone()
  }

  /** 해제 · 미루기 · 서비스 종료 — 읽던 것을 멈춤 (onDone은 안 부름) */
  fun stop() {
    if (!finished) lastStatus = "멈춤"
    finished = true
    release()
  }

  private fun release() {
    handler.removeCallbacks(initTimeout)
    handler.removeCallbacks(startTimeout)
    handler.removeCallbacks(repeatSpeech)
    pausing = false
    onHold = null
    currentSpeech = null
    releasePlayer()
    tts?.let { t ->
      runCatching { t.stop() }
      runCatching { t.shutdown() }
    }
    tts = null
  }
}
