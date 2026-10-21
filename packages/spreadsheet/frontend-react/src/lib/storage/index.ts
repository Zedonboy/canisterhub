import { HttpSheetAdapter } from './http-adapter';
import { IcpSheetAdapter } from './icp-adapter';
import { LocalStorageSheetAdapter } from './local-adapter';
import { SheetRepository } from './sheet-repository';

export * from './types';
export { SheetRepository } from './sheet-repository';

/**
 * Storage wiring. All three adapters are always created — the local one
 * needs no backend, the HTTP one is only ever queried when the user picks
 * "Server" (see `preferences.sheetSource`), and the ICP one similarly only
 * when "ICP" is picked (and degrades to an empty list, not an error, when
 * this deployment has no canister configured — see `IcpSheetAdapter.listSheets`)
 * — so local-only use makes no network calls at all.
 *
 * New sheets are always created locally for now; pass `source: 'server'` or
 * `'icp'` to `sheetRepository.createSheet` to create elsewhere (the server
 * adapter is read-only, so only `'icp'` actually accepts it today).
 */
export const sheetRepository = new SheetRepository(
	[new LocalStorageSheetAdapter(), new HttpSheetAdapter(), new IcpSheetAdapter()],
	'local'
);
