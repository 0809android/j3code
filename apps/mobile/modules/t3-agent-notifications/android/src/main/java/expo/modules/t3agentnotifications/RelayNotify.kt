package expo.modules.t3agentnotifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyStore
import java.security.spec.NamedParameterSpec
import java.security.spec.XECPrivateKeySpec
import java.security.spec.XECPublicKeySpec
import java.util.Locale
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.json.JSONObject

/**
 * K3 relay notifications (spec §13), opened natively from FCM data messages so delivery does not
 * depend on a running JS bridge. The envelope is HPKE (RFC 9180, DHKEM(X25519, HKDF-SHA256),
 * HKDF-SHA256, ChaCha20-Poly1305) sealed to this device's notification key `Nk`; layout and checks
 * follow packages/shared/src/notify/envelope.ts. Keys are wrapped with an Android Keystore key.
 */
object RelayNotify {
  private const val STORE = "k3relay-notify"
  private const val WRAP_ALIAS = "k3relay.notify.wrap"
  private const val CHANNEL = "agent-alerts"
  private const val TAG = "k3relay-notify"
  private const val HEADER_BYTES = 9
  private const val ENC_BYTES = 32
  private const val MAX_AGE_MS = 24 * 60 * 60 * 1000L
  private const val FUTURE_SKEW_MS = 5 * 60 * 1000L
  private val BUCKETS = setOf(256, 512, 1024)
  private val KINDS = setOf("approval", "input", "completed", "failed", "test", "device")
  private val INFO = "k3relay-v1/notify".toByteArray()
  private val NAME = Regex("^k3relay\\.notify\\.[A-Za-z0-9._-]{1,96}$")

  // ── Key storage: what the app's NotificationKeyStore writes, wrapped with AES-GCM ──

  @Synchronized
  fun storeKey(context: Context, name: String, value: String) {
    require(NAME.matches(name)) { "Invalid notification key name." }
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, wrapKey())
    val sealed = cipher.iv + cipher.doFinal(value.toByteArray())
    prefs(context).edit().putString(name, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
  }

  @Synchronized
  fun removeKey(context: Context, name: String) {
    prefs(context).edit().remove(name).apply()
  }

