// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { focusTvFirstColumn, focusTvStart, keepsArrow, moveFocus } from "./tv-focus";

/** Gives `el` a box, since jsdom lays nothing out. */
const place = (el: HTMLElement, left: number, top: number, width = 100, height = 40) => {
	el.getBoundingClientRect = () =>
		({ left, top, right: left + width, bottom: top + height, width, height }) as DOMRect;
};

const button = (name: string, left: number, top: number, parent: HTMLElement = document.body) => {
	const el = document.createElement("button");
	el.textContent = name;
	parent.appendChild(el);
	place(el, left, top);
	return el;
};

/** A list on screen, which the D-pad sees whole, whichever row of it has the focus. */
const list = (left: number, top: number, width: number, height: number) => {
	const el = document.createElement("div");
	el.setAttribute("data-tv-list", "");
	document.body.appendChild(el);
	place(el, left, top, width, height);
	return el;
};

const input = (type: string) => {
	const el = document.createElement("input");
	el.type = type;
	return el;
};

describe("keepsArrow", () => {
	it("leaves Left and Right to a text field's caret, and Up and Down to the D-pad", () => {
		for (const type of ["text", "search", "url", "password", "tel"]) {
			const field = input(type);
			field.value = "abc";
			field.setSelectionRange(1, 1);
			expect(keepsArrow(field, "left")).toBe(true);
			expect(keepsArrow(field, "right")).toBe(true);
			expect(keepsArrow(field, "up")).toBe(false);
			expect(keepsArrow(field, "down")).toBe(false);
		}
	});

	it("gives the D-pad the press once the caret can't go further that way", () => {
		const field = input("search");
		expect(keepsArrow(field, "left")).toBe(false);
		expect(keepsArrow(field, "right")).toBe(false);
		field.value = "abc";
		field.setSelectionRange(0, 0);
		expect(keepsArrow(field, "left")).toBe(false);
		expect(keepsArrow(field, "right")).toBe(true);
		field.setSelectionRange(3, 3);
		expect(keepsArrow(field, "left")).toBe(true);
		expect(keepsArrow(field, "right")).toBe(false);
	});

	it("looks at the end of what's selected when the press goes right", () => {
		const field = input("search");
		field.value = "abc";
		field.setSelectionRange(1, 3);
		expect(keepsArrow(field, "right")).toBe(false);
		expect(keepsArrow(field, "left")).toBe(true);
		field.setSelectionRange(0, 2);
		expect(keepsArrow(field, "right")).toBe(true);
		expect(keepsArrow(field, "left")).toBe(false);
	});

	it("leaves Left and Right to a field that doesn't say where its caret is", () => {
		for (const type of ["email", "number"]) {
			expect(keepsArrow(input(type), "left")).toBe(true);
			expect(keepsArrow(input(type), "right")).toBe(true);
			expect(keepsArrow(input(type), "up")).toBe(false);
		}
	});

	it("leaves a checkbox to the D-pad", () => {
		expect(keepsArrow(input("checkbox"), "left")).toBe(false);
	});

	it("leaves Left and Right to a range input", () => {
		expect(keepsArrow(input("range"), "right")).toBe(true);
		expect(keepsArrow(input("range"), "down")).toBe(false);
	});

	it("leaves every arrow to a text area and editable text", () => {
		expect(keepsArrow(document.createElement("textarea"), "up")).toBe(true);
		const editable = document.createElement("div");
		Object.defineProperty(editable, "isContentEditable", { value: true });
		expect(keepsArrow(editable, "left")).toBe(true);
	});

	it("leaves Up and Down to a list box", () => {
		const select = document.createElement("select");
		expect(keepsArrow(select, "down")).toBe(true);
		expect(keepsArrow(select, "left")).toBe(false);
	});

	it("leaves a slider's own axis to it", () => {
		const slider = document.createElement("div");
		slider.setAttribute("role", "slider");
		expect(keepsArrow(slider, "right")).toBe(true);
		expect(keepsArrow(slider, "up")).toBe(false);
		slider.setAttribute("aria-orientation", "vertical");
		expect(keepsArrow(slider, "up")).toBe(true);
		expect(keepsArrow(slider, "right")).toBe(false);
	});

	it("leaves buttons and non-elements to the D-pad", () => {
		expect(keepsArrow(document.createElement("button"), "left")).toBe(false);
		expect(keepsArrow(null, "left")).toBe(false);
		expect(keepsArrow(window, "left")).toBe(false);
	});
});

