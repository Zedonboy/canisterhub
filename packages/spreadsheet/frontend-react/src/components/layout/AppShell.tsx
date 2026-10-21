import { useEffect } from 'react';
import { Outlet } from 'react-router';
import { TooltipProvider } from '@/components/ui/tooltip';
import { usePreferencesStore } from '@/stores/preferences';
import { AppSidebar } from './AppSidebar';

/**
 * Ported from components/layout/AppShell.svelte. `{@render children()}`
 * becomes React Router's `<Outlet />` (this component is the root route's
 * element in router.tsx) rather than an explicit `children` prop.
 */
export function AppShell() {
	const toggleSidebar = usePreferencesStore((state) => state.toggleSidebar);

	// Ctrl/Cmd+B toggles the sidebar, except while typing in a field.
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (event.key.toLowerCase() !== 'b' || !(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
			const target = event.target;
			if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return;
			event.preventDefault();
			toggleSidebar();
		}
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, [toggleSidebar]);

	return (
		<TooltipProvider delayDuration={250}>
			<div className="flex h-screen w-full overflow-hidden bg-background text-foreground">
				<AppSidebar />
				<main className="flex min-w-0 flex-1 flex-col overflow-hidden">
					<Outlet />
				</main>
			</div>
		</TooltipProvider>
	);
}
