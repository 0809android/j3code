import CryptoKit
import Foundation
import Security
import UserNotifications

/// Opens K3 relay notifications on the device (spec §13). The relay and APNs carry an envelope
/// sealed to this device's notification key `Nk`; this extension opens it with the key the app
/// keeps in the shared keychain group and replaces the placeholder text. Layout and checks follow
/// packages/shared/src/notify/envelope.ts (infra/k3-relay/docs/NOTIFICATIONS.md).
final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var bestAttempt: UNMutableNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      contentHandler(request.content)
      return
    }
    bestAttempt = content
    if let envelope = request.content.userInfo["k3"] as? String,
      let opened = K3RelayEnvelope.open(envelope, now: Date())
    {
      content.title = opened.hostLabel ?? "K3 Code"
      content.body = K3RelayText.body(for: opened.kind)
      content.threadIdentifier = opened.threadId ?? opened.environmentId
      var userInfo = request.content.userInfo
      userInfo.removeValue(forKey: "k3")
      userInfo["environmentId"] = opened.environmentId
      if let threadId = opened.threadId { userInfo["threadId"] = threadId }
      // expo-notifications reads a remote notification's data from "body".
      var data: [String: Any] = ["environmentId": opened.environmentId, "k3Kind": opened.kind]
      if let threadId = opened.threadId { data["threadId"] = threadId }
      userInfo["body"] = data
      content.userInfo = userInfo
    } else if request.content.userInfo["k3"] != nil {
      content.title = "K3 Code"
      content.body = K3RelayText.body(for: "")
    }
    contentHandler(content)
  }

  override func serviceExtensionTimeWillExpire() {
    if let contentHandler, let bestAttempt { contentHandler(bestAttempt) }
  }
}

struct K3RelayOpened {
  let kind: String
  let environmentId: String
  let threadId: String?
  let hostLabel: String?
}

enum K3RelayEnvelope {
  private static let version: UInt8 = 1
  private static let headerBytes = 9
  private static let encBytes = 32
  private static let buckets: Set<Int> = [256, 512, 1024]
  private static let maxAge: TimeInterval = 24 * 60 * 60
  private static let futureSkew: TimeInterval = 5 * 60
  private static let kinds: Set<String> = ["approval", "input", "completed", "failed", "test"]
  private static let info = Data("k3relay-v1/notify".utf8)

  static func open(_ text: String, now: Date) -> K3RelayOpened? {
    guard let envelope = base64url(text),
      envelope.count >= headerBytes + encBytes + 256 + 16,
      envelope.count <= headerBytes + encBytes + 1024 + 16,
      envelope[envelope.startIndex] == version
    else { return nil }
    let header = envelope.prefix(headerBytes)
    let keyId = header.dropFirst().map { String(format: "%02x", $0) }.joined()
    guard let record = K3RelayKeychain.record(named: "k3relay.notify.\(keyId)"),
      let secret = base64url(record.secretKey),
      let privateKey = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: secret)
    else { return nil }
    let enc = envelope.dropFirst(headerBytes).prefix(encBytes)
    let ciphertext = envelope.dropFirst(headerBytes + encBytes)
    guard
      var recipient = try? HPKE.Recipient(
        privateKey: privateKey,
        ciphersuite: .Curve25519_SHA256_ChachaPoly,
        info: info,
        encapsulatedKey: Data(enc)
      ),
      let padded = try? recipient.open(Data(ciphertext), authenticating: Data(header)),
      buckets.contains(padded.count)
    else { return nil }
    let bytes = [UInt8](padded)
    let length = Int(bytes[0]) << 8 | Int(bytes[1])
    guard length + 2 <= bytes.count, bytes[(2 + length)...].allSatisfy({ $0 == 0 }) else { return nil }
    guard
      let json = try? JSONSerialization.jsonObject(with: Data(bytes[2..<(2 + length)])),
      let payload = json as? [String: Any],
      payload["v"] as? Int == 1,
      let kind = payload["kind"] as? String, kinds.contains(kind),
      let environmentId = payload["env"] as? String, environmentId == record.environmentId,
      let ts = payload["ts"] as? Double
    else { return nil }
    let sent = Date(timeIntervalSince1970: ts / 1000)
    guard sent > now.addingTimeInterval(-maxAge), sent < now.addingTimeInterval(futureSkew) else {
      return nil
    }
    return K3RelayOpened(
      kind: kind,
      environmentId: environmentId,
      threadId: payload["thread"] as? String,
      hostLabel: record.hostLabel
    )
  }

  static func base64url(_ text: String) -> Data? {
    guard text.range(of: "^[A-Za-z0-9_-]*$", options: .regularExpression) != nil else { return nil }
    var standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while standard.count % 4 != 0 { standard += "=" }
    return Data(base64Encoded: standard)
  }
}