describe("moveFocus", () => {
	const scrolled = vi.fn();

	beforeEach(() => {
		Element.prototype.scrollIntoView = scrolled;
	});

	afterEach(() => {
		document.body.innerHTML = "";
		scrolled.mockClear();
	});

	it("moves to the nearest element in the direction and scrolls it into view", () => {
		const a = button("a", 0, 0);
		const b = button("b", 0, 50);
		button("c", 0, 100);
		a.focus();

		expect(moveFocus("down")).toBe(true);
		expect(document.activeElement).toBe(b);
		expect(scrolled).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
	});

	it("stays put when nothing is in that direction", () => {
		const a = button("a", 0, 0);
		button("b", 0, 50);
		a.focus();

		expect(moveFocus("up")).toBe(false);
		expect(document.activeElement).toBe(a);
		expect(scrolled).not.toHaveBeenCalled();
	});

	it("starts at the first element when nothing has focus", () => {
		const a = button("a", 0, 100);
		button("b", 0, 0);

		expect(moveFocus("up")).toBe(true);
		expect(document.activeElement).toBe(a);
	});

	it("passes over a first control that isn't shown when nothing has focus", () => {
		place(button("hidden", 0, 0), 0, 0, 0, 0);
		const shown = button("shown", 0, 100);

		expect(moveFocus("down")).toBe(true);
		expect(document.activeElement).toBe(shown);
	});

	it("gives false on a page with nothing shown to focus", () => {
		place(button("hidden", 0, 0), 0, 0, 0, 0);
		expect(moveFocus("down")).toBe(false);
		expect(document.activeElement).toBe(document.body);
	});

	it("gives false on a page with nothing to focus", () => {
		expect(moveFocus("down")).toBe(false);
	});

	it("skips elements that aren't shown", () => {
		const a = button("a", 0, 0);
		const narrow = button("narrow", 0, 50);
		place(narrow, 0, 50, 0, 40);
		const flat = button("flat", 0, 60);
		place(flat, 0, 60, 100, 0);
		const c = button("c", 0, 100);
		a.focus();

		expect(moveFocus("down")).toBe(true);
		expect(document.activeElement).toBe(c);
	});

	it("doesn't move to an element that holds the focus", () => {
		const row = document.createElement("div");
		row.tabIndex = 0;
		document.body.appendChild(row);
		// The button sticks out above the row, so the row is below it.
		place(row, 0, 40, 400, 200);
		const inside = button("inside", 0, 0, row);
		inside.focus();

		expect(moveFocus("down")).toBe(false);
		expect(document.activeElement).toBe(inside);
	});

	it("moves into a focused element that holds controls, from the side facing the press", () => {
		const player = document.createElement("div");
		player.tabIndex = 0;
		document.body.appendChild(player);
		place(player, 0, 0, 400, 300);
		const top = button("top", 10, 10, player);
		const bar = button("bar", 10, 250, player);
		const below = button("below", 0, 320);
		player.focus();

		expect(moveFocus("up")).toBe(true);
		expect(document.activeElement).toBe(bar);

		player.focus();
		expect(moveFocus("down")).toBe(true);
		expect(document.activeElement).toBe(top);

		// From inside, a move goes on from the control, not the container.
		bar.focus();
		expect(moveFocus("down")).toBe(true);
		expect(document.activeElement).toBe(below);
	});

	it("goes past a focused element whose controls are all hidden", () => {
		const player = document.createElement("div");
		player.tabIndex = 0;
		document.body.appendChild(player);
		place(player, 0, 0, 400, 300);
		const hidden = button("hidden", 10, 10, player);
		place(hidden, 10, 10, 0, 0);
		const right = button("right", 420, 0);
		player.focus();

		expect(moveFocus("right")).toBe(true);
		expect(document.activeElement).toBe(right);
	});

	it("moves into a focused element even when something outside is nearer", () => {
		const player = document.createElement("div");
		player.tabIndex = 0;
		document.body.appendChild(player);
		place(player, 0, 0, 400, 300);
		const inside = button("inside", 250, 10, player);
		button("right", 402, 0);
		player.focus();

		expect(moveFocus("right")).toBe(true);
		expect(document.activeElement).toBe(inside);
	});

	it("stays inside the modal on top", () => {
		button("behind", 0, 200);
		const Modal = () => {
			const ref = useRef<HTMLDivElement>(null);
			useFocusTrap(ref);
			return (
				<div ref={ref}>
					<button>first</button>
					<button>second</button>
				</div>
			);
		};
		const { getByText } = render(<Modal />);
		place(getByText("first"), 0, 0);
		place(getByText("second"), 0, 50);
		expect(document.activeElement).toBe(getByText("first"));

		expect(moveFocus("down")).toBe(true);
		expect(document.activeElement).toBe(getByText("second"));
		expect(moveFocus("down")).toBe(false);
	});

	it("brings focus from outside the modal into it", () => {
		const Modal = () => {
			const ref = useRef<HTMLDivElement>(null);
			useFocusTrap(ref);
			return (
				<div ref={ref}>
					<button>only</button>
				</div>
			);
		};
		const { getByText } = render(<Modal />);
		place(getByText("only"), 0, 0);
		const behind = button("behind", 0, 200);
		behind.focus();

		expect(moveFocus("up")).toBe(true);
		expect(document.activeElement).toBe(getByText("only"));
	});

	it("starts at the row the screen marks when nothing has focus", () => {
		button("first", 0, 0);
		const marked = button("marked", 0, 50);
		marked.setAttribute("data-tv-start", "");

		expect(moveFocus("up")).toBe(true);
		expect(document.activeElement).toBe(marked);
	});

	it("starts at the open modal's marked row, not the page's, when nothing has focus", () => {
		const behind = button("behind", 0, 0);
		behind.setAttribute("data-tv-start", "");
		const Modal = () => {
			const ref = useRef<HTMLDivElement>(null);
			useFocusTrap(ref);
			return (
				<div ref={ref}>
					<button>first</button>
					<button data-tv-start="">marked</button>
				</div>
			);
		};
		const { getByText } = render(<Modal />);
		place(getByText("first"), 0, 0);
		place(getByText("marked"), 0, 50);
		getByText("first").blur();

		expect(moveFocus("down")).toBe(true);
		expect(document.activeElement).toBe(getByText("marked"));
	});

	it("reaches a list beside the focus wherever the list's active row is", () => {
		const side = button("side", 0, 0);
		const row = button("row", 200, 300, list(200, 0, 100, 400));
		button("further", 400, 0);
		side.focus();

		expect(moveFocus("right")).toBe(true);
		expect(document.activeElement).toBe(row);
	});

	it("leaves a list from the whole list, wherever its active row is", () => {
		const row = button("row", 0, 300, list(0, 0, 100, 400));
		const level = button("level with the list", 200, 0);
		button("level with the row", 400, 300);
		row.focus();

		expect(moveFocus("right")).toBe(true);
		expect(document.activeElement).toBe(level);
	});

	it("moves into a list's row that holds controls before it leaves the list", () => {
		const row = document.createElement("div");
		row.tabIndex = 0;
		list(0, 0, 100, 400).appendChild(row);
		place(row, 0, 300);
		const inside = button("inside", 50, 300, row);
		button("beside", 200, 300);
		row.focus();

		expect(moveFocus("right")).toBe(true);
		expect(document.activeElement).toBe(inside);
	});
});

