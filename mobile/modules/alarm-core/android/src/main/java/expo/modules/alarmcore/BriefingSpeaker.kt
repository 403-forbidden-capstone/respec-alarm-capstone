package expo.modules.alarmcore

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import java.util.Locale

// 브리핑 한 번 읽기 — 기상(AlarmPlaybackService) · 출발(BriefingSpeechService)이 같이 씀
//   Gemini 음성 파일이 있으면(긴급 4단계) MediaPlayer, 아니면 폰의 Android TTS로 같은 문장 전체 — 한 번 읽는 동안 엔진을 바꾸지 않음
//   알람 볼륨 스트림(USAGE_ALARM)으로 읽음. 볼륨 크기 자체는 알람 계획 · 폰 설정이 정함
//   onStart · onDone은 메인 스레드에서 부름 (기상 알람음을 줄였다 되돌리는 데 씀). 어떤 실패든 onDone으로 끝남 — 알람은 멈추지 않음
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
  }

  private val handler = Handler(Looper.getMainLooper())
  private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
  private var player: MediaPlayer? = null
  private var tts: TextToSpeech? = null
  private var finished = false
  private val initTimeout = Runnable {
    Log.w(TAG, "Android TTS가 켜지지 않음 — 알람음만")
    finish()
  }
  private val startTimeout = Runnable {
    Log.w(TAG, "Android TTS가 말을 시작하지 않음 — 알람음만")
    finish()
  }

  fun speak(speech: VoiceBriefing.Speech) {
    val wav = speech.wav
    if (wav != null && playWav(wav, speech.level)) return
    speakAndroid(speech)
  }

  private fun playWav(file: java.io.File, level: Int): Boolean {
    val p = MediaPlayer()
    return try {
      p.setAudioAttributes(attributes)
      p.setDataSource(file.absolutePath)
      p.prepare()
      p.setOnCompletionListener { finish() }
      p.setOnErrorListener { _, _, _ ->
        finish()
        true
      }
      player = p
      onStart()
      p.start()
      Log.i(TAG, "브리핑: Gemini 음성 ${level}단계")
      true
    } catch (e: Exception) {
      // 파일이 깨졌으면 같은 문장을 Android TTS로 (아직 아무것도 안 읽었으니 엔진이 섞이지 않음)
      Log.w(TAG, "Gemini 음성을 못 틀어 Android TTS로", e)
      p.release()
      player = null
      false
    }
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
              handler.post { finish() }
            }

            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
              handler.post { finish() }
            }
          })
          if (engine.speak(speech.text, TextToSpeech.QUEUE_FLUSH, null, UTTERANCE) != TextToSpeech.SUCCESS) {
            finish()
          } else {
            Log.i(TAG, "브리핑: Android TTS ${speech.level}단계")
            // 엔진이 말을 시작하지 않고 멈춰 있으면(목록이 틀린 네트워크 목소리 등) 기다리지 않고 끝냄
            handler.postDelayed(startTimeout, START_TIMEOUT_MILLIS)
          }
        }.onFailure {
          Log.w(TAG, "Android TTS 실패 — 알람음만", it)
          finish()
        }
      }
    }
  }

  private fun finish() {
    if (finished) return
    finished = true
    release()
    onDone()
  }

  /** 해제 · 미루기 · 서비스 종료 — 읽던 것을 멈춤 (onDone은 안 부름) */
  fun stop() {
    finished = true
    release()
  }

  private fun release() {
    handler.removeCallbacks(initTimeout)
    handler.removeCallbacks(startTimeout)
    player?.let { p ->
      runCatching { if (p.isPlaying) p.stop() }
      runCatching { p.release() }
    }
    player = null
    tts?.let { t ->
      runCatching { t.stop() }
      runCatching { t.shutdown() }
    }
    tts = null
  }
}
