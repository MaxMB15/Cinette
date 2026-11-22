// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useRef, useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, cleanup, fireEvent, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { DEFAULT_SUBTITLE_POSITION } from "@/lib/subtitle-position";
import { useSubtitleNudge } from "./useSubtitleNudge";
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

/** The player's subtitle nudge, which mounts under the TV layout. */
const Nudge = () => {
	const [position, setPosition] = useState(DEFAULT_SUBTITLE_POSITION);
	useSubtitleNudge(true, setPosition);
	return <p data-testid="position">{`${position.x},${position.y}`}</p>;
};

const renderAt = (path: string, nudge = false) => {
	render(
		<MemoryRouter initialEntries={[path]}>
			<Routes>
				<Route
					path="*"
					element={
						<>
							<Remote />
							{nudge && <Nudge />}
						</>
					}
				/>
			</Routes>
		</MemoryRouter>
	);
	place(screen.getByText("first"), 0);
	place(screen.getByText("second"), 50);
	place(screen.getByLabelText("search"), 100);
	Element.prototype.scrollIntoView = vi.fn();
};

/** Presses a key at `target`, and gives the event. */
const pressAt = (target: EventTarget, key: string, repeat = false) => {
	const event = new KeyboardEvent("keydown", { key, repeat, bubbles: true, cancelable: true });
	target.dispatchEvent(event);
	return event;
};

/** The remote with no controls on the screen. */
const EmptyScreen = () => {
	useTvRemote();
	return null;
};

/** A modal over the remote's page, with no focus anywhere yet. */
const ModalOver = () => {
	const ref = useRef<HTMLDivElement>(null);
	useFocusTrap(ref);
	return (
		<div ref={ref}>
			<button>in the modal</button>
		</div>
	);
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

	it("leaves the arrows to the subtitle nudge while it's on", () => {
		renderAt("/", true);
		const first = screen.getByText("first");
		first.focus();
		fireEvent.keyDown(first, { key: "ArrowDown" });
		expect(document.activeElement).toBe(first);
		expect(screen.getByTestId("position")).toHaveTextContent("50,90");
	});

	it("keeps one Back handler as the page changes", () => {
		renderAt("/settings");
		const back = window.__cinetteBack;
		act(() => {
			back?.();
		});
		expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
		expect(window.__cinetteBack).toBe(back);
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
		// Two buttons, so a listener left behind would have somewhere to move focus.
		const outside = document.createElement("button");
		const below = document.createElement("button");
		document.body.append(outside, below);
		place(outside, 0);
		place(below, 50);
		outside.focus();
		const event = new KeyboardEvent("keydown", {
			key: "ArrowDown",
			bubbles: true,
			cancelable: true,
		});
		outside.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
		expect(document.activeElement).toBe(outside);
		outside.remove();
		below.remove();
	});

	describe("OK with nothing focused", () => {
		it("goes to the screen's first control and takes the press", () => {
			renderAt("/");

			const event = pressAt(document.body, "Enter");

			expect(document.activeElement).toBe(screen.getByText("first"));
			expect(event.defaultPrevented).toBe(true);
		});

		it("goes to the row the screen marks", () => {
			renderAt("/");
			screen.getByText("second").setAttribute("data-tv-start", "");

			pressAt(document.body, "Enter");

			expect(document.activeElement).toBe(screen.getByText("second"));
		});

		it("goes into the open modal rather than the page behind it", () => {
			render(
				<MemoryRouter>
					<Remote />
					<ModalOver />
				</MemoryRouter>
			);
			screen.getByText("in the modal").blur();

			pressAt(document.body, "Enter");

			expect(document.activeElement).toBe(screen.getByText("in the modal"));
		});

		it("leaves the press alone on a screen with no controls", () => {
			render(
				<MemoryRouter>
					<EmptyScreen />
				</MemoryRouter>
			);
			expect(pressAt(document.body, "Enter").defaultPrevented).toBe(false);
		});

		it("takes no notice of another key", () => {
			renderAt("/");

			const event = pressAt(document.body, "a");

			expect(document.activeElement).toBe(document.body);
			expect(event.defaultPrevented).toBe(false);
		});

		it("takes no notice with a modifier held", () => {
			renderAt("/");
			const event = new KeyboardEvent("keydown", {
				key: "Enter",
				shiftKey: true,
				bubbles: true,
				cancelable: true,
			});
			document.body.dispatchEvent(event);
			expect(document.activeElement).toBe(document.body);
		});
	});

	it("leaves OK to the control that has the focus", () => {
		renderAt("/");
		const second = screen.getByText("second");
		second.focus();

		const event = pressAt(second, "Enter");

		expect(document.activeElement).toBe(second);
		expect(event.defaultPrevented).toBe(false);
	});

	describe("a held OK", () => {
		it("lets the first press through to the control", () => {
			renderAt("/");
			const first = screen.getByText("first");
			first.focus();
			const pressed = vi.fn();
			first.addEventListener("keydown", pressed);

			const event = pressAt(first, "Enter");

			expect(pressed).toHaveBeenCalledOnce();
			expect(event.defaultPrevented).toBe(false);
		});

		it("stops the repeats before anything on the page sees them", () => {
			renderAt("/");
			const first = screen.getByText("first");
			first.focus();
			const pressed = vi.fn();
			first.addEventListener("keydown", pressed);

			const event = pressAt(first, "Enter", true);

			expect(pressed).not.toHaveBeenCalled();
			expect(event.defaultPrevented).toBe(true);
		});

		it("doesn't put the focus anywhere with nothing focused", () => {
			renderAt("/");
			pressAt(document.body, "Enter", true);
			expect(document.activeElement).toBe(document.body);
		});

		it("leaves other held keys, so a held arrow keeps moving", () => {
			renderAt("/");
			const first = screen.getByText("first");
			first.focus();

			const event = pressAt(first, "ArrowDown", true);

			expect(document.activeElement).toBe(screen.getByText("second"));
			expect(event.defaultPrevented).toBe(true);
		});

		it("lets the repeats through once the remote has gone", () => {
			renderAt("/");
			cleanup();
			expect(pressAt(document.body, "Enter", true).defaultPrevented).toBe(false);
		});
	});
});
