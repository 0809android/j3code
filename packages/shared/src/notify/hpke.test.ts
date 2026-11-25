import { describe, expect, it } from "@effect/vitest";

import {
  HpkeError,
  hpkeDeriveKeyPair,
  hpkeOpen,
  hpkePublicKey,
  hpkeSeal,
  hpkeSetupBaseRecipient,
  hpkeSetupBaseSender,
} from "./hpke.ts";

const bytes = (hex: string) => Uint8Array.from(Buffer.from(hex.replace(/\s+/gu, ""), "hex"));
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");

/** RFC 9180 Appendix A.2.1: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20Poly1305, base. */
const A21 = {
  info: "4f6465206f6e2061204772656369616e2055726e",
  ikmE: "909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b",
  pkEm: "1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a",
  skEm: "f4ec9b33b792c372c1d2c2063507b684ef925b8c75a42dbcbf57d63ccd381600",
  ikmR: "1ac01f181fdf9f352797655161c58b75c656a6cc2716dcb66372da835542e1df",
  pkRm: "4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a",
  skRm: "8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb",
  enc: "1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a",
  sharedSecret: "0bbe78490412b4bbea4812666f7916932b828bba79942424abb65244930d69a7",
  key: "ad2744de8e17f4ebba575b3f5f5a8fa1f69c2a07f6e7500bc60ca6e3e3ec1c91",
  baseNonce: "5c4d98150661b848853b547f",
  exporterSecret: "a3b010d4994890e2c6968a36f64470d3c824c8f5029942feb11e7a74b2921922",
  pt: "4265617574792069732074727574682c20747275746820626561757479",
  encryptions: [
    {
      seq: 0,
      aad: "436f756e742d30",
      ct: "1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28",
    },
    {
      seq: 1,
      aad: "436f756e742d31",
      ct: "6b53c051e4199c518de79594e1c4ab18b96f081549d45ce015be002090bb119e85285337cc95ba5f59992dc98c",
    },
    {
      seq: 2,
      aad: "436f756e742d32",
      ct: "71146bd6795ccc9c49ce25dda112a48f202ad220559502cef1f34271e0cb4b02b4f10ecac6f48c32f878fae86b",
    },
    {
      seq: 4,
      aad: "436f756e742d34",
      ct: "63357a2aa291f5a4e5f27db6baa2af8cf77427c7c1a909e0b37214dd47db122bb153495ff0b02e9e54a50dbe16",
    },
    {
      seq: 255,
      aad: "436f756e742d323535",
      ct: "18ab939d63ddec9f6ac2b60d61d36a7375d2070c9b683861110757062c52b8880a5f6b3936da9cd6c23ef2a95c",
    },
    {
      seq: 256,
      aad: "436f756e742d323536",
      ct: "7a4a13e9ef23978e2c520fd4d2e757514ae160cd0cd05e556ef692370ca53076214c0c40d4c728d6ed9e727a5b",
    },
  ],
  exports: [
    { context: "", value: "4bbd6243b8bb54cec311fac9df81841b6fd61f56538a775e7c80a9f40160606e" },
    { context: "00", value: "8c1df14732580e5501b00f82b10a1647b40713191b7c1240ac80e2b68808ba69" },
    {
      context: "54657374436f6e74657874",
      value: "5acb09211139c43b3090489a9da433e8a30ee7188ba8b0a9a1ccf0c229283e53",
    },
  ],
};

describe("HPKE against RFC 9180 A.2.1", () => {
  it("derives the vector's key pairs", () => {
    const sender = hpkeDeriveKeyPair(bytes(A21.ikmE));
    expect(hex(sender.secretKey)).toBe(A21.skEm);
    expect(hex(sender.publicKey)).toBe(A21.pkEm);
    const recipient = hpkeDeriveKeyPair(bytes(A21.ikmR));
    expect(hex(recipient.secretKey)).toBe(A21.skRm);
    expect(hex(recipient.publicKey)).toBe(A21.pkRm);
    expect(hex(hpkePublicKey(bytes(A21.skRm)))).toBe(A21.pkRm);
  });

  it("matches the key schedule, every encryption and every exported value", () => {
    const { enc, context } = hpkeSetupBaseSender({
      recipientPublicKey: bytes(A21.pkRm),
      info: bytes(A21.info),
      ephemeralSecretKey: bytes(A21.skEm),
    });
    expect(hex(enc)).toBe(A21.enc);
    expect(hex(context.schedule.sharedSecret)).toBe(A21.sharedSecret);
    expect(hex(context.schedule.key)).toBe(A21.key);
    expect(hex(context.schedule.baseNonce)).toBe(A21.baseNonce);
    expect(hex(context.schedule.exporterSecret)).toBe(A21.exporterSecret);

    const recipient = hpkeSetupBaseRecipient({
      enc,
      recipientSecretKey: bytes(A21.skRm),
      info: bytes(A21.info),
    });
    expect(hex(recipient.schedule.key)).toBe(A21.key);

    let sequence = 0;
    for (const vector of A21.encryptions) {
      // The vectors skip sequence numbers; seal and open in between to reach them.
      while (sequence < vector.seq) {
        recipient.open(context.seal(bytes(A21.pt), new Uint8Array(0)), new Uint8Array(0));
        sequence += 1;
      }
      const sealed = context.seal(bytes(A21.pt), bytes(vector.aad));
      expect(hex(sealed)).toBe(vector.ct);
      expect(hex(recipient.open(sealed, bytes(vector.aad)))).toBe(A21.pt);
      sequence += 1;
    }
    for (const vector of A21.exports) {
      expect(hex(context.export(bytes(vector.context), 32))).toBe(vector.value);
      expect(hex(recipient.export(bytes(vector.context), 32))).toBe(vector.value);
    }
  });
});

