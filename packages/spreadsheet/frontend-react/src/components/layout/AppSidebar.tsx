import { useQuery } from '@tanstack/react-query';
import {
	ChartColumn,
	ChartPie,
	ClipboardList,
	Gauge,
	Globe,
	HardDrive,
	LayoutDashboard,
	Monitor,
	Moon,
	Sheet as SheetIcon,
	Sun,
	PanelLeftClose,
	PanelLeftOpen,
	Server,
	Star,
	Table2,
	type LucideIcon
} from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { icpAvailable } from '@/lib/api/icp';
import { healthQueryOptions, sheetsQueryOptions } from '@/lib/queries/sheets';
import type { SheetSource } from '@/lib/types';
import { cn } from '@/lib/utils';
import { useFavoritesStore } from '@/stores/favorites';
import { usePreferencesStore } from '@/stores/preferences';
import { THEME_OPTIONS, useThemeStore, type ThemeMode } from '@/stores/theme';

/** Ported from components/layout/AppSidebar.svelte. `$app/state`'s `page.url.pathname` becomes React Router's `useLocation().pathname`. */

interface NavItem {
	label: string;
	icon: LucideIcon;
	href?: string;
	active?: (pathname: string) => boolean;
}

const nav: NavItem[] = [
	{ label: 'Overview', icon: LayoutDashboard, href: '/', active: (p) => p === '/' },
	{ label: 'Sheets', icon: Table2, href: '/sheets', active: (p) => p.startsWith('/sheets') },
	{ label: 'Reports', icon: ChartColumn, href: '/reports', active: (p) => p.startsWith('/reports') },
	{ label: 'Charts', icon: ChartPie, href: '/charts', active: (p) => p.startsWith('/charts') },
	{ label: 'Dashboards', icon: Gauge, href: '/dashboards', active: (p) => p.startsWith('/dashboards') },
	{ label: 'Forms', icon: ClipboardList, href: '/forms', active: (p) => p.startsWith('/forms') }
];

const SOURCE_LABELS: Record<SheetSource, string> = { local: 'Local', server: 'Server', icp: 'ICP' };
const nextSource = (value: SheetSource): SheetSource => (value === 'local' ? 'server' : value === 'server' ? 'icp' : 'local');
const THEME_ICONS: Record<ThemeMode, LucideIcon> = { light: Sun, dark: Moon, system: Monitor };

