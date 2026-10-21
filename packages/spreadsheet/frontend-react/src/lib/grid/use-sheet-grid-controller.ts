import { useSyncExternalStore } from 'react';
import type { SheetGridController } from './sheet-grid-controller';

/**
 * React binding for SheetGridController (Phase 5, per the migration plan —
 * the plain-TS port itself was deferred here from Phase 2). Re-renders the
 * calling component whenever any of the controller's reactive fields change
 * (gridColumns, selected, selectedRowIds, selectedColumnKeys, editable,
 * contextMenu, freezeColumns) — read them directly off the returned
 * instance, same as the Svelte version read `controller.selected` etc.
 * directly in a template.
 */
export function useSheetGridController(controller: SheetGridController): SheetGridController {
	useSyncExternalStore(
		(onChange) => controller.subscribeToChanges(onChange),
		() => controller.getVersion()
	);
	return controller;
}
