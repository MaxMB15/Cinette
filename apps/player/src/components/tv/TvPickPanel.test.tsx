// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { PlaybackPick } from "@/lib/playback-options";
import { TvPickPanel } from "./TvPickPanel";

const PICKS: PlaybackPick[] = [
	{ key: "en", label: "English", detail: "AAC" },
	{ key: "fr", label: "French" },
	{ key: "de", label: "German", detail: "AC3" },
];

const renderPanel = (current = "fr", picks = PICKS) => {
	const handlers = { onPick: vi.fn(), onClose: vi.fn() };
	const view = render(
		<TvPickPanel
			title="Audio"
			label="Audio tracks"
			picks={picks}
			current={current}
			{...handlers}
		/>
	);
	return { ...handlers, ...view };
};

const row = (name: RegExp) => screen.getByRole("option", { name });
const cursor = () => screen.getByRole("option", { selected: true });

describe("TvPickPanel", () => {
	it("names the panel and its list", () => {
		renderPanel();
		expect(screen.getByRole("dialog", { name: "Audio" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "Audio" })).toBeInTheDocument();
		expect(screen.getByRole("listbox", { name: "Audio tracks" })).toBeInTheDocument();
	});

	it("shows each choice's name, and the line under it when it has one", () => {
		renderPanel();
		expect(within(row(/English/)).getByText("AAC")).toBeInTheDocument();
		expect(row(/French/).querySelectorAll("p")).toHaveLength(1);
		expect(within(row(/German/)).getByText("AC3")).toBeInTheDocument();
	});

	it("opens with the cursor and the focus on the current choice, and marks it", () => {
		renderPanel();
		expect(cursor()).toHaveTextContent("French");
		expect(cursor()).toHaveFocus();
		expect(within(row(/French/)).getByLabelText("Playing")).toBeInTheDocument();
		expect(within(row(/English/)).queryByLabelText("Playing")).not.toBeInTheDocument();
	});

	it("starts at the first choice when the current one isn't in the list", () => {
		renderPanel("es");
		expect(cursor()).toHaveTextContent("English");
		expect(screen.queryByLabelText("Playing")).not.toBeInTheDocument();
	});

	it("moves the cursor with the D-pad, and OK picks the choice under it by its key", () => {
		const { onPick } = renderPanel();
		fireEvent.keyDown(cursor(), { key: "ArrowDown" });
		expect(cursor()).toHaveTextContent("German");
		expect(cursor()).toHaveFocus();
		fireEvent.keyDown(cursor(), { key: "Enter" });
		expect(onPick).toHaveBeenCalledTimes(1);
		expect(onPick).toHaveBeenCalledWith("de");
	});

	it("keeps a row's element when the choices change order", () => {
		const { rerender, onPick, onClose } = renderPanel("en");
		const first = screen.getByText("AAC").closest("[role=option]");
		rerender(
			<TvPickPanel
				title="Audio"
				label="Audio tracks"
				picks={[PICKS[2], PICKS[0], PICKS[1]]}
				current="en"
				onPick={onPick}
				onClose={onClose}
			/>
		);
		expect(screen.getByText("AAC").closest("[role=option]")).toBe(first);
	});

	it("closes on Back without picking", () => {
		const { onClose, onPick } = renderPanel();
		fireEvent.keyDown(cursor(), { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onPick).not.toHaveBeenCalled();
	});
});
