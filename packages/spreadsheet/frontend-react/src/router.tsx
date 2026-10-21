import { createBrowserRouter } from 'react-router';
import { AppShell } from '@/components/layout/AppShell';
import { SheetsListPage } from './routes/SheetsListPage';
import { SheetViewerPage } from './routes/SheetViewerPage';
import { OverviewPage } from './routes/OverviewPage';
import { FormsPage } from './routes/FormsPage';
import { FormPage } from './routes/FormPage';
import { FormBuilderPage } from './routes/FormBuilderPage';
import { ReportsPage } from './routes/ReportsPage';
import { ReportPage } from './routes/ReportPage';
import { ChartsPage } from './routes/ChartsPage';
import { ChartPage } from './routes/ChartPage';
import { DashboardsPage } from './routes/DashboardsPage';
import { DashboardPage } from './routes/DashboardPage';

/** React Router equivalent of the SvelteKit route tree. */
export const router = createBrowserRouter([
	{
		path: '/',
		element: <AppShell />,
		children: [
			{ index: true, element: <OverviewPage /> },
			{ path: 'sheets', element: <SheetsListPage /> },
			{ path: 'sheets/:sheetId', element: <SheetViewerPage /> },
			{ path: 'reports', element: <ReportsPage /> },
			{ path: 'reports/:reportId', element: <ReportPage /> },
			{ path: 'charts', element: <ChartsPage /> },
			{ path: 'charts/:chartId', element: <ChartPage /> },
			{ path: 'dashboards', element: <DashboardsPage /> },
			{ path: 'dashboards/:dashboardId', element: <DashboardPage /> },
			{ path: 'forms', element: <FormsPage /> },
			{ path: 'forms/:formId', element: <FormPage /> },
			{ path: 'forms/:formId/edit', element: <FormBuilderPage /> }
		]
	}
]);