  private fun readKey(context: Context, name: String): String? = try {
    val sealed = prefs(context).getString(name, null)?.let { Base64.decode(it, Base64.NO_WRAP) }
    if (sealed == null || sealed.size < 13) {
      null
    } else {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, wrapKey(), GCMParameterSpec(128, sealed, 0, 12))
      String(cipher.doFinal(sealed, 12, sealed.size - 12))
    }
  } catch (_: Exception) {
    null
  }

  private fun prefs(context: Context) = context.getSharedPreferences(STORE, Context.MODE_PRIVATE)

  private fun wrapKey(): SecretKey {
    val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (keyStore.getKey(WRAP_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    generator.init(
      KeyGenParameterSpec.Builder(
        WRAP_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return generator.generateKey()
  }

  // ── Receiving ──

  data class Opened(
    val id: String,
    val kind: String,
    val environmentId: String,
    val threadId: String?,
    val hostLabel: String?
  )

  @Synchronized
  fun setScheme(context: Context, scheme: String) {
    prefs(context).edit().putString("scheme", scheme).apply()
  }

  @Synchronized
  fun receive(context: Context, envelope: String) {
    val scheme = prefs(context).getString("scheme", null) ?: "k3code"
    if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
    val opened = open(context, envelope, System.currentTimeMillis())
    if (opened != null) {
      // FCM may deliver a message twice; show each notification id once.
      val seen = prefs(context).getString("seen", null)?.split('\n').orEmpty()
      if (opened.id in seen) return
      prefs(context).edit().putString("seen", (seen.takeLast(63) + opened.id).joinToString("\n"))
        .apply()
    }
    post(context, scheme, opened)
  }

  fun open(context: Context, text: String, now: Long): Opened? = try {
    openUnsafe(context, text, now)
  } catch (_: Exception) {
    null
  }

  private class KeyRecord(
    val env: String,
    val secret: ByteArray,
    val publicKey: ByteArray,
    val label: String?
  )

  private class ParsedEnvelope(
    val header: ByteArray,
    val keyId: String,
    val enc: ByteArray,
    val ciphertext: ByteArray
  )

  private fun openUnsafe(context: Context, text: String, now: Long): Opened? {
    // XDH and its key specs arrive in API 33; older devices get the plain notification.
    val parsed = if (Build.VERSION.SDK_INT >= 33) parseEnvelope(text) else null
    val record = parsed?.let { readKeyRecord(context, it.keyId) }
    val padded = if (parsed != null && record != null) {
      Hpke.open(
        Hpke.KeyPair(record.secret, record.publicKey),
        Hpke.Envelope(parsed.enc, INFO, parsed.header, parsed.ciphertext)
      )
    } else {
      null
    }
    val payload = padded?.let(::unpadEnvelope)
    return if (record != null && payload != null) parseOpened(payload, record, now) else null
  }

  private fun parseEnvelope(text: String): ParsedEnvelope? {
    val envelope = base64url(text)
    val minSize = HEADER_BYTES + ENC_BYTES + 256 + 16
    val maxSize = HEADER_BYTES + ENC_BYTES + 1024 + 16
    val valid = envelope != null &&
      envelope.size in minSize..maxSize &&
      envelope[0] == 1.toByte()
    return if (!valid || envelope == null) {
      null
    } else {
      val header = envelope.copyOfRange(0, HEADER_BYTES)
      val keyId = header.copyOfRange(1, HEADER_BYTES).joinToString("") { "%02x".format(it) }
      ParsedEnvelope(
        header = header,
        keyId = keyId,
        enc = envelope.copyOfRange(HEADER_BYTES, HEADER_BYTES + ENC_BYTES),
        ciphertext = envelope.copyOfRange(HEADER_BYTES + ENC_BYTES, envelope.size)
      )
    }
  }

  private fun readKeyRecord(context: Context, keyId: String): KeyRecord? {
    val raw = readKey(context, "k3relay.notify.$keyId") ?: return null
    val json = JSONObject(raw)
    val secret = base64url(json.getString("sk"))
    val publicKey = base64url(json.getString("pk"))
    val valid = json.optInt("v") == 1 &&
      secret != null && secret.size == 32 &&
      publicKey != null && publicKey.size == 32
    return if (!valid || secret == null || publicKey == null) {
      null
    } else {
      KeyRecord(
        env = json.optString("env"),
        secret = secret,
        publicKey = publicKey,
        label = if (json.isNull("label")) null else json.optString("label")
      )
    }
  }

  private fun unpadEnvelope(padded: ByteArray): JSONObject? {
    val length = if (padded.size in BUCKETS) {
      ((padded[0].toInt() and 0xff) shl 8) or (padded[1].toInt() and 0xff)
    } else {
      -1
    }
    val validPadding = length >= 0 &&
      length + 2 <= padded.size &&
      (2 + length until padded.size).all { padded[it] == 0.toByte() }
    return if (validPadding) {
      JSONObject(String(padded, 2, length, Charsets.UTF_8))
    } else {
      null
    }
  }

  private fun parseOpened(payload: JSONObject, record: KeyRecord, now: Long): Opened? {
    val kind = payload.optString("kind")
    val environmentId = payload.optString("env")
    val ts = payload.optLong("ts", -1)
    val id = payload.optString("id")
    val valid = payload.optInt("v") == 1 &&
      kind in KINDS &&
      environmentId == record.env &&
      id.length == 22 &&
      ts in (now - MAX_AGE_MS)..(now + FUTURE_SKEW_MS)
    return if (valid) {
      Opened(
        id = id,
        kind = kind,
        environmentId = environmentId,
        threadId = payload.optString("thread").takeIf { it.isNotEmpty() },
        hostLabel = record.label
      )
    } else {
      null
    }
  }

  private fun post(context: Context, scheme: String, opened: Opened?) {
    val manager = context.getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= 26) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL, "Agent alerts", NotificationManager.IMPORTANCE_HIGH)
      )
    }
    val title = opened?.hostLabel ?: "K3 Code"
    val body = RelayNotifyText.body(opened?.kind ?: "")
    val path = if (opened?.threadId != null) {
      "/threads/${Uri.encode(opened.environmentId)}/${Uri.encode(opened.threadId)}"
    } else {
      "/"
    }
    val id = (opened?.id ?: System.currentTimeMillis().toString()).hashCode()
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
      ?.setAction(Intent.ACTION_VIEW)?.setData(Uri.parse("$scheme:/$path"))
      ?.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    val notification = NotificationCompat.Builder(context, CHANNEL)
      .setSmallIcon(R.drawable.agent_activity_mark)
      .setContentTitle(title)
      .setContentText(body)
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setAutoCancel(true)
      .apply {
        if (intent != null) {
          setContentIntent(
            PendingIntent.getActivity(
              context,
              id,
              intent,
              PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
          )
        }
      }
      .build()
    manager.notify(TAG, id, notification)
  }

  private fun base64url(text: String): ByteArray? {
    if (!Regex("^[A-Za-z0-9_-]*$").matches(text)) return null
    return try {
      Base64.decode(text, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    } catch (_: IllegalArgumentException) {
      null
    }
  }
}

/** Base-mode HPKE open for the one suite the host uses. */
internal object Hpke {
  internal class KeyPair(val secretKey: ByteArray, val publicKey: ByteArray)

  internal class Envelope(
    val enc: ByteArray,
    val info: ByteArray,
    val aad: ByteArray,
    val ciphertext: ByteArray
  )

  private const val KEM_ID = 0x0020
  private const val KDF_ID = 0x0001
  private const val AEAD_ID = 0x0003
  private val V1 = "HPKE-v1".toByteArray()
  private val KEM_SUITE = "KEM".toByteArray() + i2osp(KEM_ID, 2)
  private val SUITE = "HPKE".toByteArray() + i2osp(KEM_ID, 2) + i2osp(KDF_ID, 2) +
    i2osp(AEAD_ID, 2)

  fun open(keys: KeyPair, envelope: Envelope): ByteArray? {
    val dh = x25519(keys.secretKey, envelope.enc)?.takeUnless { bytes ->
      bytes.all { it == 0.toByte() }
    }
    return dh?.let { decrypt(keys.publicKey, envelope, it) }
  }

  private fun decrypt(publicKey: ByteArray, envelope: Envelope, dh: ByteArray): ByteArray? {
    val eaePrk = labeledExtract(KEM_SUITE, ByteArray(0), "eae_prk", dh)
    val shared = labeledExpand(
      KEM_SUITE,
      eaePrk,
      "shared_secret",
      envelope.enc + publicKey,
      32
    )
    val context = byteArrayOf(0) +
      labeledExtract(SUITE, ByteArray(0), "psk_id_hash", ByteArray(0)) +
      labeledExtract(SUITE, ByteArray(0), "info_hash", envelope.info)
    val secret = labeledExtract(SUITE, shared, "secret", ByteArray(0))
    val key = labeledExpand(SUITE, secret, "key", context, 32)
    // Sequence 0: the nonce is the base nonce itself.
    val nonce = labeledExpand(SUITE, secret, "base_nonce", context, 12)
    return try {
      val cipher = try {
        Cipher.getInstance("ChaCha20/Poly1305/NoPadding")
      } catch (_: Exception) {
        Cipher.getInstance("ChaCha20-Poly1305")
      }
      cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "ChaCha20"), IvParameterSpec(nonce))
      cipher.updateAAD(envelope.aad)
      cipher.doFinal(envelope.ciphertext)
    } catch (_: Exception) {
      null
    }
  }

  private fun x25519(scalar: ByteArray, uCoordinate: ByteArray): ByteArray? {
    if (Build.VERSION.SDK_INT < 33) return null
    val factory = KeyFactory.getInstance("XDH")
    val privateKey = factory.generatePrivate(XECPrivateKeySpec(NamedParameterSpec.X25519, scalar))
    // RFC 7748: the u-coordinate is little-endian, and its top bit is ignored.
    val u = uCoordinate.reversedArray().also { it[0] = (it[0].toInt() and 0x7f).toByte() }
    val publicKey = factory.generatePublic(
      XECPublicKeySpec(NamedParameterSpec.X25519, BigInteger(1, u))
    )
    val agreement = KeyAgreement.getInstance("XDH")
    agreement.init(privateKey)
    agreement.doPhase(publicKey, true)
    return agreement.generateSecret()
  }

  private fun labeledExtract(suite: ByteArray, salt: ByteArray, label: String, ikm: ByteArray) =
    hmac(if (salt.isEmpty()) ByteArray(32) else salt, V1 + suite + label.toByteArray() + ikm)

  private fun labeledExpand(
    suite: ByteArray,
    prk: ByteArray,
    label: String,
    info: ByteArray,
    length: Int
  ): ByteArray {
    val labeledInfo = i2osp(length, 2) + V1 + suite + label.toByteArray() + info
    var block = ByteArray(0)
    var output = ByteArray(0)
    var counter = 1
    while (output.size < length) {
      block = hmac(prk, block + labeledInfo + byteArrayOf(counter.toByte()))
      output += block
      counter += 1
    }
    return output.copyOf(length)
  }

  private fun hmac(key: ByteArray, data: ByteArray): ByteArray {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(key, "HmacSHA256"))
    return mac.doFinal(data)
  }

  private fun i2osp(value: Int, length: Int): ByteArray =
    ByteArray(length) { index -> (value shr (8 * (length - 1 - index))).toByte() }
}

