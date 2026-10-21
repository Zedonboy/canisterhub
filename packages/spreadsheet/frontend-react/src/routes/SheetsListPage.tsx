import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Search, Sparkles, Star } from 'lucide-react';
import { useState } from 'react';
import { ErrorState } from '@/components/common/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { CreateSheetDialog } from '@/components/sheets/CreateSheetDialog';
import { SheetCard } from '@/components/sheets/SheetCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { createDemoSheets } from '@/lib/ai/demo-sheets';
import { queryKeys } from '@/lib/queries/keys';
import { sheetsQueryOptions } from '@/lib/queries/sheets';
import { sheetRepository } from '@/lib/storage';
import { useFavoritesStore } from '@/stores/favorites';
import { usePreferencesStore } from '@/stores/preferences';
import { cn } from '@/lib/utils';

/** Ported from routes/sheets/+page.svelte. */
export function SheetsListPage() {
	const sheetSource = usePreferencesStore((state) => state.sheetSource);
	const setSheetSource = usePreferencesStore((state) => state.setSheetSource);
	const favoriteIds = useFavoritesStore((state) => state.ids);

	const sheets = useQuery(sheetsQueryOptions(sheetSource));
	const queryClient = useQueryClient();

	const [demoStatus, setDemoStatus] = useState<string | null>(null);
	const [addingDemo, setAddingDemo] = useState(false);

	async function addDemoSheets() {
		setAddingDemo(true);
		try {
			const created = await createDemoSheets();
			setSheetSource('local');
			await queryClient.invalidateQueries({ queryKey: queryKeys.sheetList() });
			setDemoStatus(
				created.length
					? `Added ${created.length} AI demo ${created.length === 1 ? 'sheet' : 'sheets'} with messy data to try the AI features on.`
					: 'The AI demo sheets are already here.'
			);
		} catch (error) {
			setDemoStatus(`Could not add the demo sheets: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			setAddingDemo(false);
		}
	}

	const [filter, setFilter] = useState('');
	const [pinnedOnly, setPinnedOnly] = useState(false);
	const [createOpen, setCreateOpen] = useState(false);

	const needle = filter.trim().toLowerCase();
	const visible = (sheets.data ?? [])
		.filter((sheet) => !pinnedOnly || favoriteIds.has(sheet.id))
		.filter((sheet) => !needle || sheet.name.toLowerCase().includes(needle) || (sheet.description ?? '').toLowerCase().includes(needle))
		.sort((a, b) => Number(favoriteIds.has(b.id)) - Number(favoriteIds.has(a.id)));

	return (
		<div className="flex-1 overflow-auto">
			<PageHeader
				title="Sheets"
				description={
					sheetSource === 'server'
						? 'Showing server sheets, read from PostgreSQL. They are view only.'
						: sheetSource === 'icp'
							? 'Showing sheets stored on the icp_backend canister. They are fully editable.'
							: 'Showing sheets stored in this browser. They are fully editable.'
				}
				actions={
					<>
						<div className="relative">
							<Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter sheets" className="h-9 w-60 pl-8" aria-label="Filter sheets" />
						</div>
						<Button
							variant="outline"
							size="sm"
							className={cn('h-9', pinnedOnly && 'bg-muted')}
							aria-pressed={pinnedOnly}
							onClick={() => setPinnedOnly((current) => !current)}
						>
							<Star className={cn('size-4', pinnedOnly && 'fill-amber-400 text-amber-400')} />
							Pinned
						</Button>
						<Button variant="outline" size="icon" className="size-9" onClick={() => sheets.refetch()} aria-label="Refresh sheets">
							<RefreshCw className={cn('size-4', sheets.isFetching && 'animate-spin')} />
						</Button>
						{sheetSource === 'local' && (
							<Button variant="outline" size="sm" className="h-9" disabled={addingDemo} onClick={addDemoSheets}>
								<Sparkles className="size-4 text-violet-600" />
								{addingDemo ? 'Adding…' : 'AI demo sheets'}
							</Button>
						)}
						{sheetRepository.canCreateSheets && (
							<Button size="sm" className="h-9" onClick={() => setCreateOpen(true)}>
								<Plus className="size-4" />
								New sheet
							</Button>
						)}
					</>
				}
			/>

			<CreateSheetDialog open={createOpen} onOpenChange={setCreateOpen} />

			{demoStatus && (
				<div className="mx-auto max-w-6xl px-8 pt-5">
					<p className="rounded-md border border-violet-200 bg-violet-50 px-3 py-2 text-sm text-violet-800" role="status">
						{demoStatus}
					</p>
				</div>
			)}

			<div className="mx-auto max-w-6xl px-8 py-6">
				{sheets.isPending ? (
					<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
						{[0, 1, 2, 3, 4, 5].map((i) => (
							<div key={i} className="flex flex-col gap-4 rounded-xl border p-5">
								<div className="flex gap-3">
									<Skeleton className="size-10 rounded-lg" />
									<div className="flex flex-1 flex-col gap-2">
										<Skeleton className="h-4 w-2/3" />
										<Skeleton className="h-3 w-full" />
									</div>
								</div>
								<Skeleton className="h-3 w-1/2" />
							</div>
						))}
					</div>
				) : sheets.isError ? (
					<div className="rounded-xl border">
						<ErrorState title="Could not load sheets" error={sheets.error} onRetry={() => sheets.refetch()} />
					</div>
				) : visible.length === 0 ? (
					<div className="rounded-xl border border-dashed px-6 py-16 text-center text-sm text-muted-foreground">
						{(sheets.data ?? []).length > 0 ? (
							'No sheets match your filter.'
						) : sheetSource === 'server' ? (
							'No server sheets yet. Run the backend seed script to load demo data, or switch to Local in the sidebar.'
						) : (
							<>
								No sheets yet. Use <span className="font-medium text-foreground">New sheet</span> to create one.
							</>
						)}
					</div>
				) : (
					<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
						{visible.map((sheet) => (
							<SheetCard key={sheet.id} sheet={sheet} />
						))}
					</div>
				)}
			</div>
		</div>
	);
}
