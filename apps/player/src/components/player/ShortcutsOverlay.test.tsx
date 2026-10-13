// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { playerShortcuts } from "@/lib/hotkeys";

const skip = { back: 10, forward: 10 };

describe("ShortcutsOverlay", () => {
	afterEach(cleanup);

	it("lists every shortcut with its keys", () => {
		render(<ShortcutsOverlay skip={skip} onClose={vi.fn()} />);
		const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
		expect(within(dialog).getAllByRole("listitem")).toHaveLength(playerShortcuts(skip).length);

		const playPause = screen.getByText("Play / pause").closest("li") as HTMLElement;
		const keys = Array.from(playPause.querySelectorAll("kbd")).map((k) => k.textContent);
		expect(keys).toEqual(["Space", "K"]);
	});

	it("uses the chosen skip lengths in the seek rows", () => {
		render(<ShortcutsOverlay skip={{ back: 5, forward: 15 }} onClose={vi.fn()} />);
		// Once for the arrow keys and once for J and L.
		expect(screen.getAllByText("Seek 5s back / 15s forward")).toHaveLength(2);
		expect(screen.queryByText("Seek 10s back / forward")).toBeNull();
	});

	it("moves focus to the close button when it opens", () => {
		render(<ShortcutsOverlay skip={skip} onClose={vi.fn()} />);
		expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
	});

	it("closes from the close button", () => {
		const onClose = vi.fn();
		render(<ShortcutsOverlay skip={skip} onClose={onClose} />);
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("closes on a click beside the panel but not on one inside it", () => {
		const onClose = vi.fn();
		render(<ShortcutsOverlay skip={skip} onClose={onClose} />);
		const dialog = screen.getByRole("dialog");

		fireEvent.click(screen.getByText("Play / pause"));
		fireEvent.click(dialog);
		expect(onClose).not.toHaveBeenCalled();

		fireEvent.click(dialog.parentElement!);
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
