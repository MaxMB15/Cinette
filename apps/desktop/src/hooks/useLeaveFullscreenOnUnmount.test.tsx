// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useState } from "react";
import { FullscreenProvider, useFullscreen } from "@/lib/fullscreen-context";
import { changeWindowFullscreen, fakeWindow, resetFakeWindow, settle } from "@/test/fake-window";
import { useLeaveFullscreenOnUnmount } from "./useLeaveFullscreenOnUnmount";

vi.mock("@tauri-apps/api/window", () => import("@/test/fake-window"));

const Player = () => {
	const { setFullscreen } = useFullscreen();
	useLeaveFullscreenOnUnmount();
	return <button onClick={() => setFullscreen(true)}>fullscreen</button>;
};

// Stands in for the app: the player page can close while the state lives on.
const App = ({ startOpen }: { startOpen: boolean }) => {
	const [playerOpen, setPlayerOpen] = useState(startOpen);
	const { isFullscreen } = useFullscreen();
	return (
		<>
			{playerOpen && <Player />}
			<button onClick={() => setPlayerOpen(true)}>open player</button>
			<button onClick={() => setPlayerOpen(false)}>close player</button>
			<p>fullscreen={String(isFullscreen)}</p>
		</>
	);
};

const renderApp = async (startOpen = true) => {
	render(
		<FullscreenProvider>
			<App startOpen={startOpen} />
		</FullscreenProvider>
	);
	await act(settle);
};

describe("useLeaveFullscreenOnUnmount", () => {
	afterEach(() => {
		cleanup();
		resetFakeWindow();
	});

	it("leaves fullscreen when the player closes while fullscreen", async () => {
		await renderApp();
		fireEvent.click(screen.getByText("fullscreen"));
		expect(screen.getByText("fullscreen=true")).toBeTruthy();

		fireEvent.click(screen.getByText("close player"));
		expect(screen.getByText("fullscreen=false")).toBeTruthy();
		expect(fakeWindow.setFullscreen.mock.calls).toEqual([[true], [false]]);
	});

	it("leaves the window alone when the player closes outside fullscreen", async () => {
		await renderApp();
		fireEvent.click(screen.getByText("close player"));
		expect(screen.getByText("fullscreen=false")).toBeTruthy();
		expect(fakeWindow.setFullscreen).not.toHaveBeenCalled();
	});

	it("keeps a window that was fullscreen before the player opened", async () => {
		await renderApp(false);
		await changeWindowFullscreen(true);
		fireEvent.click(screen.getByText("open player"));
		fireEvent.click(screen.getByText("close player"));
		expect(screen.getByText("fullscreen=true")).toBeTruthy();
		expect(fakeWindow.setFullscreen).not.toHaveBeenCalled();
	});

	it("leaves fullscreen when the player entered it after the window left", async () => {
		await renderApp(false);
		await changeWindowFullscreen(true);
		fireEvent.click(screen.getByText("open player"));
		await changeWindowFullscreen(false);
		fireEvent.click(screen.getByText("fullscreen"));
		fireEvent.click(screen.getByText("close player"));
		expect(screen.getByText("fullscreen=false")).toBeTruthy();
		expect(fakeWindow.setFullscreen.mock.calls).toEqual([[true], [false]]);
	});
});
