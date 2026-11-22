// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import {
	useId,
	useLayoutEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode,
} from "react";
import { hasOpenFocusTrap } from "@/hooks/useFocusTrap";
import { directionForKey } from "@/lib/spatial-nav";
import { TV_LIST_ATTRIBUTE, TV_START_ATTRIBUTE } from "@/lib/tv-focus";
import { firstVisibleRow, nextIndex, rowsPerPress } from "@/lib/tv-grid";
import { cn } from "@/lib/utils";

/** Rows above and below the screen stay mounted, so the row in view never mounts late. */
const EXTRA_ROWS = 1;

/** The remote's keys that move a whole screen of rows, and which way. */
const PAGE_KEYS: Record<string, 1 | -1> = {
	PageUp: -1,
	ChannelUp: -1,
	PageDown: 1,
	ChannelDown: 1,
};

export interface TvListProps<T> {
	items: readonly T[];
	/** What a screen reader calls this list. */
	label: string;
	itemKey: (item: T) => string;
	renderItem: (item: T, index: number) => ReactNode;
	/** Which item has the cursor. The list keeps it in view. */
	active: number;
	onActiveChange: (index: number) => void;
	/** OK on an item. */
	onSelect?: (item: T, index: number) => void;
	/** A row's height and the list's height, in rem, since a TV screen is always 36rem tall. */
	rowHeight: number;
	height: number;
	/** Set both to lay the items out as a grid. Widths are in rem. */
	columns?: number;
	columnWidth?: number;
	/** The row takes focus when the screen opens, and again if it had nothing else to focus. */
	start?: boolean;
	/**
	 * False takes every row out of the tab order and unmarks the active one,
	 * for a list whose place is in another list above or below it.
	 */
	focusable?: boolean;
	className?: string;
	itemClassName?: string;
}

/**
 * A list or grid for the D-pad, with its one active row in the tab order.
 * Arrows move the cursor inside it. At its edge they go on to the D-pad's
 * focus handling, which finds the active row of the list beside it, so each
 * list keeps its place while the focus is elsewhere.
 *
 * Rows sit at fixed rem offsets, so it needs no measuring, and only the rows
 * around the screen mount, so a list of thousands costs the same as ten. A held
 * arrow speeds a list up, and the row then says how far along it is.
 */
export const TvList = <T,>({
	items,
	label,
	itemKey,
	renderItem,
	active,
	onActiveChange,
	onSelect,
	rowHeight,
	height,
	columns = 1,
	columnWidth,
	start = false,
	focusable = true,
	className,
	itemClassName,
}: TvListProps<T>) => {
	const id = useId();
	const activeRowRef = useRef<HTMLDivElement>(null);
	// Whether the focus is in this list, so a new active row takes it over.
	const holdsFocusRef = useRef(false);
	// How many times the key held down has repeated.
	const repeatsRef = useRef(0);
	const [fast, setFast] = useState(false);

	const index = Math.max(0, Math.min(active, items.length - 1));
	const rowCount = Math.ceil(items.length / columns);
	const visibleRows = Math.max(1, Math.floor(height / rowHeight));
	const firstRow = firstVisibleRow(Math.floor(index / columns), rowCount, visibleRows);
	const from = Math.max(0, firstRow - EXTRA_ROWS) * columns;
	const to = Math.min(items.length, (firstRow + visibleRows + EXTRA_ROWS) * columns);

	useLayoutEffect(() => {
		if (holdsFocusRef.current) activeRowRef.current?.focus({ preventScroll: true });
	});

	// A screen whose items arrive after it opens takes focus when they do.
	const hasItems = items.length > 0;
	useLayoutEffect(() => {
		if (start && hasItems && !hasOpenFocusTrap() && document.activeElement === document.body) {
			// Stryker disable next-line OptionalChaining: with any items, the active row is always mounted, so the ref is never empty here.
			activeRowRef.current?.focus({ preventScroll: true });
		}
	}, [start, hasItems]);

	const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
		if (e.key === "Enter") {
			const item = items[index];
			if (item !== undefined && onSelect) {
				e.preventDefault();
				onSelect(item, index);
			}
			return;
		}
		const page = PAGE_KEYS[e.key];
		if (page && items.length > 0) {
			e.preventDefault();
			const moved = index + page * visibleRows * columns;
			onActiveChange(Math.max(0, Math.min(moved, items.length - 1)));
			return;
		}
		const direction = directionForKey(e.key);
		if (!direction || items.length === 0) return;
		const next = nextIndex(index, items.length, columns, direction);
		if (next === null) return;
		e.preventDefault();
		repeatsRef.current = e.repeat ? repeatsRef.current + 1 : 0;
		// A grid has far fewer rows, and each one brings in a row of posters.
		const rows = columns === 1 ? rowsPerPress(repeatsRef.current) : 1;
		setFast(rows > 1);
		onActiveChange(Math.max(0, Math.min(index + (next - index) * rows, items.length - 1)));
	};

	return (
		<div
			role="listbox"
			{...{ [TV_LIST_ATTRIBUTE]: "" }}
			aria-label={label}
			aria-activedescendant={hasItems ? `${id}-${index}` : undefined}
			className={cn("relative overflow-clip", className)}
			style={{ height: `${height}rem` }}
			onKeyDown={onKeyDown}
			onKeyUp={() => setFast(false)}
			onFocus={() => {
				holdsFocusRef.current = true;
			}}
			onBlur={(e) => {
				// With no next element, the row left the page, so its list keeps the focus.
				if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget)) {
					holdsFocusRef.current = false;
					setFast(false);
				}
			}}
		>
			{items.slice(from, to).map((item, offset) => {
				const i = from + offset;
				const isActive = i === index;
				const current = isActive && focusable;
				const row = Math.floor(i / columns) - firstRow;
				return (
					<div
						key={itemKey(item)}
						id={`${id}-${i}`}
						ref={isActive ? activeRowRef : undefined}
						role="option"
						aria-selected={isActive}
						tabIndex={current ? 0 : -1}
						{...(current && start ? { [TV_START_ATTRIBUTE]: "" } : {})}
						data-active={current ? "" : undefined}
						className={cn("tv-cursor absolute", itemClassName)}
						style={{
							top: `${row * rowHeight}rem`,
							height: `${rowHeight}rem`,
							left: columnWidth ? `${(i % columns) * columnWidth}rem` : 0,
							width: columnWidth ? `${columnWidth}rem` : "100%",
						}}
						onClick={() => {
							onActiveChange(i);
							onSelect?.(item, i);
						}}
					>
						{renderItem(item, i)}
						{isActive && fast && (
							<span
								aria-hidden
								className="absolute top-1/2 right-[0.5rem] -translate-y-1/2 rounded-[0.375rem] bg-black/80 px-[0.5rem] py-[0.25rem] text-[0.8rem] leading-[1.1rem] font-medium whitespace-nowrap text-white tabular-nums"
							>
								{(i + 1).toLocaleString()} of {items.length.toLocaleString()}
							</span>
						)}
					</div>
				);
			})}
		</div>
	);
};
