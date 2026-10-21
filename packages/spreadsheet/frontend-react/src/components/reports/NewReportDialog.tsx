import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { sheetsQueryOptions } from '@/lib/queries/sheets';
import { defaultReportColumns } from '@/lib/reports/columns';
import { loadSources } from '@/lib/reports/run-report';
import { useReportStore } from '@/stores/report-store';

export function NewReportDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (value: boolean) => void }) {
	const navigate = useNavigate(); const create = useReportStore((s) => s.create); const local = useQuery(sheetsQueryOptions('local')); const server = useQuery({ ...sheetsQueryOptions('server'), retry: false }); const sheets = [...(local.data ?? []), ...(server.data ?? [])];
	const [name,setName]=useState(''); const [description,setDescription]=useState(''); const [sources,setSources]=useState<string[]>([]); const [error,setError]=useState<string|null>(null); const [creating,setCreating]=useState(false);
	useEffect(() => { if (open) { setName(''); setDescription(''); setSources([]); setError(null); } }, [open]);
	async function submit(e: FormEvent) { e.preventDefault(); if (!name.trim()) return setError('Give the report a name.'); if (!sources.length) return setError('Pick at least one sheet.'); setCreating(true); try { const loaded = await loadSources(sources); const report = create({ name, description, sources, columns: defaultReportColumns(loaded.sources) }); onOpenChange(false); navigate(`/reports/${report.id}`); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setCreating(false); } }
	return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg"><form onSubmit={submit} className="grid gap-5"><DialogHeader><DialogTitle>New report</DialogTitle><DialogDescription>Pull live rows from one or more sheets into a saved view.</DialogDescription></DialogHeader><Input value={name} onChange={(e)=>setName(e.target.value)} placeholder="Report name" /><Textarea value={description} onChange={(e)=>setDescription(e.target.value)} placeholder="Description (optional)" />
		<div className="grid gap-2"><p className="text-sm font-medium">Sheets</p>{sheets.length ? sheets.map((sheet)=><label key={sheet.id} className="flex items-center gap-2 rounded-md border p-2 text-sm"><Checkbox checked={sources.includes(sheet.id)} onCheckedChange={(v)=>setSources(v === true ? [...sources,sheet.id] : sources.filter((id)=>id!==sheet.id))} />{sheet.name}<span className="ml-auto text-xs text-muted-foreground">{sheet.source}</span></label>) : <p className="text-sm text-muted-foreground">No sheets available.</p>}</div>{error&&<p className="text-sm text-red-700">{error}</p>}<DialogFooter><Button type="button" variant="outline" onClick={()=>onOpenChange(false)}>Cancel</Button><Button disabled={creating}>{creating?'Creating…':'Create report'}</Button></DialogFooter></form></DialogContent></Dialog>;
}
