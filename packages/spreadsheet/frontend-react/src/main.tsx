import { QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { createAppQueryClient } from '@/lib/queries/query-client';
import { useThemeStore } from '@/stores/theme';
import './index.css';
import './styles/silver.css';
import { router } from './router';

/** Ported from src/routes/+layout.svelte + +layout.ts. Title/favicon moved to index.html (see Phase 0). */
const queryClient = createAppQueryClient();

function Root() {
	const mode = useThemeStore((state) => state.mode);
	const systemDark = useThemeStore((state) => state.systemDark);
	const apply = useThemeStore((state) => state.apply);

	// Keep <html class="dark"> in sync with the chosen mode and, for "system", the OS setting.
	useEffect(() => apply(), [mode, systemDark, apply]);

	return (
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	);
}

createRoot(document.getElementById('root')!).render(
	<StrictMode>
		<Root />
	</StrictMode>
);
