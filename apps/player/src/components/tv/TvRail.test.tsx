// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { TvNavContext, type TvNav } from "./tv-nav";
import { TvRail, currentRailItem, type TvRailItem } from "./TvRail";

const openSection = vi.fn();

const NAV: TvNav = { section: "live", openSection, memory: new Map() };

const rail = (current: TvRailItem) => (
	<TvNavContext.Provider value={NAV}>
		<button type="button">The page</button>
		<TvRail current={current} />
	</TvNavContext.Provider>
);

const cursor = () => screen.getByRole("option", { selected: true });
const option = (name: string) => screen.getByRole("option", { name });

describe("currentRailItem", () => {
	it("gives settings its own page", () => {
		expect(currentRailItem("/settings", "movie")).toBe("settings");
	});

	it("gives any other page the open section", () => {
		expect(currentRailItem("/", "movie")).toBe("movie");
		expect(currentRailItem("/player", "history")).toBe("history");
	});
});

describe("TvRail", () => {
	afterEach(() => {
		cleanup();
		openSection.mockClear();
	});

	// React only warns the first time, so this stays the first test that renders a rail.
	it("renders its rows without a warning from React", () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		render(rail("live"));
		expect(error).not.toHaveBeenCalled();
		error.mockRestore();
	});

	it("lists every section in order inside a navigation landmark", () => {
		render(rail("live"));
		const nav = screen.getByRole("navigation", { name: "Sections" });
		const list = within(nav).getByRole("listbox", { name: "Sections" });
		expect(
			within(list)
				.getAllByRole("option")
				.map((row) => row.textContent)
		).toEqual(["Search", "Live TV", "Movies", "Series", "Favorites", "History", "Settings"]);
	});

	it("is tall enough for all its rows", () => {
		render(rail("live"));
		expect(screen.getByRole("listbox").style.height).toBe("21rem");
		expect(option("Search").style.height).toBe("3rem");
	});

	it("shows the logo and name above the rows, where the cursor can't land", () => {
		const { container } = render(rail("live"));
		const nav = screen.getByRole("navigation");
		const logo = container.querySelector("img")!;
		expect(logo).toHaveAttribute("src", expect.stringContaining("128x128@2x.png"));
		expect(logo).toHaveAttribute("alt", "");
		expect(logo.parentElement).toHaveTextContent("Cinette");
		expect(nav.firstElementChild).toBe(logo.parentElement);
		expect(within(screen.getByRole("listbox")).queryByText("Cinette")).toBeNull();
	});

	it("hides the icons from screen readers", () => {
		render(rail("live"));
		expect(option("Search").querySelector("svg")).toHaveAttribute("aria-hidden", "true");
	});

	it("hands its nav element to the ref", () => {
		const ref = createRef<HTMLElement>();
		render(
			<TvNavContext.Provider value={NAV}>
				<TvRail current="live" ref={ref} />
			</TvNavContext.Provider>
		);
		expect(ref.current).toBe(screen.getByRole("navigation"));
	});

	it.each<[TvRailItem, string]>([
		["search", "Search"],
		["live", "Live TV"],
		["movie", "Movies"],
		["series", "Series"],
		["favorites", "Favorites"],
		["history", "History"],
		["settings", "Settings"],
	])("starts its cursor on the open item, %s", (current, label) => {
		render(rail(current));
		expect(cursor()).toBe(option(label));
	});

	it("moves its cursor over sections without opening them", () => {
		render(rail("live"));
		fireEvent.keyDown(cursor(), { key: "ArrowDown" });
		fireEvent.keyDown(cursor(), { key: "ArrowDown" });
		expect(cursor()).toBe(option("Series"));
		expect(openSection).not.toHaveBeenCalled();
	});

	it.each<[string, TvRailItem]>([
		["Enter", "series"],
		["ArrowRight", "series"],
	])("opens the section under the cursor on %s", (key, section) => {
		render(rail("live"));
		fireEvent.keyDown(cursor(), { key: "ArrowDown" });
		fireEvent.keyDown(cursor(), { key: "ArrowDown" });
		expect(fireEvent.keyDown(cursor(), { key })).toBe(false);
		expect(openSection).toHaveBeenCalledExactlyOnceWith(section);
	});

	it.each<[string, TvRailItem]>([
		["Search", "search"],
		["Live TV", "live"],
		["Movies", "movie"],
		["Series", "series"],
		["Favorites", "favorites"],
		["History", "history"],
		["Settings", "settings"],
	])("opens %s when it's clicked", (label, section) => {
		render(rail("live"));
		fireEvent.click(option(label));
		expect(openSection).toHaveBeenCalledExactlyOnceWith(section);
	});

	it("colors the open section's row, wherever the cursor is", () => {
		render(rail("movie"));
		fireEvent.keyDown(cursor(), { key: "ArrowDown" });
		const colored = screen
			.getAllByRole("option")
			.filter((row) => row.firstElementChild?.classList.contains("text-primary"));
		expect(colored).toEqual([option("Movies")]);
	});

	it("leaves other keys to the page", () => {
		render(rail("live"));
		for (const key of ["ArrowLeft", "Escape", "a"]) {
			expect(fireEvent.keyDown(cursor(), { key })).toBe(true);
		}
		expect(openSection).not.toHaveBeenCalled();
	});

	it("doesn't open a section for a Right that something already used", () => {
		render(rail("live"));
		const takeIt = (e: KeyboardEvent) => e.preventDefault();
		window.addEventListener("keydown", takeIt, { capture: true });
		fireEvent.keyDown(cursor(), { key: "ArrowRight" });
		window.removeEventListener("keydown", takeIt, { capture: true });
		expect(openSection).not.toHaveBeenCalled();
	});

	it("moves its cursor when another section opens", () => {
		const { rerender } = render(rail("live"));
		fireEvent.keyDown(cursor(), { key: "ArrowDown" });
		rerender(rail("settings"));
		expect(cursor()).toBe(option("Settings"));
	});

	it("keeps its cursor while the focus moves between its rows", () => {
		render(rail("live"));
		act(() => cursor().focus());
		fireEvent.keyDown(cursor(), { key: "ArrowDown" });
		expect(document.activeElement).toBe(option("Movies"));
		expect(cursor()).toBe(option("Movies"));
	});

	it("puts its cursor back on the open section when the focus leaves", () => {
		render(rail("live"));
		act(() => cursor().focus());
		fireEvent.keyDown(cursor(), { key: "ArrowDown" });
		expect(cursor()).toBe(option("Movies"));
		act(() => screen.getByRole("button", { name: "The page" }).focus());
		expect(cursor()).toBe(option("Live TV"));
	});
});
