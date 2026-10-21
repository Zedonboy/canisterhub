import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, SquarePen } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { ConversationalForm } from '@/components/forms/ConversationalForm';
import { FormRenderer } from '@/components/forms/FormRenderer';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { columnsQueryOptions, sheetQueryOptions } from '@/lib/queries/sheets';
import { useFormStore } from '@/stores/form-store';

export function FormPage() { const { formId = '' } = useParams(); const form = useFormStore((s) => s.items.find((f) => f.id === formId)); const sheet = useQuery({ ...sheetQueryOptions(form?.sheetId ?? ''), enabled: !!form }); const columns = useQuery({ ...columnsQueryOptions(form?.sheetId ?? ''), enabled: !!form });
	if (!form) return <div className="p-8"><p className="font-medium">Form not found</p><Button asChild variant="outline" className="mt-4"><Link to="/forms"><ArrowLeft /> Back to forms</Link></Button></div>;
	if (!sheet.data || !columns.data) return <div className="mx-auto grid max-w-2xl gap-3 p-8"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-64 w-full" /></div>;
	const nav = <div className="absolute inset-x-0 top-3 z-20 flex justify-between px-6"><Link to="/forms" className="text-sm text-muted-foreground"><ArrowLeft className="mr-1 inline size-4" />Forms</Link><Button asChild variant="outline" size="sm"><Link to={`/forms/${form.id}/edit`}><SquarePen /> Edit form</Link></Button></div>;
	return form.layout === 'conversational' ? <div className="relative flex h-full flex-1 flex-col overflow-hidden">{nav}<ConversationalForm key={form.id} form={form} columns={columns.data} writable={sheet.data.writable} /></div> : <div className="flex-1 overflow-auto bg-muted/30"><div className="relative mx-auto max-w-2xl px-4 py-16">{nav}<FormRenderer key={form.id} form={form} columns={columns.data} writable={sheet.data.writable} /></div></div>;
}
