import { useQuery } from '@tanstack/react-query';
import { ClipboardList, Eye, Plus, SquarePen } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { NewFormDialog } from '@/components/forms/NewFormDialog';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { sheetsQueryOptions } from '@/lib/queries/sheets';
import { formatCount, formatRelativeTime } from '@/lib/utils/format';
import { useFormStore } from '@/stores/form-store';

export function FormsPage() {
	const [open, setOpen] = useState(false); const forms = useFormStore((s) => s.items); const sheets = useQuery(sheetsQueryOptions('local')); const sheetName = (id: string) => sheets.data?.find((s) => s.id === id)?.name ?? 'a sheet';
	return <div className="flex-1 overflow-auto"><PageHeader title="Forms" description="Collect entries one at a time. Every response adds a row to a sheet." actions={<Button size="sm" onClick={() => setOpen(true)}><Plus /> New form</Button>} /><NewFormDialog open={open} onOpenChange={setOpen} />
		<div className="mx-auto max-w-6xl px-8 py-6">{forms.length ? <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{forms.map((form) => <article key={form.id} className="grid gap-3 rounded-xl border bg-card p-5"><div className="flex gap-3"><div className="grid size-9 place-items-center rounded-lg bg-muted"><ClipboardList className="size-4" /></div><div className="min-w-0"><h2 className="truncate font-medium">{form.name}</h2><p className="truncate text-sm text-muted-foreground">Adds rows to {sheetName(form.sheetId)}</p></div></div><p className="text-xs text-muted-foreground">{form.fields.length} questions · {formatCount(form.responseCount)} responses{form.lastResponseAt ? `, latest ${formatRelativeTime(form.lastResponseAt)}` : ''}</p><div className="flex gap-2"><Button asChild size="sm"><Link to={`/forms/${form.id}`}><Eye /> Open</Link></Button><Button asChild variant="outline" size="sm"><Link to={`/forms/${form.id}/edit`}><SquarePen /> Edit</Link></Button></div></article>)}</div> : <div className="grid justify-items-start gap-3 rounded-xl border border-dashed p-8"><ClipboardList className="size-8 text-muted-foreground" /><h2 className="text-lg font-semibold">No forms yet</h2><p className="max-w-lg text-sm text-muted-foreground">Create a form from a local sheet, shape its questions, and collect validated responses directly into new rows.</p><Button onClick={() => setOpen(true)}><Plus /> New form</Button></div>}</div></div>;
}
