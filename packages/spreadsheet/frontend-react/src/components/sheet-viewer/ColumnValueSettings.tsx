import type { ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { KnownColumnType } from '@/lib/types';

const PLACEHOLDERS: Partial<Record<KnownColumnType, string>> = {
	number: 'e.g. 0',
	currency: 'e.g. 100',
	date: 'e.g. 2026-10-01',
	boolean: 'true or false',
	enum: 'One of the options',
	bubble: 'Tags, comma separated',
	uri: 'https://example.com',
	image: 'Image URLs, comma separated',
	drilldown: 'Label | image URL',
	markdown: 'Markdown text'
};

/** Ported from components/sheet-viewer/ColumnValueSettings.svelte. `bind:` props become controlled value/onChange pairs. */
export function ColumnValueSettings({
	type,
	idPrefix,
	defaultInput = '',
	onDefaultInputChange,
	formulaEnabled = false,
	onFormulaEnabledChange,
	formula = '',
	onFormulaChange,
	defaultHint,
	formulaNote
}: {
	type: KnownColumnType;
	idPrefix: string;
	defaultInput?: string;
	onDefaultInputChange: (value: string) => void;
	formulaEnabled?: boolean;
	onFormulaEnabledChange: (value: boolean) => void;
	formula?: string;
	onFormulaChange: (value: string) => void;
	/** Explains when the default applies (differs for new vs existing columns). */
	defaultHint: string;
	/** Extra content under the formula field (e.g. overwrite warning). */
	formulaNote?: ReactNode;
}) {
	return (
		<fieldset className="grid gap-3 rounded-lg border p-3">
			<legend className="px-1 text-sm font-medium">Values</legend>

			<label className="flex cursor-pointer items-start gap-2.5 text-sm">
				<input
					type="checkbox"
					checked={formulaEnabled}
					onChange={(event) => onFormulaEnabledChange(event.target.checked)}
					className="mt-0.5 size-4 accent-blue-600"
				/>
				<span>
					<span className="font-medium">Column formula</span>
					<span className="block text-xs text-muted-foreground">Calculate every cell in this column with one formula. Cells can't be edited individually.</span>
				</span>
			</label>

			{formulaEnabled ? (
				<div className="grid gap-1.5">
					<Input
						id={`${idPrefix}-formula`}
						value={formula}
						onChange={(event) => onFormulaChange(event.target.value)}
						placeholder="=[Quantity] * [Unit Price]"
						className="h-8 font-mono text-xs"
						spellCheck="false"
						aria-label="Column formula"
					/>
					<p className="text-xs text-muted-foreground">
						Reference other columns by name, e.g. <code className="font-mono">[Quantity]</code> for the same row.
					</p>
					{formulaNote}
				</div>
			) : (
				<div className="grid gap-1.5">
					<Label htmlFor={`${idPrefix}-default`}>
						Default value <span className="font-normal text-muted-foreground">(optional)</span>
					</Label>
					<Input
						id={`${idPrefix}-default`}
						value={defaultInput}
						onChange={(event) => onDefaultInputChange(event.target.value)}
						placeholder={PLACEHOLDERS[type] ?? 'Value for new rows'}
						className="h-8"
					/>
					<p className="text-xs text-muted-foreground">{defaultHint}</p>
				</div>
			)}
		</fieldset>
	);
}
