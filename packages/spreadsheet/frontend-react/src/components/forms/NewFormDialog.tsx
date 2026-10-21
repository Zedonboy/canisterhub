import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { defaultFields } from '@/lib/forms/fields';
import { sheetsQueryOptions } from '@/lib/queries/sheets';
import { sheetRepository } from '@/lib/storage';
import { useFormStore } from '@/stores/form-store';

export function NewFormDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
	const navigate = useNavigate(); const sheets = useQuery(sheetsQueryOptions('local')); const create = useFormStore((s) => s.create);
	const [name, setName] = useState(''); const [sheetId, setSheetId] = useState(''); const [error, setError] = useState<string | null>(null); const [creating, setCreating] = useState(false);
	useEffect(() => { if (open) { setName(''); setSheetId(''); setError(null); } }, [open]);
	async function submit(event: FormEvent) { event.preventDefault(); const sheet = sheets.data?.find((s) => s.id === sheetId); if (!sheet) return setError('Choose the sheet responses should go to.'); setCreating(true); try { const columns = await sheetRepository.listColumns(sheetId); const form = create({ name: name || `${sheet.name} form`, sheetId, fields: defaultFields(columns) }); onOpenChange(false); navigate(`/forms/${form.id}/edit`); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setCreating(false); } }
	return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-md"><form onSubmit={submit} className="grid gap-5"><DialogHeader><DialogTitle>New form</DialogTitle><DialogDescription>Each response becomes a new row in a local sheet.</DialogDescription></DialogHeader>
		<div className="grid gap-2"><Label htmlFor="new-form-sheet">Sheet</Label><select id="new-form-sheet" value={sheetId} onChange={(e) => setSheetId(e.target.value)} className="h-9 rounded-md border bg-background px-3 text-sm"><option value="">Choose a sheet…</option>{(sheets.data ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></div>
		<div className="grid gap-2"><Label htmlFor="new-form-name">Title</Label><Input id="new-form-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Expense claim" /></div>{error && <p className="text-sm text-red-700">{error}</p>}<DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={creating}>{creating ? 'Creating…' : 'Create form'}</Button></DialogFooter>
	</form></DialogContent></Dialog>;
}
