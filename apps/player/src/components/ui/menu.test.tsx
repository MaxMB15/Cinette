// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { Menu, MenuItem } from "./menu";

const Harness = ({
	onPick = () => {},
	checked,
	onOpenChange,
}: {
	onPick?: (name: string) => void;
	checked?: string;
	onOpenChange?: (open: boolean) => void;
}) => {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button type="button">Outside</button>
			<Menu
				open={open}
				onOpenChange={(next) => {
					onOpenChange?.(next);
					setOpen(next);
				}}
				trigger={(props) => (
					<button type="button" {...props}>
						More
					</button>
				)}
				className="w-40"
			>
				<p>Heading</p>
				{["One", "Two", "Three"].map((name) => (
					<MenuItem
						key={name}
						checked={checked === undefined ? undefined : checked === name}
						onSelect={() => onPick(name)}
						className="extra"
					>
						{name}
					</MenuItem>
				))}
			</Menu>
		</>
	);
};

const trigger = () => screen.getByRole("button", { name: "More" });

describe("Menu", () => {
	it("opens and closes from its button, which says so", () => {
		render(<Harness />);
		expect(trigger()).toHaveAttribute("aria-haspopup", "menu");
		expect(trigger()).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByRole("menu")).toBeNull();
		fireEvent.click(trigger());
		expect(trigger()).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByRole("menu")).toHaveClass("absolute", "z-50", "w-40");
		fireEvent.click(trigger());
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("focuses the first item, or the one picked", () => {
		const view = render(<Harness />);
		fireEvent.click(trigger());
		expect(screen.getByRole("menuitem", { name: "One" })).toHaveFocus();
		view.unmount();
		render(<Harness checked="Two" />);
		fireEvent.click(trigger());
		const two = screen.getByRole("menuitemradio", { name: "Two" });
		expect(two).toHaveFocus();
		expect(two).toHaveAttribute("aria-checked", "true");
		expect(screen.getByRole("menuitemradio", { name: "One" })).toHaveAttribute(
			"aria-checked",
			"false"
		);
	});

	it("closes on a pick, then does it", () => {
		const onPick = vi.fn();
		render(<Harness onPick={onPick} />);
		fireEvent.click(trigger());
		const two = screen.getByRole("menuitem", { name: "Two" });
		expect(two).toHaveAttribute("type", "button");
		expect(two).toHaveAttribute("tabindex", "-1");
		expect(two).toHaveClass("extra", "w-full");
		fireEvent.click(two);
		expect(onPick).toHaveBeenCalledWith("Two");
		expect(screen.queryByRole("menu")).toBeNull();
		expect(trigger()).toHaveFocus();
	});

	it("closes on a press outside it, and not on one inside", () => {
		render(<Harness />);
		fireEvent.click(trigger());
		fireEvent.pointerDown(screen.getByText("Heading"));
		expect(screen.getByRole("menu")).toBeInTheDocument();
		fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("stops listening for presses once it's closed", () => {
		const onOpenChange = vi.fn();
		render(<Harness onOpenChange={onOpenChange} />);
		fireEvent.click(trigger());
		fireEvent.click(trigger());
		onOpenChange.mockClear();
		fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("closes on Escape and puts focus back on its button, and keeps Escape to itself", () => {
		const outer = vi.fn();
		render(
			<div onKeyDown={(e) => outer(e.key)}>
				<Harness />
			</div>
		);
		fireEvent.click(trigger());
		const escape = fireEvent.keyDown(screen.getByRole("menuitem", { name: "One" }), {
			key: "Escape",
		});
		expect(escape).toBe(false);
		expect(outer).not.toHaveBeenCalled();
		expect(screen.queryByRole("menu")).toBeNull();
		expect(trigger()).toHaveFocus();
	});

	it("keeps the keys it handles from the page, and lets the rest through", () => {
		const outer = vi.fn();
		render(
			<div onKeyDown={(e) => outer(e.key)}>
				<Harness />
			</div>
		);
		fireEvent.click(trigger());
		for (const key of ["ArrowDown", "ArrowUp", "Home", "End"])
			fireEvent.keyDown(document.activeElement!, { key });
		expect(outer).not.toHaveBeenCalled();
		fireEvent.keyDown(document.activeElement!, { key: "a" });
		expect(outer).toHaveBeenCalledWith("a");
	});

	it("closes on Tab and lets it move on", () => {
		const outer = vi.fn();
		render(
			<div onKeyDown={(e) => outer(e.key)}>
				<Harness />
			</div>
		);
		fireEvent.click(trigger());
		const tab = fireEvent.keyDown(document.activeElement!, { key: "Tab" });
		expect(tab).toBe(true);
		expect(outer).toHaveBeenCalledWith("Tab");
		expect(screen.queryByRole("menu")).toBeNull();
	});

	it("opens with no items, and the keys find nothing to move to", () => {
		const Empty = () => {
			const [open, setOpen] = useState(false);
			return (
				<Menu
					open={open}
					onOpenChange={setOpen}
					trigger={(props) => (
						<button type="button" {...props}>
							More
						</button>
					)}
				>
					<p>Nothing</p>
				</Menu>
			);
		};
		render(<Empty />);
		fireEvent.click(trigger());
		expect(() =>
			fireEvent.keyDown(screen.getByRole("menu"), { key: "ArrowDown" })
		).not.toThrow();
		expect(screen.getByRole("menu")).toBeInTheDocument();
	});

	it("moves between the items with the arrow keys, Home and End, round the ends", () => {
		render(<Harness />);
		fireEvent.click(trigger());
		const item = (name: string) => screen.getByRole("menuitem", { name });
		const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });
		expect(press("ArrowDown")).toBe(false);
		expect(item("Two")).toHaveFocus();
		press("ArrowDown");
		press("ArrowDown");
		expect(item("One")).toHaveFocus();
		press("ArrowUp");
		expect(item("Three")).toHaveFocus();
		press("ArrowUp");
		expect(item("Two")).toHaveFocus();
		press("Home");
		expect(item("One")).toHaveFocus();
		press("End");
		expect(item("Three")).toHaveFocus();
		// Any other key is left alone.
		expect(press("a")).toBe(true);
		expect(item("Three")).toHaveFocus();
	});
});
