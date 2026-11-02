import { IDL } from "@icp-sdk/core/candid";
import type { Principal } from "@icp-sdk/core/principal";

export interface PushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushNotification {
  title: string;
  body: string;
  url: string;
}

export interface PushDelivery {
  endpoint: string;
  status: [] | [number];
  error: [] | [string];
  subscription_removed: boolean;
}

type Result<T> = { Ok: T } | { Err: string };

export interface NotificationService {
  push_vapid_public_key: () => Promise<Result<Uint8Array>>;
  push_subscribe: (subscription: PushSubscription) => Promise<Result<null>>;
  push_unsubscribe: (endpoint: string) => Promise<Result<null>>;
  push_list_subscriptions: () => Promise<Result<PushSubscription[]>>;
  push_send: (principal: Principal, notification: PushNotification) => Promise<Result<PushDelivery[]>>;
}

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  const PushSubscription = IDL.Record({
    endpoint: IDL.Text,
    p256dh: IDL.Text,
    auth: IDL.Text,
  });
  const PushNotification = IDL.Record({
    title: IDL.Text,
    body: IDL.Text,
    url: IDL.Text,
  });
  const PushDelivery = IDL.Record({
    endpoint: IDL.Text,
    status: IDL.Opt(IDL.Nat16),
    error: IDL.Opt(IDL.Text),
    subscription_removed: IDL.Bool,
  });
  const UnitResult = IDL.Variant({ Ok: IDL.Null, Err: IDL.Text });
  const KeyResult = IDL.Variant({ Ok: IDL.Vec(IDL.Nat8), Err: IDL.Text });
  const SubscriptionResult = IDL.Variant({ Ok: IDL.Vec(PushSubscription), Err: IDL.Text });
  const DeliveryResult = IDL.Variant({ Ok: IDL.Vec(PushDelivery), Err: IDL.Text });
  return IDL.Service({
    push_vapid_public_key: IDL.Func([], [KeyResult], ["query"]),
    push_subscribe: IDL.Func([PushSubscription], [UnitResult], []),
    push_unsubscribe: IDL.Func([IDL.Text], [UnitResult], []),
    push_list_subscriptions: IDL.Func([], [SubscriptionResult], ["query"]),
    push_send: IDL.Func([IDL.Principal, PushNotification], [DeliveryResult], []),
  });
};

