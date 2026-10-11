// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubtitlePicker } from "./SubtitlePicker";

vi.mock("@/lib/tauri", () => ({
	searchSubtitles: vi.fn(() => new Promise(() => {})),
	downloadSubtitle: vi.fn(),
	readSubtitleFile: vi.fn(),
	mpvSubAdd: vi.fn(),
	mpvSubRemove: vi.fn(),
}));

// Holds the delay the way VideoPlayer does, so each change comes back as a prop.
const Harness = () => {
	const [delay, setDelay] = useState(0);
	return (
		<SubtitlePicker
			imdbId="tt0000001"
			onClose={() => {}}
			subtitleDelay={delay}
			onDelayChange={setDelay}
		/>
	);
};

const openSettings = () => {
	fireEvent.click(screen.getByRole("button", { name: "Subtitle settings" }));
};

describe("SubtitlePicker delay buttons", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("keeps stepping while the button is held", () => {
		render(<Harness />);
		openSettings();
		const plus = screen.getByText("+");

		fireEvent.mouseDown(plus);
		expect(screen.getByText("+0.1s")).toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(screen.getByText("+0.3s")).toBeInTheDocument();

		fireEvent.mouseUp(plus);
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(screen.getByText("+0.3s")).toBeInTheDocument();
	});

	it("steps backwards while minus is held", () => {
		render(<Harness />);
		openSettings();
		const minus = screen.getByText("−");

		fireEvent.mouseDown(minus);
		act(() => {
			vi.advanceTimersByTime(200);
		});
		fireEvent.mouseLeave(minus);
		expect(screen.getByText("-0.2s")).toBeInTheDocument();
	});
});
