import {
	GridCellKind,
	type GridCell,
	type ProvideEditorCallback,
	type ProvideEditorComponent,
	type TextCell
} from '@glideapps/glide-data-grid';
import { createElement, useEffect, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { pillColors } from '../palette';
import type { CellEditMeta, SheetGridController } from '../sheet-grid-controller';

const textCell = (text: string): TextCell => ({
	kind: GridCellKind.Text,
	data: text,
	displayData: text,
	allowOverlay: true,
	readonly: false
});

type EditorProps = Parameters<ProvideEditorComponent<GridCell>>[0];

/**
 * React events bubble through portals, so keys typed in an overlay editor
 * would otherwise reach the grid's own keybindings (Ctrl+A select-all,
 * Backspace/Delete clearing cells, arrows moving the selection). Only the keys
 * Glide's overlay uses to finish editing are allowed through.
 */
function isolateEditorKeys(event: KeyboardEvent) {
	const finishesEditing =
		(event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab' || event.key === 'Escape';
	if (!finishesEditing) event.stopPropagation();
}

/**
 * Overlay editors for editable cells. Each reports its text to the controller
 * (`trackEdit`), which parses it per column type and commits when Glide closes
 * the overlay (Enter/Tab/click outside; Escape discards). `onChange` keeps
 * Glide's own pending value in sync so it knows there is something to commit.
 */
export function createEditorProvider(controller: SheetGridController): ProvideEditorCallback<GridCell> {
	const report = (props: EditorProps, meta: CellEditMeta | undefined, text: string) => {
		if (meta) controller.trackEdit(meta, text);
		props.onChange(textCell(text));
	};

	/** Free text: values and formulas ("=..."); masked for protected columns. */
	const CellTextEditor: ProvideEditorComponent<GridCell> = (props) => {
		const [meta] = useState(() => controller.getEditMeta(props.value));
		const [text, setText] = useState(() => props.initialValue ?? meta?.input ?? '');
		const inputRef = useRef<HTMLInputElement>(null);

		useEffect(() => {
			controller.beginEdit();
			const input = inputRef.current;
			if (!input) return;
			input.focus();
			if (props.initialValue !== undefined) {
				// Editing started by typing: that keystroke is the new value.
				report(props, meta, props.initialValue);
				input.setSelectionRange(input.value.length, input.value.length);
			} else {
				input.select();
			}
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);

		return createElement('input', {
			ref: inputRef,
			type: meta?.editor === 'secret' ? 'password' : 'text',
			value: text,
			onChange: (event: ChangeEvent<HTMLInputElement>) => {
				setText(event.target.value);
				report(props, meta, event.target.value);
			},
			onKeyDown: isolateEditorKeys,
			placeholder: meta?.placeholder,
			spellCheck: false,
			autoComplete: 'off',
			'aria-label': 'Cell value or formula',
			className: text.trimStart().startsWith('=') ? 'silver-cell-editor is-formula' : 'silver-cell-editor',
			style: { minWidth: Math.max(props.target.width - 20, 120) }
		});
	};

	/** Multi-line markdown source. Enter commits (Glide); Shift+Enter inserts a newline. */
	const MarkdownCellEditor: ProvideEditorComponent<GridCell> = (props) => {
		const [meta] = useState(() => controller.getEditMeta(props.value));
		const [text, setText] = useState(() => props.initialValue ?? meta?.input ?? '');
		const areaRef = useRef<HTMLTextAreaElement>(null);

		useEffect(() => {
			controller.beginEdit();
			const area = areaRef.current;
			if (!area) return;
			area.focus();
			if (props.initialValue !== undefined) report(props, meta, props.initialValue);
			area.setSelectionRange(area.value.length, area.value.length);
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);

		return createElement('textarea', {
			ref: areaRef,
			value: text,
			rows: 5,
			placeholder: meta?.placeholder,
			spellCheck: true,
			'aria-label': 'Markdown text',
			className: 'silver-cell-editor silver-markdown-editor',
			style: { minWidth: Math.max(props.target.width - 20, 280) },
			onChange: (event: ChangeEvent<HTMLTextAreaElement>) => {
				setText(event.target.value);
				report(props, meta, event.target.value);
			},
			onKeyDown: isolateEditorKeys
		});
	};

	/** Enum: pick one of the column's coloured options (type to filter, arrows + Enter, or click). */
	const EnumCellEditor: ProvideEditorComponent<GridCell> = (props) => {
		const [meta] = useState(() => controller.getEditMeta(props.value));
		const options = meta?.options ?? [];
		const current = meta?.input ?? '';

		const [query, setQuery] = useState(props.initialValue ?? '');
		const [active, setActive] = useState(() =>
			props.initialValue !== undefined ? 0 : Math.max(0, options.findIndex((option) => option.value === current))
		);
		// Only report a pending value once the user has chosen something, so
		// opening and clicking away never changes the cell.
		const [touched, setTouched] = useState(props.initialValue !== undefined);
		const inputRef = useRef<HTMLInputElement>(null);

		const needle = query.trim().toLowerCase();
		const visible = needle ? options.filter((option) => option.value.toLowerCase().includes(needle)) : options;
		const highlighted = visible[Math.min(active, visible.length - 1)];

		useEffect(() => {
			controller.beginEdit();
			inputRef.current?.focus();
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, []);

		useEffect(() => {
			if (touched) report(props, meta, highlighted ? highlighted.value : current);
			// eslint-disable-next-line react-hooks/exhaustive-deps
		}, [touched, highlighted?.value]);

		const choose = (value: string) => {
			if (meta) controller.trackEdit(meta, value);
			props.onFinishedEditing(textCell(value), [0, 0]);
		};

		const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
			isolateEditorKeys(event);
			if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
				event.preventDefault();
				const step = event.key === 'ArrowDown' ? 1 : -1;
				setActive((index) => (visible.length === 0 ? 0 : (index + step + visible.length) % visible.length));
				setTouched(true);
			}
		};

		const listItems = visible.map((option, index) => {
			const colors = pillColors(option.color, option.value);
			return createElement(
				'li',
				{
					key: option.value,
					role: 'option',
					'aria-selected': option.value === current,
					'data-active': option === highlighted,
					className: 'silver-enum-option',
					onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault(),
					onMouseEnter: () => setActive(index),
					onClick: () => choose(option.value)
				},
				createElement(
					'span',
					{
						className: 'silver-enum-pill',
						style: { background: colors.background, color: colors.foreground, borderColor: colors.border }
					},
					option.value
				),
				option.value === current ? createElement('span', { className: 'silver-enum-check', 'aria-hidden': true }, '✓') : null
			);
		});

		return createElement(
			'div',
			{ className: 'silver-enum-editor', style: { minWidth: Math.max(props.target.width, 200) } },
			createElement('input', {
				ref: inputRef,
				value: query,
				onChange: (event: ChangeEvent<HTMLInputElement>) => {
					setQuery(event.target.value);
					setActive(0);
					setTouched(true);
				},
				onKeyDown,
				placeholder: 'Search options',
				spellCheck: false,
				autoComplete: 'off',
				'aria-label': 'Search options'
			}),
			visible.length > 0
				? createElement('ul', { role: 'listbox', className: 'silver-enum-list' }, listItems)
				: createElement('div', { className: 'silver-enum-empty' }, 'No matching option'),
			current
				? createElement(
						'button',
						{
							type: 'button',
							className: 'silver-enum-clear',
							onMouseDown: (event: { preventDefault: () => void }) => event.preventDefault(),
							onClick: () => choose('')
						},
						'Clear value'
					)
				: null
		);
	};

	return (cell) => {
		const meta = controller.getEditMeta(cell);
		if (!meta) return undefined;
		switch (meta.editor) {
			case 'enum':
				return { editor: EnumCellEditor };
			case 'markdown':
				return { editor: MarkdownCellEditor };
			default:
				return { editor: CellTextEditor };
		}
	};
}
