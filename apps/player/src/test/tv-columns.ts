// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { fireEvent, screen, within } from "@testing-library/react";

/** A column of a TV settings screen, by what its list is called. */
export const column = (name: string) => screen.getByRole("listbox", { name });

/** What shows beside a section's rows: the answers, the hints and the aside. */
export const beside = (name: string) => column(name).parentElement!.nextElementSibling;

/** The row of a column that has the cursor. */
export const activeRow = (name: string) =>
	within(column(name)).getByRole("option", { selected: true });

/** Moves the focus to a column and walks its cursor from the top to the row starting with `label`. */
export const cursorTo = (name: string, label: string): HTMLElement => {
	activeRow(name).focus();
	fireEvent.keyDown(activeRow(name), { key: "PageUp" });
	fireEvent.keyDown(activeRow(name), { key: "PageUp" });
	for (let step = 0; step < 40; step++) {
		const row = activeRow(name);
		if (row.textContent?.startsWith(label)) return row;
		fireEvent.keyDown(row, { key: "ArrowDown" });
	}
	throw new Error(`The ${name} column has no row starting with "${label}".`);
};

/** Presses OK on the row starting with `label`. */
export const pressOk = (name: string, label: string) => {
	fireEvent.keyDown(cursorTo(name, label), { key: "Enter" });
};

/** Types into an open text entry as a keyboard would, then presses Done. */
export const enterText = (title: string, text: string) => {
	fireEvent.change(screen.getByRole("textbox", { name: title }), { target: { value: text } });
	fireEvent.click(screen.getByRole("button", { name: "Done" }));
};

/**
 * Sets the screen's lists side by side, since jsdom lays nothing out, so that
 * `moveFocus` finds the column beside the focus. Rows that mount later have no
 * box, so a test calls this again after the screen changes.
 */
export const layOutColumns = () => {
	Element.prototype.scrollIntoView = () => {};
	screen.getAllByRole("listbox").forEach((list, index) => {
		const left = index * 300;
		const box = { left, right: left + 280, top: 0, bottom: 500, width: 280, height: 500 };
		for (const el of [list, ...within(list).queryAllByRole("option")]) {
			el.getBoundingClientRect = () => box as DOMRect;
		}
	});
};
