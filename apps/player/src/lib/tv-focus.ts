// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { FOCUSABLE, topFocusTrap } from "@/hooks/useFocusTrap";
import { entryEdge, pickNext, type Direction } from "./spatial-nav";

/**
 * Whether the focused element uses this arrow itself, so the D-pad mustn't
 * move focus away: Left and Right move the caret in a text field, a slider
 * moves along its axis, and a list box changes its choice.
 */
export const keepsArrow = (target: EventTarget | null, direction: Direction): boolean => {
	if (!(target instanceof HTMLElement)) return false;
	const sideways = direction === "left" || direction === "right";
	if (target instanceof HTMLInputElement) {
		if (target.type === "range") return sideways;
		const caret = ["text", "search", "url", "email", "password", "number", "tel"];
		return sideways && caret.includes(target.type);
	}
	if (target instanceof HTMLTextAreaElement || target.isContentEditable) return true;
	if (target instanceof HTMLSelectElement) return !sideways;
	if (target.getAttribute("role") === "slider") {
		const vertical = target.getAttribute("aria-orientation") === "vertical";
		return vertical ? !sideways : sideways;
	}
	return false;
};

/** What the D-pad moves between: the modal on top if one is open, or else the page. */
const focusables = (doc: Document): HTMLElement[] => {
	const scope: ParentNode = topFocusTrap() ?? doc;
	return Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => {
		const r = el.getBoundingClientRect();
		return r.width > 0 && r.height > 0;
	});
};

const withBoxes = (items: HTMLElement[]) =>
	items.map((el) => ({ item: el, box: el.getBoundingClientRect() }));

/**
 * Moves focus to the nearest element in `direction`. When the focus is on
 * something that holds controls, such as the player, it moves into it first,
 * to the nearest control from the edge facing the press. With nothing
 * focused, or focus outside the open modal, it goes to the first element
 * instead. Returns whether focus moved.
 */
export const moveFocus = (direction: Direction, doc: Document = document): boolean => {
	const items = focusables(doc);
	const active = doc.activeElement;
	const inScope = active instanceof HTMLElement && items.includes(active);
	let next: HTMLElement | null;
	if (inScope) {
		const box = active.getBoundingClientRect();
		const inside = items.filter((el) => el !== active && active.contains(el));
		const outside = items.filter((el) => !el.contains(active));
		next =
			pickNext(entryEdge(box, direction), withBoxes(inside), direction) ??
			pickNext(box, withBoxes(outside), direction);
	} else {
		next = items[0] ?? null;
	}
	if (!next) return false;
	next.focus();
	next.scrollIntoView({ block: "nearest", inline: "nearest" });
	return true;
};