/** The notification text, in the app's languages. The envelope carries only a kind. */
internal object RelayNotifyText {
  private val TABLE =
    mapOf(
      "en" to
        listOf(
          "Approval needed",
          "Input needed",
          "Task completed",
          "The agent run failed",
          "Test notification",
          "A device was added by introduction",
          "New activity",
        ),
      "ja" to
        listOf(
          "承認が必要です",
          "入力が必要です",
          "タスクが完了しました",
          "エージェントの実行に失敗しました",
          "テスト通知",
          "紹介で端末が追加されました",
          "新しいアクティビティ",
        ),
      "de" to
        listOf(
          "Freigabe erforderlich",
          "Eingabe erforderlich",
          "Aufgabe abgeschlossen",
          "Der Agentenlauf ist fehlgeschlagen",
          "Testbenachrichtigung",
          "Ein Gerät wurde per Empfehlung hinzugefügt",
          "Neue Aktivität",
        ),
      "es" to
        listOf(
          "Se necesita aprobación",
          "Se necesita tu respuesta",
          "Tarea completada",
          "La ejecución del agente falló",
          "Notificación de prueba",
          "Se añadió un dispositivo por presentación",
          "Nueva actividad",
        ),
      "fr" to
        listOf(
          "Approbation requise",
          "Réponse requise",
          "Tâche terminée",
          "L’exécution de l’agent a échoué",
          "Notification de test",
          "Un appareil a été ajouté par présentation",
          "Nouvelle activité",
        ),
      "ko" to
        listOf(
          "승인이 필요합니다",
          "입력이 필요합니다",
          "작업이 완료되었습니다",
          "에이전트 실행에 실패했습니다",
          "테스트 알림",
          "소개로 기기가 추가되었습니다",
          "새 활동",
        ),
      "pt" to
        listOf(
          "Aprovação necessária",
          "Resposta necessária",
          "Tarefa concluída",
          "A execução do agente falhou",
          "Notificação de teste",
          "Um dispositivo foi adicionado por apresentação",
          "Nova atividade",
        ),
      "ru" to
        listOf(
          "Требуется одобрение",
          "Требуется ваш ответ",
          "Задача выполнена",
          "Запуск агента завершился ошибкой",
          "Тестовое уведомление",
          "Устройство добавлено по приглашению",
          "Новая активность",
        ),
      "sv" to
        listOf(
          "Godkännande krävs",
          "Svar krävs",
          "Uppgiften är klar",
          "Agentkörningen misslyckades",
          "Testavisering",
          "En enhet lades till via introduktion",
          "Ny aktivitet",
        ),
      "zh" to
        listOf(
          "需要批准",
          "需要你的输入",
          "任务已完成",
          "智能体运行失败",
          "测试通知",
          "已通过引荐添加设备",
          "新动态",
        ),
    )
  private val KINDS = listOf("approval", "input", "completed", "failed", "test", "device")

  fun body(kind: String): String {
    val strings = TABLE[Locale.getDefault().language] ?: TABLE.getValue("en")
    val index = KINDS.indexOf(kind)
    return strings[if (index >= 0) index else strings.size - 1]
  }
}
