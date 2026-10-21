import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { checkSubmission, inputType, isFormColumn, submitResponse } from '@/lib/forms/fields';
import type { FormDefinition, FormValues } from '@/lib/forms/types';
import { queryKeys } from '@/lib/queries/keys';
import type { Column } from '@/lib/types';
import { useFormStore } from '@/stores/form-store';

export function FormRenderer({ form, columns, preview = false, writable = true }: { form: FormDefinition; columns: Column[]; preview?: boolean; writable?: boolean }) {
	const queryClient = useQueryClient();
	const recordResponse = useFormStore((s) => s.recordResponse);
	const [values, setValues] = useState<FormValues>({});
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [submitting, setSubmitting] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [submitted, setSubmitted] = useState(false);
	const fields = form.fields.flatMap((field) => { const column = columns.find((c) => c.key === field.columnKey); return column && isFormColumn(column) ? [{ field, column }] : []; });
	const setValue = (id: string, value: string) => { setValues((current) => ({ ...current, [id]: value })); setErrors((current) => { const next = { ...current }; delete next[id]; return next; }); setMessage(null); };
	async function submit(event: FormEvent) {
		event.preventDefault(); const check = checkSubmission(form, columns, values);
		if (!check.ok) { setErrors(check.errors); document.getElementById(`form-field-${Object.keys(check.errors)[0]}`)?.focus(); return; }
		if (preview) { setMessage(`Looks good. A real response would add a row with ${Object.keys(check.data).length} values to the sheet.`); return; }
		setSubmitting(true); setMessage(null);
		try { await submitResponse(form, check.data); recordResponse(form.id); await queryClient.invalidateQueries({ queryKey: queryKeys.sheet(form.sheetId) }); setValues({}); setSubmitted(true); }
		catch (error) { setMessage(`Your response wasn’t added: ${error instanceof Error ? error.message : String(error)}`); }
		finally { setSubmitting(false); }
	}
	if (submitted) return <div className="grid justify-items-center gap-3 rounded-xl border bg-card p-10 text-center"><CircleCheck className="size-10 text-emerald-600" /><p className="text-lg">{form.confirmation}</p>{form.allowAnother && <Button onClick={() => setSubmitted(false)}>Submit another response</Button>}</div>;
	return <form onSubmit={submit} className="grid gap-6 rounded-xl border bg-card p-6">
		<div><h1 className="text-2xl font-semibold">{form.name || 'Untitled form'}</h1>{form.description && <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{form.description}</p>}</div>
		{fields.map(({ field, column }) => { const id = `form-field-${field.id}`; const value = values[field.id] ?? ''; const error = errors[field.id]; const options = column.data_type === 'enum' ? column.settings.options ?? [] : [];
			return <div key={field.id} className="grid gap-1.5"><label htmlFor={id} className="text-sm font-medium">{field.label}{field.required && <span className="text-red-600"> *</span>}</label>{field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
				{column.data_type === 'boolean' ? <div className="flex items-center gap-2"><Checkbox id={id} checked={value === 'true'} onCheckedChange={(checked) => setValue(field.id, checked === true ? 'true' : 'false')} /><span className="text-sm">Yes</span></div>
				: options.length ? <select id={id} value={value} onChange={(e) => setValue(field.id, e.target.value)} className="h-9 rounded-md border bg-background px-3 text-sm"><option value="">Choose…</option>{options.map((o) => <option key={o.value}>{o.value}</option>)}</select>
				: column.data_type === 'markdown' ? <Textarea id={id} value={value} placeholder={field.placeholder} onChange={(e) => setValue(field.id, e.target.value)} />
				: <Input id={id} type={inputType(column)} step={['number','currency'].includes(column.data_type) ? 'any' : undefined} value={value} placeholder={field.placeholder} onChange={(e) => setValue(field.id, e.target.value)} />}
				{error && <p className="text-xs text-red-700">{error}</p>}</div>;
		})}
		{!writable && <p className="rounded-md bg-amber-50 p-3 text-sm text-amber-900">This sheet is view only, so responses can’t be added.</p>}
		{message && <p role="status" className="text-sm text-muted-foreground">{message}</p>}
		<Button type="submit" disabled={submitting || !writable}>{submitting ? 'Sending…' : form.submitLabel || 'Submit'}</Button>
	</form>;
}
