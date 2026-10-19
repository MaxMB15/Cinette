// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { keepsArrow, moveFocus } from "./tv-focus";

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

const input = (type: string) => {
	const el = document.createElement("input");
	el.type = type;
	return el;
};

describe("keepsArrow", () => {
	it("leaves Left and Right to a text field's caret, and Up and Down to the D-pad", () => {
		for (const type of ["text", "search", "url", "email", "password", "number", "tel"]) {
			expect(keepsArrow(input(type), "left")).toBe(true);
			expect(keepsArrow(input(type), "right")).toBe(true);
			expect(keepsArrow(input(type), "up")).toBe(false);
			expect(keepsArrow(input(type), "down")).toBe(false);
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
});
