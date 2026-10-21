import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select';
import { COLUMN_TYPE_GROUPS, columnTypeLabel } from '@/lib/storage/sheet-schema';
import type { KnownColumnType } from '@/lib/types';
import { cn } from '@/lib/utils';

/**
 * Ported from components/sheets/ColumnTypeSelect.svelte. Svelte's
 * `Select.GroupHeading` is this kit's `SelectLabel`; `Select.Root`'s
 * `type="single"` has no React equivalent needed (Radix's Select is
 * single-value by default, multi-value isn't a variant here).
 */
export function ColumnTypeSelect({
	value,
	onChange,
	ariaLabel = 'Column type',
	className
}: {
	value: KnownColumnType;
	onChange: (type: KnownColumnType) => void;
	ariaLabel?: string;
	className?: string;
}) {
	return (
		<Select value={value} onValueChange={(next) => onChange(next as KnownColumnType)}>
			<SelectTrigger className={cn('h-8 w-36', className)} aria-label={ariaLabel}>
				<SelectValue>{columnTypeLabel(value)}</SelectValue>
			</SelectTrigger>
			<SelectContent className="max-h-80">
				{COLUMN_TYPE_GROUPS.map((group) => (
					<SelectGroup key={group.label}>
						<SelectLabel>{group.label}</SelectLabel>
						{group.types.map((type) => (
							<SelectItem key={type.value} value={type.value}>
								<span>{type.label}</span>
								<span className="ml-auto pl-3 text-xs text-muted-foreground">{type.hint}</span>
							</SelectItem>
						))}
					</SelectGroup>
				))}
			</SelectContent>
		</Select>
	);
}
