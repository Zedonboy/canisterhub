// Which canisters on a project are the `analytics` building block
// (`packages/analytics` - `ic-analytics`'s prebuilt "user canister"
// release, see that package's own README) - mirrors `lib/database.ts`'s
// exact shape, just without a sub-kind split: unlike `ic-sql`/`ic-kv`/
// `vector_db`, there's only the one real analytics building block, not a
// family of them. A pure client-side filter of `Project.canisters`
// (already fetched from `backend` - see `lib/backend.ts`), no canister
// call needed.

import type { Project, CanisterKind } from "./backend";

export interface AnalyticsCanister {
  name: string;
  id: string;
}

export function listAnalyticsCanisters(project: Project): AnalyticsCanister[] {
  return Object.entries(project.canisters)
    .filter(([, info]: [string, { kind: CanisterKind }]) => info.kind === "analytics")
    .map(([name, info]) => ({ name, id: info.id }));
}