export function AppSidebar() {
	const pathname = useLocation().pathname;

	const collapsed = usePreferencesStore((state) => state.sidebarCollapsed);
	const toggleSidebar = usePreferencesStore((state) => state.toggleSidebar);
	const source = usePreferencesStore((state) => state.sheetSource);
	const setSheetSource = usePreferencesStore((state) => state.setSheetSource);

	const favoriteIds = useFavoritesStore((state) => state.ids);

	const mode = useThemeStore((state) => state.mode);
	const setMode = useThemeStore((state) => state.setMode);
	const cycleTheme = useThemeStore((state) => state.cycle);

	// The API health check only runs while "Server" is selected.
	const health = useQuery({ ...healthQueryOptions(), enabled: source === 'server' });
	// Pinned sheets are drawn from whichever source is currently selected. Doubles as the
	// ICP canister's own connectivity signal (see `storageStatus`) since there's no
	// separate health endpoint for it.
	const sheets = useQuery(sheetsQueryOptions(source));
	const pinned = (sheets.data ?? []).filter((sheet) => favoriteIds.has(sheet.id));

	const shortcut = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘B' : 'Ctrl+B';
	const icpConfigured = icpAvailable();
	const storageStatus =
		source === 'server'
			? health.isSuccess
				? 'API connected'
				: health.isError
					? 'API unreachable'
					: 'Connecting…'
			: source === 'icp'
				? !icpConfigured
					? 'No ICP canister configured'
					: sheets.isSuccess
						? 'Canister connected'
						: sheets.isError
							? 'Canister unreachable'
							: 'Connecting…'
				: 'Local storage';

	const themeLabel = THEME_OPTIONS.find((option) => option.value === mode)!.label;
	const ThemeIcon = THEME_ICONS[mode];

	return (
		<aside
			id="app-sidebar"
			className={cn(
				'hidden shrink-0 flex-col overflow-hidden border-r bg-muted/30 transition-[width] duration-200 ease-out md:flex',
				collapsed ? 'w-14' : 'w-60'
			)}
			aria-label="Sidebar"
		>
			<div className={cn('flex h-14 items-center gap-2', collapsed ? 'justify-center px-2' : 'px-4')}>
				{!collapsed && (
					<Link to="/" className="flex min-w-0 items-center gap-2.5">
						<span className="relative grid size-7 shrink-0 place-items-center rounded-lg bg-foreground text-background shadow-sm">
							<SheetIcon className="size-4" />
							<span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-violet-500 ring-2 ring-muted" />
						</span>
						<span className="text-[15px] font-semibold tracking-tight">
							Intelli<span className="text-violet-600 dark:text-violet-400">Sheet</span>
						</span>
					</Link>
				)}

				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={toggleSidebar}
							className={cn(
								'grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
								!collapsed && 'ml-auto'
							)}
							aria-controls="app-sidebar"
							aria-expanded={!collapsed}
							aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
						>
							{collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
						</button>
					</TooltipTrigger>
					<TooltipContent side="right">
						{collapsed ? 'Expand sidebar' : 'Collapse sidebar'} <span className="ml-1 opacity-70">{shortcut}</span>
					</TooltipContent>
				</Tooltip>
			</div>

			<nav className={cn('flex flex-col gap-0.5 py-2', collapsed ? 'items-center px-2' : 'px-2')} aria-label="Primary">
				{nav.map((item) => {
					const active = item.active?.(pathname) ?? false;
					return (
						<Tooltip key={item.label} {...(!collapsed ? { open: false } : {})}>
							<TooltipTrigger asChild>
								{item.href ? (
									<Link
										to={item.href}
										className={cn(
											'flex h-8 items-center gap-2.5 rounded-md text-sm transition-colors',
											collapsed ? 'w-8 justify-center' : 'px-2.5',
											active
												? 'bg-background font-medium text-foreground shadow-sm ring-1 ring-border'
												: 'text-muted-foreground hover:bg-muted hover:text-foreground'
										)}
										aria-current={active ? 'page' : undefined}
										aria-label={collapsed ? item.label : undefined}
									>
										<item.icon className="size-4 shrink-0" />
										{!collapsed && item.label}
									</Link>
								) : (
									<span
										className={cn(
											'flex h-8 cursor-default items-center gap-2.5 rounded-md text-sm text-muted-foreground/60',
											collapsed ? 'w-8 justify-center' : 'px-2.5'
										)}
										aria-disabled="true"
										aria-label={collapsed ? `${item.label} (coming soon)` : undefined}
									>
										<item.icon className="size-4 shrink-0" />
										{!collapsed && (
											<>
												{item.label}
												<span className="ml-auto rounded-full border px-1.5 text-[10px] font-medium uppercase tracking-wide">
													Soon
												</span>
											</>
										)}
									</span>
								)}
							</TooltipTrigger>
							<TooltipContent side="right">{item.href ? item.label : `${item.label} · coming soon`}</TooltipContent>
						</Tooltip>
					);
				})}
			</nav>

			{pinned.length > 0 && (
				<>
					{collapsed ? (
						<div className="mx-3 my-2 border-t" />
					) : (
						<div className="px-4 pt-4 pb-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Pinned</div>
					)}
					<div className={cn('flex flex-col gap-0.5', collapsed ? 'items-center px-2' : 'px-2')}>
						{pinned.map((sheet) => {
							const active = pathname === `/sheets/${sheet.id}`;
							return (
								<Tooltip key={sheet.id} {...(!collapsed ? { open: false } : {})}>
									<TooltipTrigger asChild>
										<Link
											to={`/sheets/${sheet.id}`}
											className={cn(
												'flex h-7 items-center gap-2 truncate rounded-md text-[13px]',
												collapsed ? 'w-8 justify-center' : 'px-2.5',
												active ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
											)}
											aria-label={collapsed ? sheet.name : undefined}
										>
											<Star className="size-3.5 shrink-0 fill-amber-400 text-amber-400" />
											{!collapsed && <span className="truncate">{sheet.name}</span>}
										</Link>
									</TooltipTrigger>
									<TooltipContent side="right">{sheet.name}</TooltipContent>
								</Tooltip>
							);
						})}
					</div>
				</>
			)}

			<div
				className={cn('mt-auto border-t py-3 text-xs text-muted-foreground', collapsed ? 'flex flex-col items-center gap-1 px-2' : 'px-4')}
			>
				{collapsed ? (
					<>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={cycleTheme}
									className="grid size-8 place-items-center rounded-md hover:bg-muted hover:text-foreground"
									aria-label={`Theme: ${themeLabel}. Click to change`}
								>
									<ThemeIcon className="size-4" />
								</button>
							</TooltipTrigger>
							<TooltipContent side="right">
								Theme: {themeLabel}
								<br />
								Click to change
							</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={() => setSheetSource(nextSource(source))}
									className="grid size-8 place-items-center rounded-md hover:bg-muted"
									aria-label={`${storageStatus}. Switch to ${SOURCE_LABELS[nextSource(source)]}`}
								>
									{source === 'server' ? (
										<span className={cn('size-2 rounded-full', health.isSuccess ? 'bg-emerald-500' : health.isError ? 'bg-red-500' : 'bg-zinc-300')} />
									) : source === 'icp' ? (
										<Globe className={cn('size-4', icpConfigured && sheets.isSuccess ? 'text-violet-600' : 'text-muted-foreground')} />
									) : (
										<HardDrive className="size-4 text-emerald-600" />
									)}
								</button>
							</TooltipTrigger>
							<TooltipContent side="right">
								{storageStatus}
								{source === 'local' ? ' · sheets are saved in this browser' : ''}
								<br />
								Click to switch to {SOURCE_LABELS[nextSource(source)]}
							</TooltipContent>
						</Tooltip>
					</>
				) : (
					<>
						<div className="mb-2 grid grid-cols-3 gap-1 rounded-lg border bg-background p-1" role="group" aria-label="Theme">
							{THEME_OPTIONS.map((option) => {
								const Icon = THEME_ICONS[option.value];
								return (
									<button
										key={option.value}
										type="button"
										onClick={() => setMode(option.value)}
										aria-pressed={mode === option.value}
										title={option.value === 'system' ? 'Match your device setting' : `${option.label} theme`}
										className={cn(
											'flex items-center justify-center gap-1 rounded-md py-1 text-[11px] font-medium transition-colors',
											mode === option.value ? 'bg-muted text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
										)}
									>
										<Icon className="size-3" />
										{option.label}
									</button>
								);
							})}
						</div>
						<div className="mb-2.5 grid grid-cols-3 gap-1 rounded-lg border bg-background p-1" role="group" aria-label="Sheet source">
							<button
								type="button"
								onClick={() => setSheetSource('local')}
								aria-pressed={source === 'local'}
								className={cn(
									'flex items-center justify-center gap-1.5 rounded-md py-1 text-[11px] font-medium transition-colors',
									source === 'local' ? 'bg-muted text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
								)}
							>
								<HardDrive className="size-3" />
								Local
							</button>
							<button
								type="button"
								onClick={() => setSheetSource('server')}
								aria-pressed={source === 'server'}
								className={cn(
									'flex items-center justify-center gap-1.5 rounded-md py-1 text-[11px] font-medium transition-colors',
									source === 'server' ? 'bg-muted text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
								)}
							>
								<Server className="size-3" />
								Server
							</button>
							<button
								type="button"
								onClick={() => setSheetSource('icp')}
								aria-pressed={source === 'icp'}
								className={cn(
									'flex items-center justify-center gap-1.5 rounded-md py-1 text-[11px] font-medium transition-colors',
									source === 'icp' ? 'bg-muted text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
								)}
							>
								<Globe className="size-3" />
								ICP
							</button>
						</div>
						{source === 'server' ? (
							<>
								<div className="flex items-center gap-2">
									<span className={cn('size-2 rounded-full', health.isSuccess ? 'bg-emerald-500' : health.isError ? 'bg-red-500' : 'bg-zinc-300')} />
									{storageStatus}
								</div>
								<div className="mt-1 text-[11px]">Read-only PostgreSQL sheets</div>
							</>
						) : source === 'icp' ? (
							<>
								<div className="flex items-center gap-2">
									<span
										className={cn('size-2 rounded-full', icpConfigured && sheets.isSuccess ? 'bg-emerald-500' : sheets.isError ? 'bg-red-500' : 'bg-zinc-300')}
									/>
									{storageStatus}
								</div>
								<div className="mt-1 text-[11px]">Sheets are stored on the icp_backend canister</div>
							</>
						) : (
							<>
								<div className="flex items-center gap-2">
									<HardDrive className="size-3.5 text-emerald-600" />
									Local storage
								</div>
								<div className="mt-1 text-[11px]">Sheets are saved in this browser</div>
							</>
						)}
					</>
				)}
			</div>
		</aside>
	);
}
