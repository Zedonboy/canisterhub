import { useQuery } from '@tanstack/react-query';
import { Clock, Columns3, Eye, Rows3, Star, Table2 } from 'lucide-react';
import { Link } from 'react-router';
import { ErrorState } from '@/components/common/ErrorState';
import { PageHeader } from '@/components/layout/PageHeader';
import { FavoriteButton } from '@/components/sheets/FavoriteButton';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { sheetsQueryOptions } from '@/lib/queries/sheets';
import type { Sheet } from '@/lib/types';
import { formatCount, formatRelativeTime } from '@/lib/utils/format';
import { useFavoritesStore } from '@/stores/favorites';
import { usePreferencesStore } from '@/stores/preferences';
import { useRecentSheetsStore } from '@/stores/recent-sheets';

function SheetRow({ sheet, detail }: { sheet: Sheet; detail: string }) {
	return <li className="group flex items-center gap-3 py-2"><Table2 className="size-4 shrink-0 text-muted-foreground" />
		<Link to={`/sheets/${sheet.id}`} className="min-w-0 flex-1"><span className="block truncate font-medium group-hover:underline">{sheet.name}</span><span className="block truncate text-xs text-muted-foreground">{formatCount(sheet.row_count)} rows · {detail}</span></Link>
		<FavoriteButton sheetId={sheet.id} className="shrink-0" /></li>;
}

export function OverviewPage() {
	const source = usePreferencesStore((state) => state.sheetSource);
	const favorites = useFavoritesStore((state) => state.ids);
	const entries = useRecentSheetsStore((state) => state.entries);
	const sheets = useQuery(sheetsQueryOptions(source));
	const list = sheets.data ?? [];
	const byId = new Map(list.map((sheet) => [sheet.id, sheet]));
	const opened = entries.flatMap((entry) => { const sheet = byId.get(entry.sheetId); return sheet ? [{ sheet, time: entry.openedAt }] : []; });
	const recent = opened.length ? opened.slice(0, 6).map(({ sheet, time }) => ({ sheet, detail: `opened ${formatRelativeTime(time)}` })) : [...list].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 6).map((sheet) => ({ sheet, detail: `updated ${formatRelativeTime(sheet.updated_at)}` }));
	const stats = [{ label: 'Sheets', value: list.length, icon: Table2 }, { label: 'Rows', value: list.reduce((n, s) => n + s.row_count, 0), icon: Rows3 }, { label: 'Columns', value: list.reduce((n, s) => n + s.column_count, 0), icon: Columns3 }];
	const loading = <>{[0, 1, 2].map((i) => <li key={i} className="py-3"><Skeleton className="h-5 w-full max-w-64" /></li>)}</>;
	return <div className="flex-1 overflow-auto"><PageHeader title="Overview" description="Your IntelliSheet workspace at a glance." />
		<div className="mx-auto flex max-w-6xl flex-col gap-6 px-8 py-6">
			{sheets.isError ? <Card><ErrorState title="Could not load the workspace" error={sheets.error} onRetry={() => sheets.refetch()} /></Card> : <>
				<div className="grid gap-4 sm:grid-cols-3">{stats.map((stat) => <Card key={stat.label} className="gap-2 py-5"><CardContent className="flex-row items-center justify-between"><div><p className="text-sm text-muted-foreground">{stat.label}</p>{sheets.isPending ? <Skeleton className="mt-2 h-7 w-20" /> : <p className="mt-1 text-2xl font-semibold tabular-nums">{formatCount(stat.value)}</p>}</div><stat.icon className="size-5 text-muted-foreground" /></CardContent></Card>)}</div>
				<div className="grid gap-6 lg:grid-cols-2">
					<Card id="favorites"><CardHeader><CardTitle className="flex items-center gap-2"><Star className="size-4 fill-amber-400 text-amber-400" /> Favorites</CardTitle><CardDescription>Sheets you’ve starred, saved in this browser.</CardDescription></CardHeader><CardContent><ul className="divide-y">{sheets.isPending ? loading : list.filter((s) => favorites.has(s.id)).map((s) => <SheetRow key={s.id} sheet={s} detail={`updated ${formatRelativeTime(s.updated_at)}`} />)}{!sheets.isPending && !list.some((s) => favorites.has(s.id)) && <li className="py-3 text-sm text-muted-foreground">No favorites yet. Star a sheet to keep it close.</li>}</ul></CardContent></Card>
					<Card id="recent"><CardHeader><CardTitle className="flex items-center gap-2"><Clock className="size-4" /> Recent</CardTitle><CardDescription>{opened.length ? 'Sheets you opened most recently.' : 'The latest updated sheets.'}</CardDescription></CardHeader><CardContent><ul className="divide-y">{sheets.isPending ? loading : recent.map((item) => <SheetRow key={item.sheet.id} {...item} />)}{!sheets.isPending && !recent.length && <li className="py-3 text-sm text-muted-foreground">No sheets yet.</li>}</ul></CardContent></Card>
				</div>
				<div className="flex items-start gap-3 rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground"><Eye className="mt-0.5 size-4 shrink-0" /><p>{source === 'server' ? 'Showing server sheets from PostgreSQL — view only.' : source === 'icp' ? 'Showing editable sheets stored on the ICP canister.' : 'Showing editable sheets stored in this browser.'}</p></div>
			</>}
		</div></div>;
}
