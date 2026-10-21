import { Columns3, Rows3, Table2 } from 'lucide-react';
import { Link } from 'react-router';
import type { Sheet } from '@/lib/types';
import { formatCount, formatRelativeTime } from '@/lib/utils/format';
import { FavoriteButton } from './FavoriteButton';

/** Ported from components/sheets/SheetCard.svelte. `<a href>` becomes React Router's `<Link>`. */
export function SheetCard({ sheet }: { sheet: Sheet }) {
	return (
		<Link
			to={`/sheets/${sheet.id}`}
			className="group relative flex flex-col gap-4 rounded-xl border bg-card p-5 shadow-xs transition-all hover:-translate-y-px hover:border-zinc-300 hover:shadow-md"
		>
			<div className="flex items-start gap-3">
				<div className="grid size-10 shrink-0 place-items-center rounded-lg bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/10">
					<Table2 className="size-5" />
				</div>
				<div className="min-w-0 flex-1 pr-8">
					<div className="flex items-center gap-2">
						<h2 className="truncate font-semibold group-hover:underline">{sheet.name}</h2>
						{sheet.source === 'local' ? (
							<span
								className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-1.5 text-[10px] font-medium uppercase tracking-wide text-emerald-700"
								title="Stored in this browser; editable"
							>
								Local
							</span>
						) : sheet.source === 'icp' ? (
							<span
								className="shrink-0 rounded-full border border-violet-200 bg-violet-50 px-1.5 text-[10px] font-medium uppercase tracking-wide text-violet-700"
								title="Stored on the icp_backend canister; editable"
							>
								ICP
							</span>
						) : null}
					</div>
					{sheet.description && <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">{sheet.description}</p>}
				</div>
				<FavoriteButton sheetId={sheet.id} className="absolute top-3 right-3" />
			</div>

			<div className="mt-auto flex items-center gap-4 text-xs text-muted-foreground">
				<span className="flex items-center gap-1.5 tabular-nums">
					<Rows3 className="size-3.5" />
					{formatCount(sheet.row_count)} rows
				</span>
				<span className="flex items-center gap-1.5 tabular-nums">
					<Columns3 className="size-3.5" />
					{sheet.column_count} columns
				</span>
				<span className="ml-auto" title={new Date(sheet.updated_at).toLocaleString()}>
					Updated {formatRelativeTime(sheet.updated_at)}
				</span>
			</div>
		</Link>
	);
}
