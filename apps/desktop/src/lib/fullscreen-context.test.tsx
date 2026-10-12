// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach, onTestFinished } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { FullscreenProvider, useFullscreen } from "./fullscreen-context";

const win = vi.hoisted(() => ({ setFullscreen: vi.fn(() => Promise.resolve()) }));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ setFullscreen: win.setFullscreen }),
}));

const Toggle = () => {
	const { isFullscreen, setFullscreen } = useFullscreen();
	return (
		<button onClick={() => setFullscreen(!isFullscreen)}>
			fullscreen={String(isFullscreen)}
		</button>
	);
};

const renderToggle = () =>
	render(
		<FullscreenProvider>
			<Toggle />
		</FullscreenProvider>
	);

describe("FullscreenProvider", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("sets the window along with the state", () => {
		renderToggle();
		fireEvent.click(screen.getByText("fullscreen=false"));
		expect(screen.getByText("fullscreen=true")).toBeTruthy();
		fireEvent.click(screen.getByText("fullscreen=true"));
		expect(screen.getByText("fullscreen=false")).toBeTruthy();
		expect(win.setFullscreen.mock.calls).toEqual([[true], [false]]);
	});

	it("still leaves full screen in the app when the window call fails", async () => {
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		onTestFinished(() => error.mockRestore());
		win.setFullscreen
			.mockRejectedValueOnce(new Error("no window"))
			.mockRejectedValueOnce(new Error("no window"));
		renderToggle();
		fireEvent.click(screen.getByText("fullscreen=false"));
		fireEvent.click(screen.getByText("fullscreen=true"));
		await act(async () => {});
		expect(screen.getByText("fullscreen=false")).toBeTruthy();
		expect(error).toHaveBeenCalledWith(
			"[fullscreen] setFullscreen(false) failed:",
			expect.any(Error)
		);
	});
});
