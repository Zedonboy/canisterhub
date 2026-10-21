import type { FormWording } from '../types';

/** Turns a column-name-style label into a short, friendly question. */
function questionFor(label: string): string {
	const lower = label.trim().toLowerCase();
	if (!lower) return label;
	if (/email/.test(lower)) return "What's your email address?";
	if (/phone|mobile|contact number/.test(lower)) return "What's the best phone number?";
	if (/\bnotes?\b|comments?|description|details?/.test(lower)) return 'Anything else to add?';
	if (/status|stage/.test(lower)) return `What's the current ${lower}?`;
	if (/^name$|\bname$/.test(lower)) return `What's the ${lower}?`;
	if (/date/.test(lower)) {
		const base = lower.replace(/\s*date\s*$/, '').trim();
		return base ? `When's the ${base} date?` : "When's the date?";
	}
	return `What's the ${lower}?`;
}

export interface WordingField {
	id: string;
	label: string;
	help: string;
	required: boolean;
}

/** Rewrites a form's field labels into questions, fills in missing help text, and suggests a
 *  warmer confirmation message — wording only, never which fields or columns are used. */
export function improveWording(formName: string, fields: WordingField[]): FormWording {
	const notes: string[] = [];
	const rewritten = fields.map((field) => {
		const label = questionFor(field.label);
		const help = field.help || (field.required ? '' : 'Optional — leave blank if you’re not sure.');
		if (label !== field.label) notes.push(`Rephrased "${field.label}" as a question.`);
		if (help && !field.help) notes.push(`Added a hint for "${field.label}".`);
		return { fieldId: field.id, label, help };
	});

	if (notes.length === 0) notes.push('The wording already reads like a question, so nothing needed changing.');
	const confirmation = `Thanks for filling out ${formName.trim() || 'this form'}! We’ve got your response.`;
	return { fields: rewritten, confirmation, notes };
}
