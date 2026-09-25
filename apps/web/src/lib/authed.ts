/**
 * Requests signed by the wallet. The Ed25519 signature covers a canonical
 * message naming the action, resource, wallet and a digest of the body, so a
 * signature cannot be moved onto another body. The body passed in must be
 * exactly what is sent, minus `signature` and `issuedAt`.
 */

import { api } from "./api.ts";
import { toBase64 } from "./bytes.ts";
import type { Connection } from "./wallet.ts";

export async function signedRequest<T>(
  connection: Connection,
  args: { readonly action: string; readonly resource: string },
  payload: Record<string, unknown>,
  send: (body: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  const { message, issuedAt } = await api.authMessage({
    action: args.action,
    resource: args.resource,
    wallet: connection.address,
    body: payload,
  });

  const signature = await connection.signMessage(message);
  return send({ ...payload, signature: toBase64(signature), issuedAt });
}
