// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CenterControls, EPISODE_PRESS_GAP_MS } from "./CenterControls";

const noop = () => {};

describe("CenterControls", () => {
	afterEach(cleanup);

	it("skips by the lengths passed in", () => {
		const onSkip = vi.fn();
		render(
			<CenterControls
				visible
				paused={false}
				onPlay={noop}
				onPause={noop}
				skip={{ back: 5, forward: 30 }}
				onSkip={onSkip}
			/>
		);
		fireEvent.click(screen.getByRole("button", { name: "Skip back 5 seconds" }));
		fireEvent.click(screen.getByRole("button", { name: "Skip forward 30 seconds" }));
		expect(onSkip.mock.calls).toEqual([[-5], [30]]);
	});

	it("leaves out the skip buttons when the stream can't seek", () => {
		render(<CenterControls visible paused onPlay={noop} onPause={noop} />);
		expect(screen.queryByRole("button", { name: /Skip/ })).toBeNull();
		expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
	});

	it("shows only the episode buttons that have an episode to go to", () => {
		const onNext = vi.fn();
		render(
			<CenterControls
				visible
				paused={false}
				onPlay={noop}
				onPause={noop}
				onNextEpisode={onNext}
			/>
		);
		expect(screen.queryByRole("button", { name: "Previous episode" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
		expect(onNext).toHaveBeenCalledTimes(1);
	});

	it("pauses while playing and plays while paused", () => {
		const onPlay = vi.fn();
		const onPause = vi.fn();
		const { rerender } = render(
			<CenterControls visible paused={false} onPlay={onPlay} onPause={onPause} />
		);
		fireEvent.click(screen.getByRole("button", { name: "Pause" }));
		rerender(<CenterControls visible paused onPlay={onPlay} onPause={onPause} />);
		fireEvent.click(screen.getByRole("button", { name: "Play" }));
		expect(onPause).toHaveBeenCalledTimes(1);
		expect(onPlay).toHaveBeenCalledTimes(1);
	});

	it("moves one episode for a double-tap on an episode button", () => {
		let t = 1000;
		const clock = vi.spyOn(performance, "now").mockImplementation(() => t);
		const onPrev = vi.fn();
		const onNext = vi.fn();
		render(
			<CenterControls
				visible
				paused={false}
				onPlay={noop}
				onPause={noop}
				onPrevEpisode={onPrev}
				onNextEpisode={onNext}
			/>
		);
		const prev = screen.getByRole("button", { name: "Previous episode" });
		fireEvent.click(prev);
		t += 250;
		fireEvent.click(prev);
		fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
		expect(onPrev).toHaveBeenCalledTimes(1);
		expect(onNext).not.toHaveBeenCalled();
		t += EPISODE_PRESS_GAP_MS;
		fireEvent.click(prev);
		expect(onPrev).toHaveBeenCalledTimes(2);
		clock.mockRestore();
	});
});