describe("focusTvStart", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("focuses the row the screen marks", () => {
		button("first", 0, 0);
		const marked = button("marked", 0, 50);
		marked.setAttribute("data-tv-start", "");

		expect(focusTvStart(document)).toBe(true);
		expect(document.activeElement).toBe(marked);
	});

	it("focuses the first control of a screen with no mark", () => {
		const first = button("first", 0, 0);
		button("second", 0, 50);

		expect(focusTvStart(document)).toBe(true);
		expect(document.activeElement).toBe(first);
	});

	it("looks only inside what it's given", () => {
		button("outside", 0, 0);
		const scope = document.createElement("div");
		document.body.appendChild(scope);
		const inside = button("inside", 0, 50, scope);

		expect(focusTvStart(scope)).toBe(true);
		expect(document.activeElement).toBe(inside);
	});

	it("leaves the screen where it is, so its first scroll can't jump", () => {
		const first = button("first", 0, 0);
		const focus = vi.spyOn(first, "focus");

		focusTvStart(document);

		expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
	});

	it("says so when nothing can take the focus", () => {
		expect(focusTvStart(document)).toBe(false);
		expect(document.activeElement).toBe(document.body);
	});
});

describe("focusTvFirstColumn", () => {
	/** A page beside the rail, which ends at 80. */
	const page = () => {
		const el = document.createElement("div");
		document.body.appendChild(el);
		place(el, 80, 0, 1200, 720);
		return el;
	};

	/** A list in `scope` with one row the D-pad can reach. */
	const column = (scope: HTMLElement, left: number, name: string) => {
		const el = list(left, 0, 200, 600);
		scope.appendChild(el);
		return button(name, left, 300, el);
	};

	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("goes to the column beside the rail, past a start further right", () => {
		const scope = page();
		const group = column(scope, 100, "group");
		column(scope, 400, "channel").setAttribute("data-tv-start", "");

		expect(focusTvFirstColumn(scope)).toBe(true);
		expect(document.activeElement).toBe(group);
	});

	it("takes the column's start over a control above it", () => {
		const scope = page();
		button("field", 100, 0, scope);
		const key = button("key", 100, 50, scope);
		key.setAttribute("data-tv-start", "");

		focusTvFirstColumn(scope);

		expect(document.activeElement).toBe(key);
	});

	it("takes the column's first control when it has no start", () => {
		const scope = page();
		const first = button("first", 100, 50, scope);
		button("second", 100, 0, scope);

		focusTvFirstColumn(scope);

		expect(document.activeElement).toBe(first);
	});

	it("passes over a control that isn't laid out", () => {
		const scope = page();
		button("hidden", 0, 0, scope);
		const shown = button("shown", 300, 0, scope);

		focusTvFirstColumn(scope);

		expect(document.activeElement).toBe(shown);
	});

	it("looks only inside what it's given, and leaves the screen where it is", () => {
		button("outside", 100, 0);
		const scope = page();
		const inside = button("inside", 300, 0, scope);
		const focus = vi.spyOn(inside, "focus");

		focusTvFirstColumn(scope);

		expect(focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
	});

	it("says so when nothing can take the focus", () => {
		expect(focusTvFirstColumn(page())).toBe(false);
		expect(document.activeElement).toBe(document.body);
	});
});
