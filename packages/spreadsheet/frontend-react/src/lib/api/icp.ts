/**
 * Thin wrapper around the generated `icp_backend` actor: creates it once
 * (lazily, from the canister id + root key the asset canister — or the dev
 * server, see `vite.config.ts` — serves via the `ic_env` cookie), converts
 * its `Result` variants into resolved values or thrown errors, and narrows
 * candid's `bigint` counts to plain numbers. `icp-adapter.ts` is the only
 * caller; it owns everything about *what* the JSON blobs here mean.
 */
import { safeGetCanisterEnv } from '@icp-sdk/core/agent/canister-env';
import { createActor, type Icp_backend, type Sheet as CandidSheet } from '../../bindings/icp_backend';

interface CanisterEnv {
	readonly 'PUBLIC_CANISTER_ID:icp_backend'?: string;
}

export interface IcpSheet {
	id: string;
	name: string;
	description: string | null;
	created_at: string;
	updated_at: string;
	row_count: number;
	column_count: number;
}

export interface IcpColumn {
	id: string;
	key: string;
	name: string;
	data_type: string;
	position: number;
	settings_json: string;
}

export interface IcpRow {
	id: string;
	data_json: string;
}

export interface IcpNewColumn {
	id: string;
	key: string;
	name: string;
	data_type: string;
	settings_json: string;
}

export interface IcpColumnEdit {
	name: string;
	data_type: string;
	settings_json: string;
}

export interface IcpRowDataUpdate {
	row_id: string;
	data_json: string;
}

/** Where `icpInsertRows` places its new rows. */
export type IcpInsertPosition = { start: true } | { end: true } | { after: string };

function toCandidInsertPosition(position: IcpInsertPosition) {
	if ('start' in position) return { __kind__: 'Start' as const, Start: null };
	if ('after' in position) return { __kind__: 'After' as const, After: position.after };
	return { __kind__: 'End' as const, End: null };
}

/** No canister id was served (this deployment isn't running on the IC, or the dev server can't reach `icp_backend`). */
export class IcpUnavailableError extends Error {
	constructor() {
		super('This deployment has no ICP canister backend configured.');
		this.name = 'IcpUnavailableError';
	}
}

let cachedActor: Icp_backend | null | undefined;

function actor(): Icp_backend | null {
	if (cachedActor !== undefined) return cachedActor;
	const env = safeGetCanisterEnv<CanisterEnv>();
	const canisterId = env?.['PUBLIC_CANISTER_ID:icp_backend'];
	cachedActor = canisterId ? createActor(canisterId, { agentOptions: { rootKey: env?.IC_ROOT_KEY } }) : null;
	return cachedActor;
}

/** Whether this deployment can reach an ICP canister backend at all. */
export function icpAvailable(): boolean {
	return actor() !== null;
}

function requireActor(): Icp_backend {
	const found = actor();
	if (!found) throw new IcpUnavailableError();
	return found;
}

function unwrap<T>(result: { __kind__: 'Ok'; Ok: T } | { __kind__: 'Err'; Err: string }): T {
	if (result.__kind__ === 'Err') throw new Error(result.Err);
	return result.Ok;
}

const fromCandidSheet = (sheet: CandidSheet): IcpSheet => ({
	id: sheet.id,
	name: sheet.name,
	description: sheet.description ?? null,
	created_at: sheet.created_at,
	updated_at: sheet.updated_at,
	row_count: Number(sheet.row_count),
	column_count: Number(sheet.column_count)
});

// -- Reads ------------------------------------------------------------------------------

export async function icpListSheets(): Promise<IcpSheet[]> {
	return (await requireActor().list_sheets()).map(fromCandidSheet);
}

export async function icpGetSheet(sheetId: string): Promise<IcpSheet> {
	return fromCandidSheet(unwrap(await requireActor().get_sheet(sheetId)));
}

export async function icpListColumns(sheetId: string): Promise<IcpColumn[]> {
	return unwrap(await requireActor().list_columns(sheetId));
}

/** Every row in the sheet; pagination, filtering, sorting and column projection all happen in `icp-adapter.ts`. */
export async function icpListRows(sheetId: string): Promise<IcpRow[]> {
	return unwrap(await requireActor().list_rows(sheetId));
}

export async function icpGetRow(sheetId: string, rowId: string): Promise<IcpRow> {
	return unwrap(await requireActor().get_row(sheetId, rowId));
}

// -- Writes -----------------------------------------------------------------------------

export async function icpCreateSheet(name: string, description: string | null, columns: IcpNewColumn[]): Promise<IcpSheet> {
	return fromCandidSheet(unwrap(await requireActor().create_sheet(name, description, columns)));
}

export async function icpDeleteSheet(sheetId: string): Promise<void> {
	unwrap(await requireActor().delete_sheet(sheetId));
}

export async function icpAddColumn(sheetId: string, column: IcpNewColumn, afterKey: string | null): Promise<IcpColumn> {
	return unwrap(await requireActor().add_column(sheetId, column, afterKey));
}

export async function icpUpdateColumn(sheetId: string, columnKey: string, edit: IcpColumnEdit): Promise<IcpColumn> {
	return unwrap(await requireActor().update_column(sheetId, columnKey, edit));
}

export async function icpDeleteColumn(sheetId: string, columnKey: string): Promise<IcpColumn> {
	return unwrap(await requireActor().delete_column(sheetId, columnKey));
}

/** Each update replaces one row's entire data blob — merge cell edits into it before calling this. */
export async function icpUpdateCells(sheetId: string, updates: IcpRowDataUpdate[]): Promise<void> {
	unwrap(await requireActor().update_cells(sheetId, updates));
}

export async function icpInsertRows(sheetId: string, rowsData: string[], position: IcpInsertPosition): Promise<IcpRow[]> {
	return unwrap(await requireActor().insert_rows(sheetId, rowsData, toCandidInsertPosition(position)));
}

export async function icpDeleteRows(sheetId: string, rowIds: string[]): Promise<void> {
	unwrap(await requireActor().delete_rows(sheetId, rowIds));
}
