import { useEffect, useState, useRef } from "react";
import { Database as DatabaseIcon, RefreshCw, Plus, Pencil, Trash2, Check, X, ChevronLeft, ChevronRight, Search, LogIn, LogOut, Table2, Shield } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import type { TableInfo, TableRows, RowValues, SqlCell } from "@/lib/database";
import { listDatabaseTables, getTableRows, createRow, updateRow, deleteRow } from "@/lib/database";
import { icSqlCanisterId } from "@/lib/canisterId";
import { useAuth } from "@/lib/auth";
import PermissionsPanel from "./PermissionsPanel";

const PAGE_SIZE = 50;

/** A row's real value set doubles as its own identity for update/delete -
 * `ic-sql` has no primary key/rowid support, so "which row" always means
 * "the row with exactly these values". */
function rowToMatch(columns: string[], row: SqlCell[]): RowValues {
  return Object.fromEntries(columns.map((c, i) => [c, row[i]]));
}

/** An empty-string cell is treated as SQL `NULL` in both the add-row and
 * edit forms - a plain text input has no other natural way to express
 * "no value" distinct from "empty text". */
function inputToCell(value: string): SqlCell {
  return value === "" ? null : value;
}

function cellToInput(value: SqlCell): string {
  return value ?? "";
}

function typeBadge(dataType: string): string {
  return dataType.toLowerCase();
}

function NullCell() {
  return <span className="text-[#3d4a63] italic text-xs">null</span>;
}

/** When embedded in the dashboard with a working delegation (`delegated`
 * - see `lib/auth.ts`'s own doc comment), this app is already acting as
 * the real signed-in dashboard user with no action needed here - there's
 * nothing to sign in or out of from inside this frame, so just the
 * principal shows, no button. Standalone (not embedded, or embedded but
 * the parent had no session to delegate), the real Internet Identity
 * sign-in/out button is exactly as before. */
function AuthControl() {
  const { status, principal, delegated, signIn, signOut } = useAuth();
  if (status === "loading") return null;
  if (status === "authenticated") {
    return (
      <div className="flex items-center gap-2">
        <span className="text-[10px] text-[#4a5568] font-mono truncate max-w-[140px]" title={principal ?? undefined}>
          {principal}
        </span>
        {!delegated && (
          <Button variant="ghost" size="sm" onClick={() => signOut().catch(() => undefined)}>
            <LogOut size={13} /> Sign out
          </Button>
        )}
      </div>
    );
  }
  return (
    <Button variant="secondary" size="sm" onClick={() => signIn().catch(() => undefined)}>
      <LogIn size={13} /> Sign in
    </Button>
  );
}

/** Read-write CRUD grid for this canister's own table data, styled after a
 * spreadsheet-native data editor: a table sidebar with search, a
 * sticky-header grid with per-column type chips, hover-reveal row actions,
 * and an inline add-row directly in the grid rather than a separate form
 * panel. Ported from the main dashboard's `DatabaseTable.tsx`, trimmed to
 * this app's one fixed canister (see `lib/canisterId.ts`) - no project
 * context, no canister picker, no route params. Anonymous reads work
 * out of the box; a write beyond anonymous `ReadWrite` access needs the
 * `AuthControl` sign-in above. */
