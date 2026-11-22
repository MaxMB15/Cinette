// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { BACKSPACE, CLEAR, SPACE, TvKeys, applyKey } from "./TvKeyboard";

const Keys = ({
	keys = ["a", "b", "c", "d", "e"],
	columns = 2,
	onKey = () => {},
	upper = false,
	start,
}: {
	keys?: readonly string[];
	columns?: number;
	onKey?: (key: string) => void;
	upper?: boolean;
	start?: boolean;
}) => {
	const [active, setActive] = useState(0);
	return (
		<TvKeys
			keys={keys}
			columns={columns}
			active={active}
			onActiveChange={setActive}
			onKey={onKey}
			upper={upper}
			start={start}
		/>
	);
};

const letters = () => screen.getByRole("listbox", { name: "Letters" });
const activeKey = () => screen.getByRole("option", { selected: true });

describe("applyKey", () => {
	it("names the special keys", () => {
		expect([SPACE, BACKSPACE, CLEAR]).toEqual(["space", "backspace", "clear"]);
	});

	it("adds a letter to the end", () => {
		expect(applyKey("ab", "c")).toBe("abc");
	});

	it("adds a space for the space key", () => {
		expect(applyKey("ab", "space")).toBe("ab ");
	});

	it("takes off only the last letter for backspace", () => {
		expect(applyKey("abc", "backspace")).toBe("ab");
	});

	it("leaves empty text empty for backspace", () => {
		expect(applyKey("", "backspace")).toBe("");
	});

	it("empties the text for clear", () => {
		expect(applyKey("abc", "clear")).toBe("");
	});
});

describe("TvKeys", () => {
	it("shows each letter as typed", () => {
		render(<Keys keys={["a", "1"]} />);

		expect(
			within(letters())
				.getAllByRole("option")
				.map((k) => k.textContent)
		).toEqual(["a", "1"]);
	});

	it("shows capitals when upper is on", () => {
		render(<Keys keys={["a", "1"]} upper />);

		expect(
			within(letters())
				.getAllByRole("option")
				.map((k) => k.textContent)
		).toEqual(["A", "1"]);
	});

	it.each([SPACE, BACKSPACE, CLEAR])("shows an icon named for the %s key", (name) => {
		render(<Keys keys={[name]} upper />);

		expect(screen.getByLabelText(name).tagName.toLowerCase()).toBe("svg");
		expect(activeKey()).toHaveTextContent("");
	});

	it("passes OK on a key to the caller by the key's name", () => {
		const onKey = vi.fn();
		render(<Keys onKey={onKey} />);

		fireEvent.keyDown(activeKey(), { key: "Enter" });

		expect(onKey).toHaveBeenCalledWith("a", 0);
	});

	it("passes the lower-case name on even while capitals show", () => {
		const onKey = vi.fn();
		render(<Keys onKey={onKey} upper />);

		fireEvent.keyDown(activeKey(), { key: "Enter" });

		expect(onKey.mock.calls[0][0]).toBe("a");
	});

	it("moves across a row and down a column with the arrows", () => {
		render(<Keys />);

		fireEvent.keyDown(activeKey(), { key: "ArrowRight" });
		expect(activeKey()).toHaveTextContent("b");

		fireEvent.keyDown(activeKey(), { key: "ArrowDown" });
		expect(activeKey()).toHaveTextContent("d");
	});

	it("is as wide as its columns and tall enough for a last row that isn't full", () => {
		render(<Keys />);

		expect(letters().parentElement?.style.width).toBe("5.5rem");
		expect(letters().style.height).toBe("8.25rem");
	});

	it("gives each key a square", () => {
		render(<Keys />);

		expect(activeKey().style.width).toBe("2.75rem");
		expect(activeKey().style.height).toBe("2.75rem");
	});

	it("takes the focus when it opens only if asked to", () => {
		const { unmount } = render(<Keys />);
		expect(document.body).toHaveFocus();
		unmount();

		render(<Keys start />);
		expect(activeKey()).toHaveFocus();
	});

	it("keeps each key's element when the keys change order", () => {
		const { rerender } = render(<Keys keys={["a", "b"]} />);
		const a = screen.getByRole("option", { name: "a" });

		rerender(<Keys keys={["b", "a"]} />);

		expect(screen.getByRole("option", { name: "a" })).toBe(a);
	});
});
