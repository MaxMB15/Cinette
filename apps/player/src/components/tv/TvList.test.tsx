// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, type ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Dialog } from "@/components/ui/dialog";
import { TV_LIST_ATTRIBUTE, TV_START_ATTRIBUTE } from "@/lib/tv-focus";
import { TvList, type TvListProps } from "./TvList";

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `Item ${i}`);

type ListProps = Partial<TvListProps<string>>;

/** A list that keeps its own cursor, as every screen does. Five rows fit by default. */
const List = ({
	initial = 0,
	onMove,
	...props
}: ListProps & { initial?: number; onMove?: (index: number) => void }) => {
	const [active, setActive] = useState(initial);
	return (
		<TvList
			items={numbered(20)}
			label="Things"
			itemKey={(item) => item}
			renderItem={(item) => item}
			rowHeight={2}
			height={10}
			active={active}
			onActiveChange={(index) => {
				onMove?.(index);
				setActive(index);
			}}
			{...props}
		/>
	);
};

const list = () => screen.getByRole("listbox", { name: "Things" });
const row = (name: string) => screen.getByRole("option", { name });
const activeRow = () => screen.getByRole("option", { selected: true });
const rowNames = () => screen.getAllByRole("option").map((option) => option.textContent);

describe("TvList", () => {
	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	describe("what it shows", () => {
		it("names the list and marks it for the D-pad, at the height it was given", () => {
			render(<List />);
			expect(list()).toHaveAttribute(TV_LIST_ATTRIBUTE, "");
			expect(list().style.height).toBe("10rem");
		});

		it("makes only the active row a tab stop, and tells screen readers which it is", () => {
			render(<List initial={2} />);
			const active = row("Item 2");
			expect(activeRow()).toBe(active);
			expect(active).toHaveAttribute("tabindex", "0");
			expect(active).toHaveAttribute("data-active", "");
			expect(list()).toHaveAttribute("aria-activedescendant", active.id);

			const other = row("Item 1");
			expect(other).toHaveAttribute("aria-selected", "false");
			expect(other).toHaveAttribute("tabindex", "-1");
			expect(other).not.toHaveAttribute("data-active");
			expect(other.id).not.toBe(active.id);
		});

		it("leaves every row out of the tab order when it isn't focusable, still saying which is active", () => {
			render(<List initial={2} focusable={false} start />);
			const active = row("Item 2");
			expect(activeRow()).toBe(active);
			expect(active).toHaveAttribute("tabindex", "-1");
			expect(active).not.toHaveAttribute("data-active");
			expect(active).not.toHaveAttribute(TV_START_ATTRIBUTE);
		});

		it("gives each row its place in the list to render with", () => {
			const renderItem = vi.fn((item: string, index: number) => `${index}: ${item}`);
			render(<List renderItem={renderItem} items={["a", "b"]} />);
			expect(rowNames()).toEqual(["0: a", "1: b"]);
		});

		it("mounts only the rows on screen and one more on each side", () => {
			render(<List initial={10} />);
			expect(rowNames()).toEqual(numbered(20).slice(7, 14));
		});

		it("mounts one extra row below when the cursor is at the top", () => {
			render(<List />);
			expect(rowNames()).toEqual(numbered(20).slice(0, 6));
		});

		it("mounts one extra row above when the cursor is at the end", () => {
			render(<List initial={19} />);
			expect(rowNames()).toEqual(numbered(20).slice(14, 20));
		});

		it("mounts whole rows of a grid", () => {
			render(<List initial={30} items={numbered(60)} columns={3} columnWidth={4} />);
			expect(rowNames()).toEqual(numbered(60).slice(21, 42));
		});

		it("shows one row when the list is too short for any", () => {
			render(<List initial={5} height={1} />);
			expect(rowNames()).toEqual(numbered(20).slice(4, 7));
		});

		it("places the rows from the first one on screen, keeping the cursor in the middle", () => {
			render(<List initial={10} />);
			const first = row("Item 8");
			expect(first.style.top).toBe("0rem");
			expect(first.style.height).toBe("2rem");
			expect(row("Item 10").style.top).toBe("4rem");
			expect(row("Item 7").style.top).toBe("-2rem");
		});

		it("makes the rows of a list as wide as the list", () => {
			render(<List />);
			expect(row("Item 0").style.width).toBe("100%");
			expect(row("Item 0").style.left).toBe("0px");
		});

		it("lays the items out in columns of the width it was given", () => {
			render(<List items={numbered(9)} columns={3} columnWidth={4} />);
			const item = row("Item 5");
			expect(item.style.left).toBe("8rem");
			expect(item.style.top).toBe("2rem");
			expect(item.style.width).toBe("4rem");
			expect(row("Item 3").style.left).toBe("0rem");
		});

		it("stops scrolling a grid at its last row, even a short one", () => {
			render(<List initial={58} items={numbered(59)} columns={3} columnWidth={4} />);
			// Twenty rows, the last five of them on screen.
			expect(row("Item 45").style.top).toBe("0rem");
			expect(row("Item 58").style.top).toBe("8rem");
		});

		it("keeps the cursor on the last row when the list gets shorter", () => {
			const { rerender } = render(<List initial={4} items={numbered(5)} />);
			expect(activeRow()).toBe(row("Item 4"));
			rerender(<List initial={4} items={numbered(2)} />);
			expect(activeRow()).toBe(row("Item 1"));
		});

		it("keeps the cursor on the first row when asked for a place before it", () => {
			render(<List initial={-3} items={numbered(3)} />);
			expect(activeRow()).toBe(row("Item 0"));
		});

		it("shows nothing and points at nothing when it's empty", () => {
			render(<List items={[]} />);
			expect(screen.queryAllByRole("option")).toEqual([]);
			expect(list()).not.toHaveAttribute("aria-activedescendant");
		});
	});

	describe("moving with the D-pad", () => {
		it.each([
			["ArrowDown", 4],
			["ArrowUp", 2],
		])("moves one row in a list with %s, keeping the press from the page", (key, expected) => {
			const onMove = vi.fn();
			render(<List initial={3} onMove={onMove} />);
			expect(fireEvent.keyDown(activeRow(), { key })).toBe(false);
			expect(onMove).toHaveBeenCalledExactlyOnceWith(expected);
			expect(activeRow()).toBe(row(`Item ${expected}`));
		});

		it.each([
			["ArrowUp", 0],
			["ArrowDown", 19],
			["ArrowLeft", 5],
			["ArrowRight", 5],
		])("lets %s at the edge of a list go on to the D-pad's focus handling", (key, start) => {
			const onMove = vi.fn();
			render(<List initial={start} onMove={onMove} />);
			expect(fireEvent.keyDown(activeRow(), { key })).toBe(true);
			expect(onMove).not.toHaveBeenCalled();
		});

		it("moves across and down a grid", () => {
			const onMove = vi.fn();
			render(
				<List initial={4} items={numbered(9)} columns={3} columnWidth={4} onMove={onMove} />
			);

			expect(fireEvent.keyDown(activeRow(), { key: "ArrowRight" })).toBe(false);
			expect(onMove).toHaveBeenLastCalledWith(5);
			expect(activeRow()).toBe(row("Item 5"));

			expect(fireEvent.keyDown(activeRow(), { key: "ArrowDown" })).toBe(false);
			expect(onMove).toHaveBeenLastCalledWith(8);

			expect(fireEvent.keyDown(activeRow(), { key: "ArrowLeft" })).toBe(false);
			expect(onMove).toHaveBeenLastCalledWith(7);

			expect(fireEvent.keyDown(activeRow(), { key: "ArrowUp" })).toBe(false);
			expect(onMove).toHaveBeenLastCalledWith(4);
		});

		it("lets a press past a grid's side leave it, so the column beside it can take the focus", () => {
			const onMove = vi.fn();
			render(
				<List initial={3} items={numbered(9)} columns={3} columnWidth={4} onMove={onMove} />
			);
			expect(fireEvent.keyDown(activeRow(), { key: "ArrowLeft" })).toBe(true);
			expect(onMove).not.toHaveBeenCalled();
		});

		it("ignores other keys", () => {
			const onMove = vi.fn();
			render(<List initial={3} onMove={onMove} />);
			expect(fireEvent.keyDown(activeRow(), { key: "a" })).toBe(true);
			expect(onMove).not.toHaveBeenCalled();
		});

		it.each(["altKey", "ctrlKey", "metaKey", "shiftKey"])(
			"leaves any key alone with %s held",
			(modifier) => {
				const onMove = vi.fn();
				const onSelect = vi.fn();
				render(<List initial={3} onMove={onMove} onSelect={onSelect} />);
				for (const key of ["ArrowDown", "PageDown", "Enter"]) {
					expect(fireEvent.keyDown(activeRow(), { key, [modifier]: true })).toBe(true);
				}
				expect(onMove).not.toHaveBeenCalled();
				expect(onSelect).not.toHaveBeenCalled();
			}
		);

		it("does nothing with an arrow when the list is empty", () => {
			const onMove = vi.fn();
			render(<List items={[]} onMove={onMove} />);
			expect(fireEvent.keyDown(list(), { key: "ArrowDown" })).toBe(true);
			expect(onMove).not.toHaveBeenCalled();
		});
	});

	describe("holding an arrow", () => {
		/** Presses a key once and repeats it, as a remote does while it's held. */
		const hold = (key: string, repeats: number) => {
			fireEvent.keyDown(activeRow(), { key });
			for (let i = 0; i < repeats; i++) fireEvent.keyDown(activeRow(), { key, repeat: true });
		};

		/** Which row has the cursor, and how far along it says that is. */
		const expectAt = (name: string, position = "") => {
			expect(activeRow()).toHaveAccessibleName(name);
			expect(activeRow().textContent).toBe(name + position);
		};

		it("moves one row at a time at first, and says nothing", () => {
			render(<List items={numbered(5000)} />);
			hold("ArrowDown", 29);
			expectAt("Item 30");
		});

		it("moves five rows at a time after a while, and says how far along it is", () => {
			render(<List items={numbered(5000)} />);
			hold("ArrowDown", 30);
			expectAt("Item 35", "36 of 5,000");
		});

		it("moves up as fast as down", () => {
			render(<List items={numbered(5000)} initial={100} />);
			hold("ArrowUp", 30);
			expectAt("Item 65", "66 of 5,000");
		});

		it("moves more rows still when it's held for longer", () => {
			render(<List items={numbered(5000)} />);
			hold("ArrowDown", 90);
			// 30 presses of one row, 60 of five, and the last of 25.
			expectAt("Item 355", "356 of 5,000");
		});

		it("stops at the last row and the first", () => {
			const onMove = vi.fn();
			render(<List items={numbered(40)} onMove={onMove} />);
			hold("ArrowDown", 31);
			expectAt("Item 39", "40 of 40");
			// The screen keeps this as its place, so it has to be on the list.
			expect(onMove).toHaveBeenLastCalledWith(39);
			cleanup();

			render(<List items={numbered(40)} initial={33} />);
			hold("ArrowUp", 31);
			expectAt("Item 0", "1 of 40");
		});

		it("starts over at one row after the key is let go, and stops saying how far along", () => {
			render(<List items={numbered(5000)} />);
			hold("ArrowDown", 30);

			fireEvent.keyUp(activeRow(), { key: "ArrowDown" });
			expectAt("Item 35");

			fireEvent.keyDown(activeRow(), { key: "ArrowDown" });
			fireEvent.keyDown(activeRow(), { key: "ArrowDown", repeat: true });
			expectAt("Item 37");
		});

		it("slows down with a new press even if it never saw the key go up", () => {
			render(<List items={numbered(5000)} />);
			hold("ArrowDown", 30);

			fireEvent.keyDown(activeRow(), { key: "ArrowUp" });
			expectAt("Item 34");
		});

		it("stops saying how far along when the focus leaves the list", () => {
			render(
				<>
					<List items={numbered(5000)} />
					<button type="button">Elsewhere</button>
				</>
			);
			hold("ArrowDown", 30);

			fireEvent.blur(activeRow(), { relatedTarget: screen.getByRole("button") });
			expectAt("Item 35");
		});

		it("still says how far along when a row leaves the page with the focus", () => {
			render(<List items={numbered(5000)} />);
			hold("ArrowDown", 30);

			fireEvent.blur(activeRow(), { relatedTarget: null });
			expectAt("Item 35", "36 of 5,000");
		});

		it("keeps a grid to one row at a time", () => {
			render(<List items={numbered(5000)} columns={2} columnWidth={3} />);
			hold("ArrowDown", 40);
			expectAt("Item 82");
		});
	});

	describe("paging", () => {
		it.each([
			["PageDown", 12],
			["ChannelDown", 12],
			["PageUp", 2],
			["ChannelUp", 2],
		])("moves a whole screen of rows with %s", (key, expected) => {
			const onMove = vi.fn();
			render(<List initial={7} onMove={onMove} />);
			expect(fireEvent.keyDown(activeRow(), { key })).toBe(false);
			expect(onMove).toHaveBeenCalledExactlyOnceWith(expected);
		});

		it.each([
			["PageUp", 1, 0],
			["ChannelUp", 1, 0],
			["PageDown", 17, 19],
			["ChannelDown", 17, 19],
		])("stops at the end of the list with %s", (key, start, expected) => {
			const onMove = vi.fn();
			render(<List initial={start} onMove={onMove} />);
			expect(fireEvent.keyDown(activeRow(), { key })).toBe(false);
			expect(onMove).toHaveBeenCalledExactlyOnceWith(expected);
		});

		it("moves a whole screen of a grid's rows", () => {
			const onMove = vi.fn();
			render(
				<List
					initial={30}
					items={numbered(60)}
					columns={3}
					columnWidth={4}
					onMove={onMove}
				/>
			);
			fireEvent.keyDown(activeRow(), { key: "PageDown" });
			expect(onMove).toHaveBeenLastCalledWith(45);
			fireEvent.keyDown(activeRow(), { key: "PageUp" });
			expect(onMove).toHaveBeenLastCalledWith(30);
		});

		it("leaves the press alone when the list is empty", () => {
			const onMove = vi.fn();
			render(<List items={[]} onMove={onMove} />);
			expect(fireEvent.keyDown(list(), { key: "PageDown" })).toBe(true);
			expect(onMove).not.toHaveBeenCalled();
		});
	});

	describe("OK and clicks", () => {
		it("selects the active row on OK, keeping the press from the page", () => {
			const onSelect = vi.fn();
			render(<List initial={3} onSelect={onSelect} />);
			expect(fireEvent.keyDown(activeRow(), { key: "Enter" })).toBe(false);
			expect(onSelect).toHaveBeenCalledExactlyOnceWith("Item 3", 3);
		});

		it("selects the first item for a place past the end's clamp", () => {
			const onSelect = vi.fn();
			render(<List initial={99} items={numbered(2)} onSelect={onSelect} />);
			fireEvent.keyDown(activeRow(), { key: "Enter" });
			expect(onSelect).toHaveBeenCalledExactlyOnceWith("Item 1", 1);
		});

		it("lets OK through when there's nothing to do with it", () => {
			const onMove = vi.fn();
			render(<List initial={3} onMove={onMove} />);
			expect(fireEvent.keyDown(activeRow(), { key: "Enter" })).toBe(true);
			expect(onMove).not.toHaveBeenCalled();
		});

		it("lets OK through when the list is empty", () => {
			const onSelect = vi.fn();
			render(<List items={[]} onSelect={onSelect} />);
			expect(fireEvent.keyDown(list(), { key: "Enter" })).toBe(true);
			expect(onSelect).not.toHaveBeenCalled();
		});

		it("selects an item that's falsy but there", () => {
			const onSelect = vi.fn();
			render(<List items={[""]} itemKey={() => "only"} onSelect={onSelect} />);
			expect(fireEvent.keyDown(activeRow(), { key: "Enter" })).toBe(false);
			expect(onSelect).toHaveBeenCalledExactlyOnceWith("", 0);
		});

		it("moves the cursor to a clicked row and selects it", () => {
			const onSelect = vi.fn();
			const onMove = vi.fn();
			render(<List onSelect={onSelect} onMove={onMove} />);
			fireEvent.click(row("Item 2"));
			expect(onMove).toHaveBeenCalledExactlyOnceWith(2);
			expect(onSelect).toHaveBeenCalledExactlyOnceWith("Item 2", 2);
			expect(activeRow()).toBe(row("Item 2"));
		});

		it("only moves the cursor on a click when there's nothing to select", () => {
			const onMove = vi.fn();
			render(<List onMove={onMove} />);
			fireEvent.click(row("Item 2"));
			expect(onMove).toHaveBeenCalledExactlyOnceWith(2);
		});
	});

	describe("the start row", () => {
		it("takes the focus when the screen opens with nothing focused, without scrolling", () => {
			const focus = vi.spyOn(HTMLElement.prototype, "focus");
			render(<List initial={2} start />);
			expect(document.activeElement).toBe(row("Item 2"));
			expect(row("Item 2")).toHaveAttribute(TV_START_ATTRIBUTE, "");
			expect(row("Item 1")).not.toHaveAttribute(TV_START_ATTRIBUTE);
			expect(focus).toHaveBeenCalledWith({ preventScroll: true });
		});

		it("leaves the focus alone without the start prop", () => {
			render(<List />);
			expect(document.activeElement).toBe(document.body);
			expect(activeRow()).not.toHaveAttribute(TV_START_ATTRIBUTE);
		});

		it("leaves the focus where it is when something else already has it", () => {
			render(<button type="button">Elsewhere</button>);
			const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
			elsewhere.focus();
			render(<List start />);
			expect(document.activeElement).toBe(elsewhere);
		});

		it("leaves the focus to a modal that's open", () => {
			render(
				<Dialog label="Over it" onClose={() => {}}>
					<p>A dialog with nothing to focus</p>
				</Dialog>
			);
			(document.activeElement as HTMLElement).blur();
			expect(document.activeElement).toBe(document.body);
			render(<List start />);
			expect(document.activeElement).toBe(document.body);
		});

		it("takes the focus when its items arrive after the screen opened", () => {
			const { rerender } = render(<List start items={[]} />);
			expect(document.activeElement).toBe(document.body);
			rerender(<List start items={numbered(3)} />);
			expect(document.activeElement).toBe(row("Item 0"));
		});

		it("takes the focus when it becomes the start while nothing has it", () => {
			const { rerender } = render(<List />);
			expect(document.activeElement).toBe(document.body);
			rerender(<List start />);
			expect(document.activeElement).toBe(row("Item 0"));
		});
	});

	describe("keeping the focus on the active row", () => {
		const WithButton = (props: ComponentProps<typeof List>) => (
			<>
				<button type="button">Elsewhere</button>
				<List {...props} />
			</>
		);

		it("moves the focus with the cursor, without scrolling", () => {
			render(<WithButton initial={2} />);
			activeRow().focus();
			const focus = vi.spyOn(HTMLElement.prototype, "focus");
			fireEvent.keyDown(activeRow(), { key: "ArrowDown" });
			expect(document.activeElement).toBe(row("Item 3"));
			expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
		});

		it("doesn't take the focus when the cursor moves while it's elsewhere", () => {
			const { rerender } = render(<WithButton initial={2} />);
			fireEvent.keyDown(activeRow(), { key: "ArrowDown" });
			expect(activeRow()).toBe(row("Item 3"));
			expect(document.activeElement).toBe(document.body);
			rerender(<WithButton initial={2} />);
			expect(document.activeElement).toBe(document.body);
		});

		it("lets go of the focus when it moves out of the list", () => {
			render(<WithButton initial={2} />);
			const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
			activeRow().focus();
			elsewhere.focus();
			fireEvent.keyDown(within(list()).getByRole("option", { selected: true }), {
				key: "ArrowDown",
			});
			expect(activeRow()).toBe(row("Item 3"));
			expect(document.activeElement).toBe(elsewhere);
		});

		it("keeps the focus when it moves from row to row", () => {
			render(<WithButton initial={2} />);
			activeRow().focus();
			row("Item 1").focus();
			fireEvent.keyDown(activeRow(), { key: "ArrowDown" });
			expect(document.activeElement).toBe(row("Item 3"));
		});

		it("copes with its rows going away while it holds the focus", () => {
			const { rerender } = render(<WithButton />);
			activeRow().focus();
			rerender(<WithButton items={[]} />);
			expect(screen.queryAllByRole("option")).toEqual([]);
		});

		it("takes the focus to the new active row when the old one leaves the page", () => {
			render(<WithButton initial={2} />);
			const active = activeRow();
			active.focus();
			// A row that unmounts blurs with nothing next to take the focus.
			fireEvent.blur(active, { relatedTarget: null });
			fireEvent.keyDown(activeRow(), { key: "ArrowDown" });
			expect(document.activeElement).toBe(row("Item 3"));
		});
	});
});