struct K3RelayKeyRecord {
  let secretKey: String
  let environmentId: String
  let hostLabel: String?
}

/// Reads the record the app wrote through expo-secure-store. Items go to the app's first
/// keychain access group, which this extension's entitlements share.
enum K3RelayKeychain {
  static func record(named name: String) -> K3RelayKeyRecord? {
    guard let data = item(account: Data(name.utf8)) ?? item(account: name),
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      json["v"] as? Int == 1,
      let secretKey = json["sk"] as? String,
      let environmentId = json["env"] as? String
    else { return nil }
    return K3RelayKeyRecord(
      secretKey: secretKey,
      environmentId: environmentId,
      hostLabel: json["label"] as? String
    )
  }

  private static func item(account: Any) -> Data? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccount as String: account,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else { return nil }
    return result as? Data
  }
}

/// The notification text, in the app's languages. The envelope carries only a kind.
enum K3RelayText {
  private static let table: [String: [String: String]] = [
    "en": ["approval": "Approval needed", "input": "Input needed", "completed": "Task completed", "failed": "The agent run failed", "test": "Test notification", "": "New activity"],
    "ja": ["approval": "承認が必要です", "input": "入力が必要です", "completed": "タスクが完了しました", "failed": "エージェントの実行に失敗しました", "test": "テスト通知", "": "新しいアクティビティ"],
    "de": ["approval": "Freigabe erforderlich", "input": "Eingabe erforderlich", "completed": "Aufgabe abgeschlossen", "failed": "Der Agentenlauf ist fehlgeschlagen", "test": "Testbenachrichtigung", "": "Neue Aktivität"],
    "es": ["approval": "Se necesita aprobación", "input": "Se necesita tu respuesta", "completed": "Tarea completada", "failed": "La ejecución del agente falló", "test": "Notificación de prueba", "": "Nueva actividad"],
    "fr": ["approval": "Approbation requise", "input": "Réponse requise", "completed": "Tâche terminée", "failed": "L’exécution de l’agent a échoué", "test": "Notification de test", "": "Nouvelle activité"],
    "ko": ["approval": "승인이 필요합니다", "input": "입력이 필요합니다", "completed": "작업이 완료되었습니다", "failed": "에이전트 실행에 실패했습니다", "test": "테스트 알림", "": "새 활동"],
    "pt": ["approval": "Aprovação necessária", "input": "Resposta necessária", "completed": "Tarefa concluída", "failed": "A execução do agente falhou", "test": "Notificação de teste", "": "Nova atividade"],
    "ru": ["approval": "Требуется одобрение", "input": "Требуется ваш ответ", "completed": "Задача выполнена", "failed": "Запуск агента завершился ошибкой", "test": "Тестовое уведомление", "": "Новая активность"],
    "sv": ["approval": "Godkännande krävs", "input": "Svar krävs", "completed": "Uppgiften är klar", "failed": "Agentkörningen misslyckades", "test": "Testavisering", "": "Ny aktivitet"],
    "zh": ["approval": "需要批准", "input": "需要你的输入", "completed": "任务已完成", "failed": "智能体运行失败", "test": "测试通知", "": "新动态"],
  ]

  static func body(for kind: String) -> String {
    let language = Locale.preferredLanguages.first.map { String($0.prefix(2)) } ?? "en"
    let strings = table[language] ?? table["en"]!
    return strings[kind] ?? strings[""]!
  }
}
