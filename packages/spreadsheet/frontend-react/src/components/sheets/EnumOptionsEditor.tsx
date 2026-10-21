import { Plus, X } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { optionDraft, type OptionDraft } from '@/lib/editing/column-drafts';
import { defaultOptionColor, pillColors } from '@/lib/grid/palette';
import { OPTION_COLORS, type OptionColor } from '@/lib/types';

/**
 * Ported from components/sheets/EnumOptionsEditor.svelte. `bind:options` becomes
 * a controlled `options`/`onChange` pair. Svelte's `await tick()` (wait for the
 * DOM to reflect the just-added option, then focus it) becomes
 * `requestAnimationFrame` after the state update, since React flushes renders
 * before the next paint too.
 */
export function EnumOptionsEditor({
	options,
	onChange,
	label
}: {
	options: OptionDraft[];
	onChange: (next: OptionDraft[]) => void;
	label: string;
}) {
	const container = useRef<HTMLDivElement>(null);

	function addOption() {
		onChange([...options, optionDraft('', defaultOptionColor(options.length))]);
	}

	/**
	 * Enter in an option field moves to (or adds) the next option instead of
	 * submitting the form. `flushSync` forces the just-added option's input to
	 * exist in the DOM before we focus it — equivalent to Svelte's `await
	 * tick()`, but synchronous rather than waiting a further microtask, so a
	 * fast subsequent keystroke can never land in the old field instead (see
	 * the animation-frame version this replaced, which lost that race).
	 */
	function onKeydown(event: KeyboardEvent<HTMLInputElement>, index: number) {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		if (index === options.length - 1) flushSync(addOption);
		container.current?.querySelectorAll<HTMLInputElement>('input[data-option-input]')[index + 1]?.focus();
	}

	function setColor(id: number, color: OptionColor) {
		onChange(options.map((option) => (option.id === id ? { ...option, color } : option)));
	}

	function setValue(id: number, value: string) {
		onChange(options.map((option) => (option.id === id ? { ...option, value } : option)));
	}

	function remove(id: number) {
		onChange(options.filter((option) => option.id !== id));
	}

	const swatchStyle = (color: OptionColor) => ({ backgroundColor: pillColors(color, '').foreground });

	const pillStyle = (color: OptionColor) => {
		const colors = pillColors(color, '');
		return { backgroundColor: colors.background, color: colors.foreground, borderColor: colors.border };
	};

	return (
		<div ref={container} className="flex flex-col gap-1.5 border-l-2 border-muted pl-3">
			{options.map((option, index) => (
				<div key={option.id} className="flex items-center gap-2">
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								className="grid size-8 shrink-0 place-items-center rounded-md border hover:bg-muted"
								aria-label={`Colour for ${label} option ${index + 1}: ${option.color}`}
							>
								<span className="size-3.5 rounded-full" style={swatchStyle(option.color)} />
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="w-40">
							<DropdownMenuRadioGroup value={option.color} onValueChange={(value) => setColor(option.id, value as OptionColor)}>
								{OPTION_COLORS.map((color) => (
									<DropdownMenuRadioItem key={color} value={color}>
										<span className="size-3 rounded-full" style={swatchStyle(color)} />
										<span className="capitalize">{color}</span>
									</DropdownMenuRadioItem>
								))}
							</DropdownMenuRadioGroup>
						</DropdownMenuContent>
					</DropdownMenu>
					<Input
						value={option.value}
						onChange={(event) => setValue(option.id, event.target.value)}
						placeholder={`Option ${index + 1}`}
						className="h-8 flex-1"
						data-option-input
						aria-label={`${label} option ${index + 1}`}
						onKeyDown={(event) => onKeydown(event, index)}
					/>
					<span
						className="hidden max-w-36 shrink-0 truncate rounded-full border px-2 py-0.5 text-xs font-medium sm:inline"
						style={pillStyle(option.color)}
					>
						{option.value || 'Preview'}
					</span>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="size-8 text-muted-foreground hover:text-red-700"
						disabled={options.length === 1}
						onClick={() => remove(option.id)}
						aria-label="Remove option"
					>
						<X className="size-4" />
					</Button>
				</div>
			))}
			<Button type="button" variant="ghost" size="sm" className="h-7 self-start text-muted-foreground" onClick={addOption}>
				<Plus className="size-3.5" />
				Add option
			</Button>
		</div>
	);
}
