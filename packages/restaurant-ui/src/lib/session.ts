// Retry-once wrapper for calls made under a dashboard delegation (see
// `parentDelegation.ts`). The page renews the delegation ahead of time, but a
// sleeping laptop or a throttled background tab can still miss that, and the
// replica then rejects the call with HTTP 400. Renew once and repeat it.

import { isEmbedded, renewDelegation } from "./parentDelegation";

export async function withSession<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isEmbedded() && message.includes("Status: 400") && (await renewDelegation())) {
      return call();
    }
    throw error;
  }
}
