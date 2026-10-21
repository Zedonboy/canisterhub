// Hand-written mirror of `packages/ic-sql/ic-sql.did` - trimmed to just
// `llm_context`, the only `ic-sql` method the dashboard still calls
// directly (see `lib/agentMap.ts::getNodeLlmContext`). Table/row
// browsing/CRUD (`list_tables`/`describe_table`/`query`/`execute`) moved
// out to the standalone `packages/table-browser` app, which keeps its own
// copy of this interface (`packages/table-browser/src/lib/candid/icSql.ts`)
// since it isn't shared code between the two apps.

import { IDL } from "@icp-sdk/core/candid";

export interface IcSqlService {
  llm_context: () => Promise<string>;
}

export const idlFactory: IDL.InterfaceFactory = ({ IDL }) => {
  return IDL.Service({
    llm_context: IDL.Func([], [IDL.Text], ["query"]),
  });
};
