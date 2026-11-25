package expo.modules.t3agentnotifications

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** RFC 9180 A.2.1 (DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20Poly1305), sequence 0. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class RelayNotifyHpkeTest {
  private fun hex(value: String): ByteArray =
    value.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

  private val skRm = hex("8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb")
  private val pkRm = hex("4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a")
  private val enc = hex("1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a")
  private val info = hex("4f6465206f6e2061204772656369616e2055726e")
  private val aad = hex("436f756e742d30")
  private val ct = hex(
    "1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28"
  )
  private val pt = hex("4265617574792069732074727574682c20747275746820626561757479")

  @Test
  fun opensTheRfcVector() {
    assertArrayEquals(pt, Hpke.open(skRm, pkRm, enc, info, aad, ct))
  }

  @Test
  fun refusesATamperedCiphertextOrAad() {
    val tampered = ct.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }
    assertNull(Hpke.open(skRm, pkRm, enc, info, aad, tampered))
    assertNull(Hpke.open(skRm, pkRm, enc, info, hex("00"), ct))
  }
}
