import { createHmac, createPublicKey, verify as ecdsaVerify } from "node:crypto";

/**
 * HMAC-SHA256 握手签名 + welcome 非对称验签。
 *
 * hello：客户端用 CLIENT_SECRET 对 `${clientId}:${userId}:${nonce}:${ts}` 签名；
 *       云端用同一密钥校验。userId 与 nonce 被签名覆盖，防中间人篡改归属与重放。
 *
 * welcome：云端用 ECDSA(P-256) 私钥对 `${sessionId}:${userId}:${nonce}:${ts}` 签名，
 *       客户端用预置的云端公钥（BRIDGE_PUBLIC_KEY_PEM）验签——防伪造云端端点。
 *       未配置公钥时跳过验签（本机联调）；生产必须配置。
 */
export function sign(clientId: string, userId: string, nonce: string, ts: number, secret: string): string {
  return createHmac("sha256", secret).update(`${clientId}:${userId}:${nonce}:${ts}`).digest("hex");
}

/** 校验 welcome 的 ECDSA 签名（防伪造云端端点）。任何异常都按失败处理。 */
export function verifyWelcome(
  sessionId: string,
  userId: string,
  nonce: string,
  ts: number,
  signature: string,
  publicKeyPem: string,
): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return ecdsaVerify(
      "sha256",
      Buffer.from(`${sessionId}:${userId}:${nonce}:${ts}`),
      key,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}
