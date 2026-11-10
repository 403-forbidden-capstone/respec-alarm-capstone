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
  }

  private val handler = Handler(Looper.getMainLooper())
  private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
  private var player: MediaPlayer? = null
  private var tts: TextToSpeech? = null
  private var finished = false

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
    tts = TextToSpeech(context.applicationContext) { status ->
      handler.post {
        val engine = tts
        if (finished || engine == null) return@post
        if (status != TextToSpeech.SUCCESS) {
          Log.w(TAG, "Android TTS를 못 켬 — 알람음만")
          finish()
          return@post
        }
        runCatching {
          engine.setLanguage(Locale.KOREAN)
          // 목소리: 폰에 있는 한국어 목소리(인터넷 필요 없는 것) 중 번호로. 하나뿐이면 높낮이 · 속도로만 달라짐
          val voices = engine.voices.orEmpty().filter { it.locale.language == "ko" && !it.isNetworkConnectionRequired }.sortedBy { it.name }
          if (voices.isNotEmpty()) engine.setVoice(voices[speech.voiceIndex.mod(voices.size)])
          engine.setPitch(speech.pitch)
          engine.setSpeechRate(speech.rate)
          engine.setAudioAttributes(attributes)
          engine.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {
              handler.post { onStart() }
            }

            override fun onDone(utteranceId: String?) {
              handler.post { finish() }
            }

            @Deprecated("Deprecated in Java")
            override fun onError(utteranceId: String?) {
              handler.post { finish() }
            }
          })
          if (engine.speak(speech.text, TextToSpeech.QUEUE_FLUSH, null, UTTERANCE) != TextToSpeech.SUCCESS) finish()
          else Log.i(TAG, "브리핑: Android TTS ${speech.level}단계")
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
