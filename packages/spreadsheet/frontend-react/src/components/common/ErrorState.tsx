import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** Ported from components/common/ErrorState.svelte. */
export function ErrorState({
	title = 'Something went wrong',
	error,
	onRetry
}: {
	title?: string;
	error: unknown;
	onRetry?: () => void;
}) {
	const message = error instanceof Error ? error.message : String(error);
	return (
		<div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
			<div className="grid size-10 place-items-center rounded-full bg-red-50 text-red-600">
				<TriangleAlert className="size-5" />
			</div>
			<div>
				<p className="font-medium">{title}</p>
				<p className="mt-1 max-w-md text-sm text-muted-foreground">{message}</p>
			</div>
			{onRetry && (
				<Button variant="outline" size="sm" onClick={onRetry}>
					Try again
				</Button>
			)}
		</div>
	);
}