describe("HPKE refuses what it must", () => {
  const info = new TextEncoder().encode("test");
  const aad = new TextEncoder().encode("aad");
  const plaintext = new TextEncoder().encode("approval needed");
  const recipient = hpkeDeriveKeyPair(new Uint8Array(32).fill(7));

  it("a ciphertext opens only with its recipient's key, info and aad", () => {
    const sealed = hpkeSeal({ recipientPublicKey: recipient.publicKey, info, aad, plaintext });
    expect(
      new TextDecoder().decode(
        hpkeOpen({ ...sealed, recipientSecretKey: recipient.secretKey, info, aad }),
      ),
    ).toBe("approval needed");
    const other = hpkeDeriveKeyPair(new Uint8Array(32).fill(8));
    const attempts = [
      { ...sealed, recipientSecretKey: other.secretKey, info, aad },
      { ...sealed, recipientSecretKey: recipient.secretKey, info: aad, aad },
      { ...sealed, recipientSecretKey: recipient.secretKey, info, aad: info },
    ];
    for (const attempt of attempts) {
      expect(() => hpkeOpen(attempt)).toThrow(HpkeError);
    }
  });

  it("every flipped bit of enc or the ciphertext fails to open", () => {
    const sealed = hpkeSeal({ recipientPublicKey: recipient.publicKey, info, aad, plaintext });
    for (const field of ["enc", "ciphertext"] as const) {
      for (let index = 0; index < sealed[field].length; index += 1) {
        const tampered = Uint8Array.from(sealed[field]);
        tampered[index] = (tampered[index] ?? 0) ^ 0x01;
        expect(() =>
          hpkeOpen({
            ...sealed,
            [field]: tampered,
            recipientSecretKey: recipient.secretKey,
            info,
            aad,
          }),
        ).toThrow(HpkeError);
      }
    }
  });

  it("draws a fresh ephemeral key for every seal, so enc and ciphertext never repeat", () => {
    const first = hpkeSeal({ recipientPublicKey: recipient.publicKey, info, aad, plaintext });
    const second = hpkeSeal({ recipientPublicKey: recipient.publicKey, info, aad, plaintext });
    expect(hex(first.enc)).not.toBe(hex(second.enc));
    expect(hex(first.ciphertext)).not.toBe(hex(second.ciphertext));
  });

  it("a context never opens the same sequence number twice", () => {
    const { enc, context } = hpkeSetupBaseSender({ recipientPublicKey: recipient.publicKey, info });
    const sealed = context.seal(plaintext, aad);
    const opener = hpkeSetupBaseRecipient({ enc, recipientSecretKey: recipient.secretKey, info });
    opener.open(sealed, aad);
    expect(() => opener.open(sealed, aad)).toThrow(HpkeError);
  });

  it("refuses low-order and malformed public keys", () => {
    const lowOrder = [
      new Uint8Array(32),
      Uint8Array.of(1, ...new Uint8Array(31)),
      bytes("e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800"),
    ];
    for (const key of lowOrder) {
      expect(() => hpkeSeal({ recipientPublicKey: key, info, aad, plaintext })).toThrow(HpkeError);
    }
    expect(() =>
      hpkeSeal({ recipientPublicKey: new Uint8Array(31), info, aad, plaintext }),
    ).toThrow(HpkeError);
    expect(() =>
      hpkeOpen({
        enc: new Uint8Array(32),
        ciphertext: new Uint8Array(32),
        recipientSecretKey: recipient.secretKey,
        info,
        aad,
      }),
    ).toThrow(HpkeError);
  });
});
