import '@glideapps/glide-data-grid/dist/index.css';
import type { Highlight } from '@glideapps/glide-data-grid';
import { useSheetGridController } from '@/lib/grid/use-sheet-grid-controller';
import { SheetGridView } from '@/lib/grid/react/SheetGridView';
import type { SheetGridController } from '@/lib/grid/sheet-grid-controller';
import { useIsDark } from '@/stores/theme';

/**
 * Ported from components/sheet-viewer/SheetGrid.svelte. The Svelte version
 * had to manually mount a React tree into a plain DOM node (`mountSheetGrid`
 * / `mount.ts`) because Glide is React-only; in a React app `SheetGridView`
 * is just a normal component, so that whole bridge (`mount.ts`, and this
 * component's own `$effect`-driven prop-pushing) is gone. This file is now
 * a thin prop-mapping wrapper, not a bridge.
 */
export function SheetGrid({
	controller,
	rowCount,
	rowHeight,
	highlightRegions
}: {
	controller: SheetGridController;
	rowCount: number;
	rowHeight: number;
	highlightRegions: Highlight[];
}) {
	const live = useSheetGridController(controller);
	const dark = useIsDark();

	return (
		<div className="silver-grid absolute inset-0">
			<SheetGridView
				controller={live}
				columns={live.gridColumns}
				freezeColumns={live.freezeColumns}
				rowCount={rowCount}
				rowHeight={rowHeight}
				highlightRegions={highlightRegions}
				editable={live.editable}
				dark={dark}
			/>
		</div>
	);
}