export default function App() {
  const [view, setView] = useState<"tables" | "permissions">("tables");
  const [tablesState, setTablesState] = useState<{ tables?: TableInfo[]; error?: string } | null>(null);
  const [tableFilter, setTableFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [rows, setRows] = useState<TableRows | null>(null);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [loadingRows, setLoadingRows] = useState(false);

  const [editingRow, setEditingRow] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<RowValues>({});
  const [confirmingDelete, setConfirmingDelete] = useState<number | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newRowValues, setNewRowValues] = useState<RowValues>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  const loadTables = () => {
    setTablesState(null);
    listDatabaseTables()
      .then(setTablesState)
      .catch((e) => setTablesState({ error: e instanceof Error ? e.message : String(e) }));
  };

  const loadRows = (table: string, at: number) => {
    setLoadingRows(true);
    setRowsError(null);
    getTableRows(table, { limit: PAGE_SIZE, offset: at })
      .then(setRows)
      .catch((e) => setRowsError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoadingRows(false));
  };

  useEffect(() => {
    loadTables();
  }, []);

  useEffect(() => {
    if (!selected) return;
    loadRows(selected, offset);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, offset]);

  useEffect(() => {
    if (showAddForm) firstFieldRef.current?.focus();
  }, [showAddForm]);

  const selectTable = (name: string) => {
    setSelected(name);
    setOffset(0);
    setEditingRow(null);
    setShowAddForm(false);
    setActionError(null);
  };

  const refresh = () => {
    loadTables();
    if (selected) loadRows(selected, offset);
  };

  const startEdit = (i: number) => {
    if (!rows) return;
    setEditingRow(i);
    setEditValues(rowToMatch(rows.columns, rows.rows[i]));
    setConfirmingDelete(null);
    setActionError(null);
  };

  const saveEdit = async (i: number) => {
    if (!selected || !rows) return;
    setBusy(true);
    setActionError(null);
    try {
      await updateRow(selected, rowToMatch(rows.columns, rows.rows[i]), editValues);
      setEditingRow(null);
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async (i: number) => {
    if (!selected || !rows) return;
    setBusy(true);
    setActionError(null);
    try {
      await deleteRow(selected, rowToMatch(rows.columns, rows.rows[i]));
      setConfirmingDelete(null);
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const submitNewRow = async () => {
    if (!selected) return;
    setBusy(true);
    setActionError(null);
    try {
      await createRow(selected, newRowValues);
      setShowAddForm(false);
      setNewRowValues({});
      setOffset(0);
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const selectedInfo = tablesState?.tables?.find((t) => t.name === selected);
  const filteredTables = tablesState?.tables?.filter((t) => t.name.toLowerCase().includes(tableFilter.toLowerCase())) ?? [];

  return (
    <div className="flex h-full">
      {/* Table sidebar */}
      <div className="w-64 flex-shrink-0 border-r border-[#1e2d47] flex flex-col bg-[#0a0e1a]">
        <div className="p-3 border-b border-[#1e2d47] space-y-2">
          <div className="flex items-center gap-1.5">
            <DatabaseIcon size={13} className="text-[#00d4ff] flex-shrink-0" />
            <span className="text-sm font-medium text-[#e2e8f0] font-mono truncate" title={icSqlCanisterId()}>
              {icSqlCanisterId()}
            </span>
          </div>
          <AuthControl />
        </div>

        <div className="p-2 border-b border-[#1e2d47] grid grid-cols-2 gap-1.5">
          <button
            onClick={() => setView("tables")}
            className={`flex items-center justify-center gap-1.5 py-1.5 rounded text-xs transition-colors ${
              view === "tables" ? "bg-[#00d4ff11] text-[#00d4ff] border border-[#00d4ff33]" : "text-[#8892a4] border border-transparent hover:bg-[#0f1629] hover:text-[#e2e8f0]"
            }`}
          >
            <Table2 size={12} /> Tables
          </button>
          <button
            onClick={() => setView("permissions")}
            className={`flex items-center justify-center gap-1.5 py-1.5 rounded text-xs transition-colors ${
              view === "permissions" ? "bg-[#00d4ff11] text-[#00d4ff] border border-[#00d4ff33]" : "text-[#8892a4] border border-transparent hover:bg-[#0f1629] hover:text-[#e2e8f0]"
            }`}
          >
            <Shield size={12} /> Permissions
          </button>
        </div>

        {view === "tables" && (
          <>
            <div className="p-2 border-b border-[#1e2d47]">
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#4a5568]" />
                <input
                  value={tableFilter}
                  onChange={(e) => setTableFilter(e.target.value)}
                  placeholder="Search tables…"
                  className="w-full pl-7 pr-2 py-1.5 text-xs bg-[#0f1629] border border-[#1e2d47] rounded text-[#e2e8f0] placeholder-[#4a5568] focus:outline-none focus:border-[#00d4ff44]"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto">
              {tablesState?.error && <p className="text-xs text-[#ff5252] p-3">{tablesState.error}</p>}
              {tablesState?.tables && filteredTables.length === 0 && (
                <p className="text-xs text-[#4a5568] p-3">{tablesState.tables.length === 0 ? "No tables yet." : "No matches."}</p>
              )}
              {filteredTables.map((t) => (
                <button
                  key={t.name}
                  onClick={() => selectTable(t.name)}
                  className={`w-full text-left px-3 py-2 flex items-center justify-between gap-2 border-l-2 transition-colors ${
                    selected === t.name ? "bg-[#00d4ff0d] border-[#00d4ff] text-[#00d4ff]" : "border-transparent text-[#8892a4] hover:bg-[#0f1629] hover:text-[#e2e8f0]"
                  }`}
                >
                  <span className="text-xs font-mono truncate">{t.name}</span>
                  {!t.error && <span className="text-[10px] text-[#4a5568] flex-shrink-0">{t.row_count.toLocaleString()}</span>}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      {view === "permissions" ? (
        <PermissionsPanel />
      ) : (
      /* Grid */
      <div className="flex-1 flex flex-col min-w-0">
        <div className="h-14 flex-shrink-0 flex items-center justify-between px-4 border-b border-[#1e2d47]">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-[#e2e8f0] font-mono truncate">{selected ?? "Select a table"}</span>
            {selectedInfo && !selectedInfo.error && (
              <Badge variant="gray">{selectedInfo.row_count.toLocaleString()} rows</Badge>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button variant="ghost" size="sm" onClick={refresh} title="Refresh">
              <RefreshCw size={13} />
            </Button>
            {selected && (
              <Button variant="primary" size="sm" onClick={() => { setShowAddForm(true); setNewRowValues({}); setActionError(null); }} disabled={showAddForm}>
                <Plus size={13} /> Insert row
              </Button>
            )}
          </div>
        </div>

        {actionError && <p className="text-xs text-[#ff5252] px-4 py-2 bg-[#ff525211] border-b border-[#ff525233]">{actionError}</p>}

        {!selected && (
          <div className="flex-1 flex items-center justify-center text-sm text-[#4a5568]">Pick a table on the left to view its rows.</div>
        )}

        {selected && loadingRows && <div className="flex-1 flex items-center justify-center text-sm text-[#4a5568]">Loading…</div>}
        {selected && rowsError && <div className="flex-1 flex items-center justify-center text-sm text-[#ff5252]">{rowsError}</div>}

        {selected && rows && !loadingRows && (
          <>
            <div className="flex-1 overflow-auto">
              <table className="w-full text-sm border-collapse">
                <thead className="sticky top-0 bg-[#0a0e1a] z-10">
                  <tr className="border-b border-[#1e2d47]">
                    {rows.columns.map((c) => {
                      const col = selectedInfo?.columns.find((sc) => sc.name === c);
                      return (
                        <th key={c} className="px-4 py-2.5 text-left align-bottom">
                          <div className="text-xs font-medium text-[#e2e8f0] font-mono">{c}</div>
                          {col && <div className="text-[10px] text-[#4a5568] font-mono mt-0.5">{typeBadge(col.data_type)}</div>}
                        </th>
                      );
                    })}
                    <th className="px-4 py-2.5 w-20" />
                  </tr>
                </thead>
                <tbody>
                  {showAddForm && (
                    <tr className="border-b border-[#1e2d47] bg-[#00d4ff08]">
                      {rows.columns.map((c, i) => (
                        <td key={c} className="px-2 py-2">
                          <Input
                            ref={i === 0 ? firstFieldRef : undefined}
                            value={cellToInput(newRowValues[c] ?? null)}
                            onChange={(e) => setNewRowValues((v) => ({ ...v, [c]: inputToCell(e.target.value) }))}
                            placeholder="null"
                            className="text-xs h-8"
                          />
                        </td>
                      ))}
                      <td className="px-2 py-2 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={submitNewRow} disabled={busy} title="Save" className="p-1.5 rounded text-[#00e676] hover:bg-[#00e67622]"><Check size={14} /></button>
                          <button onClick={() => setShowAddForm(false)} disabled={busy} title="Cancel" className="p-1.5 rounded text-[#4a5568] hover:bg-[#1a2236] hover:text-[#e2e8f0]"><X size={14} /></button>
                        </div>
                      </td>
                    </tr>
                  )}
                  {rows.rows.length === 0 && !showAddForm && (
                    <tr>
                      <td colSpan={rows.columns.length + 1} className="px-4 py-8 text-center text-xs text-[#4a5568]">No rows.</td>
                    </tr>
                  )}
                  {rows.rows.map((row, i) => (
                    <tr key={i} className="border-b border-[#162035] hover:bg-[#0f1629] transition-colors group">
                      {editingRow === i ? (
                        rows.columns.map((c) => (
                          <td key={c} className="px-2 py-2">
                            <Input
                              value={cellToInput(editValues[c] ?? null)}
                              onChange={(e) => setEditValues((v) => ({ ...v, [c]: inputToCell(e.target.value) }))}
                              placeholder="null"
                              className="text-xs h-8"
                            />
                          </td>
                        ))
                      ) : (
                        row.map((cell, j) => (
                          <td
                            key={j}
                            onClick={() => startEdit(i)}
                            className="px-4 py-2 text-[#e2e8f0] font-mono text-xs cursor-text truncate max-w-xs"
                            title={cell ?? undefined}
                          >
                            {cell === null ? <NullCell /> : cell}
                          </td>
                        ))
                      )}
                      <td className="px-2 py-2 text-right whitespace-nowrap">
                        {editingRow === i ? (
                          <div className="flex items-center justify-end gap-1">
                            <button onClick={() => saveEdit(i)} disabled={busy} title="Save" className="p-1.5 rounded text-[#00e676] hover:bg-[#00e67622]"><Check size={14} /></button>
                            <button onClick={() => setEditingRow(null)} disabled={busy} title="Cancel" className="p-1.5 rounded text-[#4a5568] hover:bg-[#1a2236] hover:text-[#e2e8f0]"><X size={14} /></button>
                          </div>
                        ) : confirmingDelete === i ? (
                          <div className="flex items-center justify-end gap-1.5">
                            <span className="text-[10px] text-[#ff5252]">Sure?</span>
                            <button onClick={() => confirmDelete(i)} disabled={busy} title="Confirm delete" className="p-1.5 rounded text-[#ff5252] hover:bg-[#ff525222]"><Check size={14} /></button>
                            <button onClick={() => setConfirmingDelete(null)} disabled={busy} title="Cancel" className="p-1.5 rounded text-[#4a5568] hover:bg-[#1a2236] hover:text-[#e2e8f0]"><X size={14} /></button>
                          </div>
                        ) : (
                          <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                            <button onClick={() => startEdit(i)} title="Edit row" className="p-1.5 rounded text-[#4a5568] hover:bg-[#1a2236] hover:text-[#00d4ff]"><Pencil size={13} /></button>
                            <button onClick={() => { setConfirmingDelete(i); setEditingRow(null); }} title="Delete row" className="p-1.5 rounded text-[#4a5568] hover:bg-[#1a2236] hover:text-[#ff5252]"><Trash2 size={13} /></button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="h-11 flex-shrink-0 flex items-center justify-between px-4 border-t border-[#1e2d47] text-xs text-[#4a5568]">
              <span>
                {rows.rows.length === 0 ? "0 rows" : `${offset + 1}–${offset + rows.rows.length}`}
                {selectedInfo && !selectedInfo.error ? ` of ${selectedInfo.row_count.toLocaleString()}` : ""}
              </span>
              <div className="flex items-center gap-1">
                <button onClick={() => setOffset((o) => Math.max(0, o - PAGE_SIZE))} disabled={offset === 0} className="p-1 rounded disabled:opacity-30 hover:text-[#e2e8f0]">
                  <ChevronLeft size={15} />
                </button>
                <button onClick={() => setOffset((o) => o + PAGE_SIZE)} disabled={rows.rows.length < PAGE_SIZE} className="p-1 rounded disabled:opacity-30 hover:text-[#e2e8f0]">
                  <ChevronRight size={15} />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
      )}
    </div>
  );
}
