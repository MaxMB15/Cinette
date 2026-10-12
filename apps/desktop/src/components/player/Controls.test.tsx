// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { Controls } from "./Controls";
import type { PlayerState } from "@/lib/types";

const noop = () => {};

const playing: PlayerState = {
	isPlaying: true,
	isPaused: false,
	currentUrl: "http://example.com/episode.mkv",
	volume: 100,
	position: 120,
	duration: 1800,
};

const renderControls = (touchLayout: boolean, hideCenterControls = false) =>
	render(
		<Controls
			state={playing}
			visible
			onPlay={noop}
			onPause={noop}
			onStop={noop}
			onSeek={noop}
			onVolumeChange={noop}
			skip={{ back: 10, forward: 10 }}
			onSkip={vi.fn()}
			onPrevEpisode={noop}
			onNextEpisode={noop}
			touchLayout={touchLayout}
			hideCenterControls={hideCenterControls}
		/>
	);

describe("Controls", () => {
	afterEach(cleanup);

	it("moves play and the skip buttons to the middle row on touch layouts", () => {
		renderControls(true);
		const pause = screen.getByRole("button", { name: "Pause" });
		const middleRow = pause.parentElement!;
		expect(screen.getAllByRole("button", { name: "Pause" })).toHaveLength(1);
		expect(middleRow).toContainElement(
			screen.getByRole("button", { name: "Skip back 10 seconds" })
		);
	});

	it("keeps the episode buttons out of the middle row, where a double-tap skips", () => {
		renderControls(true);
		const middleRow = screen.getByRole("button", { name: "Pause" }).parentElement!;
		for (const name of ["Previous episode", "Next episode"]) {
			const button = screen.getByRole("button", { name });
			expect(middleRow).not.toContainElement(button);
		}
	});

	it("leaves out play, pause and skip while the stream can't play", () => {
		for (const touchLayout of [true, false]) {
			renderControls(touchLayout, true);
			expect(screen.queryByRole("button", { name: /^(Play|Pause)$/ })).toBeNull();
			expect(screen.queryByRole("button", { name: /^Skip/ })).toBeNull();
			// Stop still works, to give up on a stream that won't open.
			expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
			cleanup();
		}
	});

	it("shows the episode buttons in the bar on desktop", () => {
		renderControls(false);
		expect(screen.getByRole("button", { name: "Previous episode" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Next episode" })).toBeInTheDocument();
	});
});
