// Hand-written mirror of the protocol backend's push methods used by chat UI.
import { IDL } from "@icp-sdk/core/candid";

export interface PushSubscriptionRecord {
  endpoint: string;
  auth: string;
  p256dh: string;
}
type Result<T> = { Ok: T } | { Err: string };

export interface BackendPushService {
  push_ensure_vapid: () => Promise<Result<Uint8Array | number[]>>;
  push_subscribe: (s: PushSubscriptionRecord) => Promise<Result<null>>;
  push_unsubscribe: (endpoint: string) => Promise<Result<null>>;
}

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const Sub = IDL.Record({ endpoint: IDL.Text, auth: IDL.Text, p256dh: IDL.Text });
  const Blob = IDL.Variant({ Ok: IDL.Vec(IDL.Nat8), Err: IDL.Text });
  const Unit = IDL.Variant({ Ok: IDL.Null, Err: IDL.Text });
  return IDL.Service({
    push_ensure_vapid: IDL.Func([], [Blob], []),
    push_subscribe: IDL.Func([Sub], [Unit], []),
    push_unsubscribe: IDL.Func([IDL.Text], [Unit], []),
  });
};
