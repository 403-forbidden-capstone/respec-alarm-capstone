package expo.modules.alarmcore

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

// 백그라운드 브리핑 갱신(#515)용 기기 키 보관 — 앱(JS lib/alarmSync/briefingDevice.ts)이 briefing-device에서 받은 키를 넘겨 줌
// 값 = { url(함수 주소), apikey(공개 anon 키), token(bdk_… 원문), userId, deviceId, expiresAt }
// token이 든 JSON 전체를 Android Keystore의 AES-GCM 키(앱 밖으로 못 꺼냄)로 암호화해 앱 전용 SharedPreferences에 둠
// 앱 로그인 토큰(JWT)은 여기 두지 않음 — Kotlin이 Supabase 세션을 갱신하면 JS 세션의 refresh token과 부딪쳐 로그아웃될 수 있어서
// 풀 수 없으면(키 삭제 · 기기 이전 백업 복원) 지우고 null → 갱신만 멈추고 알람은 저장된 브리핑으로, 다음 앱 열기에서 다시 발급
internal object BriefingCredential {
  private const val PREFS = "alarm_briefing_device"
  private const val VALUE = "value"
  private const val ALIAS = "alarmcore_briefing_device_v1"
  private const val GCM_TAG_BITS = 128

  data class Credential(val url: String, val apikey: String, val token: String, val userId: String, val deviceId: String, val expiresAt: Long)

  private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build(),
    )
    return generator.generateKey()
  }

  /** 앱이 넘긴 JSON을 확인하고 암호화해 저장. 모양이 틀리면 던짐(앱 Promise reject) */
  @Synchronized
  fun save(context: Context, json: String) {
    val c = parse(JSONObject(json)) ?: throw IllegalArgumentException("기기 키 값이 이상해요")
    require(c.url.startsWith("https://") || c.url.startsWith("http://")) { "함수 주소가 이상해요" }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
    val sealed = cipher.iv + cipher.doFinal(json.toByteArray(Charsets.UTF_8))
    prefs(context).edit().putString(VALUE, Base64.encodeToString(sealed, Base64.NO_WRAP)).commit()
  }

  @Synchronized
  fun load(context: Context): Credential? {
    val raw = prefs(context).getString(VALUE, null) ?: return null
    return runCatching {
      val sealed = Base64.decode(raw, Base64.NO_WRAP)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(GCM_TAG_BITS, sealed, 0, 12)) }
      parse(JSONObject(String(cipher.doFinal(sealed, 12, sealed.size - 12), Charsets.UTF_8)))
    }.getOrNull() ?: run {
      clear(context)
      null
    }
  }

  /** 앱에 돌려줄 정보 (키 원문은 빼고) — 앱이 다른 계정 · 만료 임박을 보고 다시 발급할지 정함 */
  fun info(context: Context): Map<String, Any>? = load(context)?.let {
    mapOf("userId" to it.userId, "deviceId" to it.deviceId, "expiresAt" to it.expiresAt.toDouble())
  }

  @Synchronized
  fun clear(context: Context) {
    prefs(context).edit().remove(VALUE).commit()
  }

  private fun parse(o: JSONObject): Credential? {
    val c = Credential(
      url = o.optString("url"),
      apikey = o.optString("apikey"),
      token = o.optString("token"),
      userId = o.optString("userId"),
      deviceId = o.optString("deviceId"),
      expiresAt = o.optDouble("expiresAt", 0.0).toLong(),
    )
    return c.takeIf { it.url.isNotEmpty() && it.token.startsWith("bdk_") && it.userId.isNotEmpty() && it.deviceId.isNotEmpty() && it.expiresAt > 0 }
  }
}
