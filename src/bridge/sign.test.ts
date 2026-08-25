import { createHmac, generateKeyPairSync, sign as ecdsaSign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sign, verifyWelcome } from "./sign.js";

describe("sign（HMAC hello 签名）", () => {
  it("对 clientId:userId:nonce:ts 做 HMAC-SHA256，与独立计算一致", () => {
    const clientId = "c1";
    const userId = "u1";
    const nonce = "abc123";
    const ts = 1_700_000_000_000;
    const secret = "s3cret";
    const expected = createHmac("sha256", secret)
      .update(`${clientId}:${userId}:${nonce}:${ts}`)
      .digest("hex");
    expect(sign(clientId, userId, nonce, ts, secret)).toBe(expected);
  });

  it("输入确定性：相同参数产生相同签名", () => {
    const a = sign("c", "u", "n", 1, "s");
    const b = sign("c", "u", "n", 1, "s");
    expect(a).toBe(b);
  });

  it("secret / nonce / ts 任一变化都会改变签名（防篡改/重放）", () => {
    const base = sign("c", "u", "n", 1, "s");
    expect(sign("c", "u", "n", 1, "s2")).not.toBe(base); // secret 变
    expect(sign("c", "u", "n2", 1, "s")).not.toBe(base); // nonce 变
    expect(sign("c", "u", "n", 2, "s")).not.toBe(base); // ts 变
    expect(sign("c", "u2", "n", 1, "s")).not.toBe(base); // userId 变（归属防篡改）
  });
});

describe("verifyWelcome（ECDSA welcome 验签）", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const { publicKey: otherPublicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const otherPublicKeyPem = otherPublicKey.export({ type: "spki", format: "pem" }) as string;

  function makeSignature(payload: string): string {
    return ecdsaSign("sha256", Buffer.from(payload), privateKey).toString("base64");
  }

  const sessionId = "sess-1";
  const userId = "u1";
  const nonce = "nonce-1";
  const ts = 1_700_000_000_000;

  it("合法签名通过", () => {
    const sig = makeSignature(`${sessionId}:${userId}:${nonce}:${ts}`);
    expect(verifyWelcome(sessionId, userId, nonce, ts, sig, publicKeyPem)).toBe(true);
  });

  it("篡改 sessionId / userId / nonce / ts 任一字段均拒绝", () => {
    const sig = makeSignature(`${sessionId}:${userId}:${nonce}:${ts}`);
    expect(verifyWelcome("sess-2", userId, nonce, ts, sig, publicKeyPem)).toBe(false);
    expect(verifyWelcome(sessionId, "u2", nonce, ts, sig, publicKeyPem)).toBe(false);
    expect(verifyWelcome(sessionId, userId, "nonce-2", ts, sig, publicKeyPem)).toBe(false);
    expect(verifyWelcome(sessionId, userId, nonce, ts + 1, sig, publicKeyPem)).toBe(false);
  });

  it("用错误公钥验签失败（防伪造云端端点）", () => {
    const sig = makeSignature(`${sessionId}:${userId}:${nonce}:${ts}`);
    expect(verifyWelcome(sessionId, userId, nonce, ts, sig, otherPublicKeyPem)).toBe(false);
  });

  it("非法公钥 / 非法签名返回 false 而非抛错", () => {
    const sig = makeSignature(`${sessionId}:${userId}:${nonce}:${ts}`);
    expect(verifyWelcome(sessionId, userId, nonce, ts, sig, "not a pem")).toBe(false);
    expect(verifyWelcome(sessionId, userId, nonce, ts, "!!!not-base64!!!", publicKeyPem)).toBe(false);
    expect(verifyWelcome(sessionId, userId, nonce, ts, "", publicKeyPem)).toBe(false);
  });
});
