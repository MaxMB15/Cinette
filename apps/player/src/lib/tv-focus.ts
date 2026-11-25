// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { FOCUSABLE, topFocusTrap } from "@/hooks/useFocusTrap";
import { entryEdge, pickNext, type Direction } from "./spatial-nav";

/** Marks the row that takes focus when a TV screen opens. */
export const TV_START_ATTRIBUTE = "data-tv-start";

/** Marks a list whose one active row stands for all of it when the D-pad moves. */
export const TV_LIST_ATTRIBUTE = "data-tv-list";

/** Whether the caret can still move this way. An email or number field has no selection to say. */
const caretCanMove = (
	{ selectionStart, selectionEnd, value }: HTMLInputElement,
	direction: Direction
): boolean => (direction === "left" ? selectionStart !== 0 : selectionEnd !== value.length);

/**
 * Whether the focused element uses this arrow itself, so the D-pad mustn't
 * move focus away: Left and Right move the caret in a text field until it
 * reaches the end, a slider moves along its axis, and a list box changes its
 * choice.
 */
export const keepsArrow = (target: EventTarget | null, direction: Direction): boolean => {
	if (!(target instanceof HTMLElement)) return false;
	const sideways = direction === "left" || direction === "right";
	if (target instanceof HTMLInputElement) {
		if (target.type === "range") return sideways;
		const caret = ["text", "search", "url", "email", "password", "number", "tel"];
		return sideways && caret.includes(target.type) && caretCanMove(target, direction);
	}
	if (target instanceof HTMLTextAreaElement || target.isContentEditable) return true;
	if (target instanceof HTMLSelectElement) return !sideways;
	if (target.getAttribute("role") === "slider") {
		const vertical = target.getAttribute("aria-orientation") === "vertical";
		return vertical ? !sideways : sideways;
	}
	return false;
};

/** The row a screen marks as its start, or else its first control. */
const startOf = (scope: ParentNode): HTMLElement | null =>
	scope.querySelector<HTMLElement>(`[${TV_START_ATTRIBUTE}]`) ??
	scope.querySelector<HTMLElement>(FOCUSABLE);

/**
 * Puts the focus on the row the screen marks as its start, or else its first
 * control. Returns whether anything took it.
 */
export const focusTvStart = (scope: ParentNode): boolean => {
	const target = startOf(scope);
	target?.focus({ preventScroll: true });
	return target !== null;
};

/** What the D-pad moves between: the modal on top if one is open, or else the page. */
const focusables = (doc: Document): HTMLElement[] => {
	const scope = topFocusTrap() ?? doc;
	return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	});
};

/**
 * Where the D-pad sees an element. A row of a list counts as the whole list,
 * so a press sideways reaches the column beside it wherever its cursor is.
 */
const boxOf = (el: HTMLElement) =>
	(el.closest(`[${TV_LIST_ATTRIBUTE}]`) ?? el).getBoundingClientRect();

const withBoxes = (items: HTMLElement[]) => items.map((el) => ({ item: el, box: boxOf(el) }));

const isStart = (el: HTMLElement) => el.hasAttribute(TV_START_ATTRIBUTE);

/**
 * Puts the focus in the screen's first column, as Right from the rail does:
 * on the column's start row if it has one, or else on its first control. It
 * goes there wherever the screen's cursor was, so the press never skips a
 * column. Returns whether anything took it.
 */
export const focusTvFirstColumn = (scope: HTMLElement): boolean => {
	const all = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE));
	// Of two at the same distance, the first wins, so a column's start goes
	// first. Listing it twice changes nothing.
	const ordered = [...all.filter(isStart), ...all];
	const edge = entryEdge(scope.getBoundingClientRect(), "right");
	const target = pickNext(edge, withBoxes(ordered), "right");
	target?.focus({ preventScroll: true });
	return target !== null;
};

/**
 * Moves focus to the nearest element in `direction`. When the focus is on
 * something that holds controls, such as the player, it moves into it first,
 * to the nearest control from the edge facing the press. With nothing
 * focused, or focus outside the open modal, it goes to the screen's start
 * instead. Returns whether focus moved.
 */
export const moveFocus = (direction: Direction, doc: Document = document): boolean => {
	const items = focusables(doc);
	const active = doc.activeElement;
	const inScope = active instanceof HTMLElement && items.includes(active);
	let next: HTMLElement | null;
	if (inScope) {
		const box = boxOf(active);
		const inside = items.filter((el) => el !== active && active.contains(el));
		const outside = items.filter((el) => !el.contains(active));
		next =
			pickNext(entryEdge(box, direction), withBoxes(inside), direction) ??
			pickNext(box, withBoxes(outside), direction);
	} else {
		next = items.find((el) => el.hasAttribute(TV_START_ATTRIBUTE)) ?? items[0] ?? null;
	}
	if (!next) return false;
	next.focus();
	next.scrollIntoView({ block: "nearest", inline: "nearest" });
	return true;
};
