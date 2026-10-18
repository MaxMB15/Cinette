// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, cleanup, fireEvent, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router";
import { useTvRemote } from "./useTvRemote";

/** Gives `el` a box, since jsdom lays nothing out. */
const place = (el: HTMLElement, top: number) => {
	el.getBoundingClientRect = () =>
		({ left: 0, top, right: 100, bottom: top + 40, width: 100, height: 40 }) as DOMRect;
};

const Where = () => <p data-testid="where">{useLocation().pathname}</p>;

const Remote = () => {
	useTvRemote();
	return (
		<>
			<button>first</button>
			<button>second</button>
			<input aria-label="search" />
			<Where />
		</>
	);
};

const renderAt = (path: string) => {
	render(
		<MemoryRouter initialEntries={[path]}>
			<Routes>
				<Route path="*" element={<Remote />} />
			</Routes>
		</MemoryRouter>
	);
	place(screen.getByText("first"), 0);
	place(screen.getByText("second"), 50);
	place(screen.getByLabelText("search"), 100);
	Element.prototype.scrollIntoView = vi.fn();
};

describe("useTvRemote", () => {
	afterEach(cleanup);

	it("moves focus with the D-pad and takes the key", () => {
		renderAt("/");
		screen.getByText("first").focus();

		const event = new KeyboardEvent("keydown", {
			key: "ArrowDown",
			bubbles: true,
			cancelable: true,
		});
		screen.getByText("first").dispatchEvent(event);

		expect(document.activeElement).toBe(screen.getByText("second"));
		expect(event.defaultPrevented).toBe(true);
	});

	it("leaves the key alone when focus can't move", () => {
		renderAt("/");
		screen.getByText("first").focus();

		const event = new KeyboardEvent("keydown", {
			key: "ArrowUp",
			bubbles: true,
			cancelable: true,
		});
		screen.getByText("first").dispatchEvent(event);

		expect(document.activeElement).toBe(screen.getByText("first"));
		expect(event.defaultPrevented).toBe(false);
	});

	it("leaves arrows that something else used, or with a modifier, or that a field keeps", () => {
		renderAt("/");
		const first = screen.getByText("first");
		first.focus();
		const taken = (e: Event) => e.preventDefault();
		first.addEventListener("keydown", taken);
		fireEvent.keyDown(first, { key: "ArrowDown" });
		first.removeEventListener("keydown", taken);
		expect(document.activeElement).toBe(first);

		for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
			fireEvent.keyDown(first, { key: "ArrowDown", [modifier]: true });
			expect(document.activeElement).toBe(first);
		}

		const search = screen.getByLabelText("search");
		search.focus();
		fireEvent.keyDown(search, { key: "ArrowLeft" });
		expect(document.activeElement).toBe(search);
		fireEvent.keyDown(search, { key: "ArrowUp" });
		expect(document.activeElement).toBe(screen.getByText("second"));

		fireEvent.keyDown(screen.getByText("second"), { key: "Enter" });
		expect(document.activeElement).toBe(screen.getByText("second"));
	});

	it("takes Back home from another page, and lets the app close at home", () => {
		renderAt("/settings");
		let handled: boolean | undefined;
		act(() => {
			handled = window.__cinetteBack?.();
		});
		expect(handled).toBe(true);
		expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
		act(() => {
			handled = window.__cinetteBack?.();
		});
		expect(handled).toBe(false);
	});

	it("stops handling the remote once unmounted", () => {
		renderAt("/");
		cleanup();
		expect(window.__cinetteBack).toBeUndefined();
		const outside = document.createElement("button");
		document.body.appendChild(outside);
		outside.focus();
		const event = new KeyboardEvent("keydown", {
			key: "ArrowDown",
			bubbles: true,
			cancelable: true,
		});
		outside.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		outside.remove();
	});
});
