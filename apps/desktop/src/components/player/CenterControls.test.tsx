// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { CenterControls } from "./CenterControls";

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
});
