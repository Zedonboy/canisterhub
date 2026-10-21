import { Sparkles } from 'lucide-react';
import { ai } from '@/lib/ai/provider';
import { cn } from '@/lib/utils';

/** Ported from components/ai/MockAiBadge.svelte. */
export function MockAiBadge({ className }: { className?: string }) {
	return (
		<span
			className={cn(
				'inline-flex shrink-0 items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700',
				className
			)}
			title={ai.mock ? 'Results come from IntelliSheet’s built-in rules and sample logic, not a language model.' : ai.name}
		>
			<Sparkles className="size-3" />
			{ai.name}
		</span>
	);
}
