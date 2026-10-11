// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useState } from "react";
import { FullscreenProvider, useFullscreen } from "@/lib/fullscreen-context";

const win = vi.hoisted(() => ({ setFullscreen: vi.fn(() => Promise.resolve()) }));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({ setFullscreen: win.setFullscreen }),
}));

import { useLeaveFullscreenOnUnmount } from "./useLeaveFullscreenOnUnmount";

const Player = () => {
	const { setFullscreen } = useFullscreen();
	useLeaveFullscreenOnUnmount();
	return <button onClick={() => setFullscreen(true)}>fullscreen</button>;
};

// Stands in for the app: the player page can close while the state lives on.
const App = () => {
	const [playerOpen, setPlayerOpen] = useState(true);
	const { isFullscreen } = useFullscreen();
	return (
		<>
			{playerOpen && <Player />}
			<button onClick={() => setPlayerOpen(false)}>close player</button>
			<p>fullscreen={String(isFullscreen)}</p>
		</>
	);
};

const renderApp = () =>
	render(
		<FullscreenProvider>
			<App />
		</FullscreenProvider>
	);

describe("useLeaveFullscreenOnUnmount", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("leaves fullscreen when the player closes while fullscreen", () => {
		renderApp();
		fireEvent.click(screen.getByText("fullscreen"));
		expect(screen.getByText("fullscreen=true")).toBeTruthy();

		fireEvent.click(screen.getByText("close player"));
		expect(screen.getByText("fullscreen=false")).toBeTruthy();
		expect(win.setFullscreen).toHaveBeenCalledTimes(1);
		expect(win.setFullscreen).toHaveBeenCalledWith(false);
	});

	it("leaves the window alone when the player closes outside fullscreen", () => {
		renderApp();
		fireEvent.click(screen.getByText("close player"));
		expect(screen.getByText("fullscreen=false")).toBeTruthy();
		expect(win.setFullscreen).not.toHaveBeenCalled();
	});
});
