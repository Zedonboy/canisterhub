import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Sheet as SheetPanel, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AI_MONTHLY_CREDITS, remainingCredits, useAiActivityStore } from '@/stores/ai-activity';
import type { SheetEditor } from '@/lib/editing/sheet-editor';
import type { Column, Sheet } from '@/lib/types';
import { MockAiBadge } from './MockAiBadge';
import { ActivityTab } from './tabs/ActivityTab';
import { AskTab } from './tabs/AskTab';
import { AuditTab } from './tabs/AuditTab';
import { ChangesTab } from './tabs/ChangesTab';
import { ExplainTab } from './tabs/ExplainTab';
import { InsightsTab } from './tabs/InsightsTab';
import { ReconcileTab } from './tabs/ReconcileTab';
import { ReportTab } from './tabs/ReportTab';

const TABS = [
	{ value: 'ask', label: 'Ask' },
	{ value: 'explain', label: 'Explain' },
	{ value: 'audit', label: 'Audit' },
	{ value: 'insights', label: 'Insights' },
	{ value: 'report', label: 'Report' },
	{ value: 'changes', label: 'Changes' },
	{ value: 'reconcile', label: 'Reconcile' },
	{ value: 'activity', label: 'Activity' }
];

/**
 * Ported from components/ai/AiPanel.svelte. `bind:open` becomes a controlled
 * `open`/`onOpenChange` pair. Every tab stays mounted (plain `hidden` divs,
 * not Radix `TabsContent`'s own mount-on-select) so an answer or report
 * isn't lost when switching tabs — same as the Svelte original.
 */
export function AiPanel({
	open,
	onOpenChange,
	sheet,
	columns,
	editor,
	onRevealRow,
	onApplied
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	sheet: Sheet;
	columns: Column[];
	editor: SheetEditor | null;
	onRevealRow: (position: number, columnKey?: string) => void;
	onApplied: (message: string) => void;
}) {
	const [tab, setTab] = useState('ask');
	const entries = useAiActivityStore((state) => state.entries);
	const remaining = remainingCredits(entries);

	return (
		<SheetPanel open={open} onOpenChange={onOpenChange}>
			<SheetContent side="right" className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
				<SheetHeader className="gap-1 border-b px-5 py-4">
					<div className="flex items-center gap-2 pr-8">
						<Sparkles className="size-4 text-violet-600" />
						<SheetTitle>AI assistant</SheetTitle>
						<MockAiBadge />
					</div>
					<SheetDescription className="flex flex-wrap items-center gap-x-2 text-xs">
						<span className="max-w-60 truncate">{sheet.name}</span>
						<span aria-hidden="true">·</span>
						<span className="tabular-nums">
							{remaining} of {AI_MONTHLY_CREDITS} credits left this month
						</span>
						{!editor && (
							<>
								<span aria-hidden="true">·</span>
								<span>View only: AI can read this sheet but not change it</span>
							</>
						)}
					</SheetDescription>
				</SheetHeader>

				<Tabs value={tab} onValueChange={setTab} className="flex min-h-0 flex-1 flex-col gap-0">
					<div className="overflow-x-auto border-b px-4 py-2">
						<TabsList className="w-max">
							{TABS.map((item) => (
								<TabsTrigger key={item.value} value={item.value} className="px-2.5 text-xs">
									{item.label}
								</TabsTrigger>
							))}
						</TabsList>
					</div>

					<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
						<div role="tabpanel" hidden={tab !== 'ask'}>
							<AskTab sheet={sheet} columns={columns} onRevealRow={onRevealRow} />
						</div>
						<div role="tabpanel" hidden={tab !== 'explain'}>
							<ExplainTab sheet={sheet} columns={columns} />
						</div>
						<div role="tabpanel" hidden={tab !== 'audit'}>
							<AuditTab sheet={sheet} columns={columns} editor={editor} onRevealRow={onRevealRow} onApplied={onApplied} />
						</div>
						<div role="tabpanel" hidden={tab !== 'insights'}>
							<InsightsTab sheet={sheet} columns={columns} onRevealRow={onRevealRow} />
						</div>
						<div role="tabpanel" hidden={tab !== 'report'}>
							<ReportTab sheet={sheet} columns={columns} />
						</div>
						<div role="tabpanel" hidden={tab !== 'changes'}>
							<ChangesTab sheet={sheet} />
						</div>
						<div role="tabpanel" hidden={tab !== 'reconcile'}>
							<ReconcileTab sheet={sheet} columns={columns} editor={editor} onRevealRow={onRevealRow} onApplied={onApplied} />
						</div>
						<div role="tabpanel" hidden={tab !== 'activity'}>
							<ActivityTab />
						</div>
					</div>
				</Tabs>
			</SheetContent>
		</SheetPanel>
	);
}
