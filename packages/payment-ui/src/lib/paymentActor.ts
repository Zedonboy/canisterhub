// Actor for the embedding payment canister (see `candid/payment.ts`) -
// always the signed-in (or delegated) identity, always this one canister.

import { Actor } from "@icp-sdk/core/agent";
import { Principal } from "@icp-sdk/core/principal";
import { getAgent } from "./agent";
import { paymentCanisterId } from "./canisterId";
import { idlFactory, type PaymentService } from "./candid/payment";

export async function getPaymentActor(): Promise<PaymentService> {
  const agent = await getAgent();
  return Actor.createActor<PaymentService>(idlFactory, {
    agent,
    canisterId: Principal.fromText(paymentCanisterId()),
  });
}
