import { createHmac } from "node:crypto";

/**
 * HMAC-SHA256 握手签名。
 * 客户端用 CLIENT_SECRET 对 `${clientId}:${userId}:${ts}` 签名；云端用同一密钥校验。
 * userId 被签名覆盖，防止中间人篡改「本机归属用户」的声明。
 * 生产环境应升级为：客户端用 CLIENT_SECRET 签名，云端用私钥签名 welcome、
 * 客户端用预置的云端公钥验签（防伪造云端端点）。
 */
export function sign(clientId: string, userId: string, ts: number, secret: string): string {
  return createHmac("sha256", secret).update(`${clientId}:${userId}:${ts}`).digest("hex");
}
