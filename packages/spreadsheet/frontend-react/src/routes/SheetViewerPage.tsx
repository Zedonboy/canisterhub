import { useParams } from 'react-router';
import { SheetViewer } from '@/components/sheet-viewer/SheetViewer';

/** Ported from routes/sheets/[sheetId]/+page.svelte. `{#key sheetId}` becomes a `key` prop, forcing a remount on id change. */
export function SheetViewerPage() {
	const { sheetId } = useParams();
	return <SheetViewer key={sheetId} sheetId={sheetId ?? ''} />;
}
