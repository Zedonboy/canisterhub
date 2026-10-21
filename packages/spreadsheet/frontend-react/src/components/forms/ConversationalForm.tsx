import { AnimatePresence, motion } from 'framer-motion';
import { ArrowUp, CircleCheck, CornerDownLeft } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { checkField, inputType, isFormColumn, submitResponse } from '@/lib/forms/fields';
import type { FormDefinition, FormValues } from '@/lib/forms/types';
import type { Column, RowDocument } from '@/lib/types';
import { useFormStore } from '@/stores/form-store';

export function ConversationalForm({ form, columns, preview = false, writable = true }: { form: FormDefinition; columns: Column[]; preview?: boolean; writable?: boolean }) {
	const recordResponse = useFormStore((s) => s.recordResponse);
	const fields = form.fields.flatMap((field) => { const column = columns.find((c) => c.key === field.columnKey); return column && isFormColumn(column) ? [{ field, column }] : []; });
	const [stage, setStage] = useState<'welcome'|'question'|'done'>('welcome'); const [index, setIndex] = useState(0); const [values, setValues] = useState<FormValues>({}); const [error, setError] = useState<string | null>(null); const [submitting, setSubmitting] = useState(false); const current = fields[index];
	const progress = fields.length ? (index + (stage === 'done' ? 1 : 0)) / fields.length : 0;
	async function advance(nextValues = values) { if (!current) return; const checked = checkField(current.column, current.field, nextValues[current.field.id] ?? ''); if (!checked.ok) return setError(checked.reason); if (index + 1 < fields.length) { setIndex(index + 1); setError(null); return; }
		const data: RowDocument = {}; for (const { field, column } of fields) { const result = checkField(column, field, nextValues[field.id] ?? ''); if (result.ok && result.value !== undefined) data[column.key] = result.value; }
		if (!preview) { setSubmitting(true); try { await submitResponse(form, data); recordResponse(form.id); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); return; } finally { setSubmitting(false); } } setStage('done'); }
	const restart = () => { setStage('welcome'); setIndex(0); setValues({}); setError(null); };
	return <div className="relative flex h-full min-h-[32rem] flex-col overflow-hidden"><div className="absolute inset-x-0 top-0 h-1 bg-muted"><div className="h-full bg-blue-600 transition-all" style={{ width: `${progress * 100}%` }} /></div><AnimatePresence mode="wait">
		{stage === 'welcome' ? <motion.div key="welcome" initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="grid flex-1 place-items-center p-10 text-center"><div className="grid max-w-xl gap-5"><h1 className="text-4xl font-semibold">{form.name}</h1><p className="text-muted-foreground">{form.description}</p><div><Button size="lg" disabled={!fields.length || !writable} onClick={() => setStage('question')}>Start <CornerDownLeft /></Button></div></div></motion.div>
		: stage === 'done' ? <motion.div key="done" initial={{ y: 16, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="grid flex-1 place-items-center p-10 text-center"><div className="grid justify-items-center gap-3"><CircleCheck className="size-10 text-emerald-600" /><p className="text-lg">{preview ? 'Preview complete — no row was added.' : form.confirmation}</p>{form.allowAnother && <Button onClick={restart}>Submit another response</Button>}</div></motion.div>
		: current ? <motion.form key={current.field.id} initial={{ y: 24, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -24, opacity: 0 }} onSubmit={(e) => { e.preventDefault(); void advance(); }} className="grid flex-1 content-center gap-6 px-10 py-12"><div className="flex justify-between text-xs text-muted-foreground"><Button type="button" variant="ghost" size="sm" disabled={!index} onClick={() => setIndex(index - 1)}><ArrowUp /> Back</Button><span>{index + 1} / {fields.length}</span></div><div><h2 className="text-3xl font-semibold">{current.field.label}{current.field.required && <span className="text-red-600">*</span>}</h2><p className="text-sm text-muted-foreground">{current.field.help}</p></div>
			{current.column.data_type === 'enum' || current.column.data_type === 'boolean' ? <div className="grid gap-2">{(current.column.data_type === 'boolean' ? ['Yes','No'] : (current.column.settings.options ?? []).map((o) => o.value)).map((option) => <button type="button" key={option} className="rounded-lg border px-4 py-3 text-left hover:bg-muted" onClick={() => { const next = { ...values, [current.field.id]: current.column.data_type === 'boolean' ? String(option === 'Yes') : option }; setValues(next); setTimeout(() => void advance(next), 180); }}>{option}</button>)}</div>
			: current.column.data_type === 'markdown' ? <Textarea autoFocus rows={4} value={values[current.field.id] ?? ''} onChange={(e) => setValues({ ...values, [current.field.id]: e.target.value })} />
			: <input autoFocus type={inputType(current.column)} step="any" value={values[current.field.id] ?? ''} placeholder={current.field.placeholder} onChange={(e) => setValues({ ...values, [current.field.id]: e.target.value })} className="border-b-2 bg-transparent py-2 text-2xl outline-none focus:border-blue-500" />}
			{error && <p className="text-sm text-red-700">{error}</p>}<div><Button type="submit" disabled={submitting}>{index === fields.length - 1 ? form.submitLabel : 'OK'} <CornerDownLeft /></Button></div></motion.form> : null}
	</AnimatePresence></div>;
}
