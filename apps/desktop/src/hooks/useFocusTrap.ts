// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, type RefObject } from "react";

const FOCUSABLE = [
	"button:not([disabled])",
	"a[href]",
	"input:not([disabled])",
	"select:not([disabled])",
	"textarea:not([disabled])",
	'[tabindex]:not([tabindex="-1"])',
].join(",");

/** Mounted traps, newest last. Only the newest one, the modal on top, handles keys. */
const traps: HTMLElement[] = [];

/** Whether a modal with a focus trap is open. */
export const hasOpenFocusTrap = (): boolean => traps.length > 0;

/** Whether `node` is the newest mounted focus trap, the modal on top. */
export const isTopFocusTrap = (node: HTMLElement | null): boolean =>
	node !== null && traps[traps.length - 1] === node;

/**
 * Keeps keyboard focus inside a modal while it is mounted: focus moves to its
 * first control on open, Tab / Shift+Tab wrap around its controls, and focus
 * returns to where it was on close unless something else has taken it. With
 * one modal open over another, only the top one moves focus.
 */
export const useFocusTrap = (ref: RefObject<HTMLElement | null>): void => {
	useEffect(() => {
		const node = ref.current;
		if (!node) return;
		traps.push(node);
		const previous = document.activeElement;
		const focusables = () => Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE));
		(focusables()[0] ?? node).focus();

		const handleKey = (e: KeyboardEvent) => {
			if (e.key !== "Tab" || !isTopFocusTrap(node)) return;
			const items = focusables();
			if (items.length === 0) {
				e.preventDefault();
				node.focus();
				return;
			}
			const first = items[0];
			const last = items[items.length - 1];
			const active = document.activeElement;
			const outside = !node.contains(active);
			if (e.shiftKey && (active === first || outside)) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && (active === last || outside)) {
				e.preventDefault();
				first.focus();
			}
		};
		document.addEventListener("keydown", handleKey);
		return () => {
			document.removeEventListener("keydown", handleKey);
			const index = traps.indexOf(node);
			if (index !== -1) traps.splice(index, 1);
			// Focus falls back to <body> when the focused control unmounts with the modal.
			const active = document.activeElement;
			const lost = !active || active === document.body || node.contains(active);
			if (lost && previous instanceof HTMLElement && previous.isConnected) previous.focus();
		};
	}, [ref]);
};
