// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { VideoTapLayer, DOUBLE_TAP_MS, SKIP_CHAIN_MS } from "./VideoTapLayer";

// jsdom has no PointerEvent, and without one the events lose their coordinates.
beforeAll(() => {
	if (typeof window.PointerEvent === "function") return;
	class TestPointerEvent extends MouseEvent {
		isPrimary: boolean;
		pointerType: string;
		constructor(type: string, init: PointerEventInit = {}) {
			super(type, init);
			this.isPrimary = init.isPrimary ?? true;
			this.pointerType = init.pointerType ?? "touch";
		}
	}
	window.PointerEvent = TestPointerEvent as typeof PointerEvent;
});

const WIDTH = 1000;
const LEFT = 100;
const MIDDLE = 500;
const RIGHT = 900;

const setup = (seekable = true) => {
	const onSkip = vi.fn();
	const onTap = vi.fn();
	const { container } = render(
		<VideoTapLayer
			seekable={seekable}
			skip={{ back: 10, forward: 30 }}
			onSkip={onSkip}
			onTap={onTap}
		/>
	);
	const layer = container.firstElementChild as HTMLElement;
	vi.spyOn(layer, "getBoundingClientRect").mockReturnValue(
		DOMRect.fromRect({ x: 0, y: 0, width: WIDTH, height: 500 })
	);
	const tap = (x: number) => {
		fireEvent.pointerDown(layer, { clientX: x, clientY: 250 });
		fireEvent.pointerUp(layer, { clientX: x, clientY: 250 });
		vi.advanceTimersByTime(100);
	};
	return { onSkip, onTap, tap, layer };
};

describe("VideoTapLayer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("toggles the controls right away on a tap in the middle", () => {
		const { onSkip, onTap, tap } = setup();
		tap(MIDDLE);
		expect(onTap).toHaveBeenCalledTimes(1);
		expect(onSkip).not.toHaveBeenCalled();
	});

	it("toggles the controls after a short wait on a single tap at the side", () => {
		const { onSkip, onTap, tap } = setup();
		tap(LEFT);
		expect(onTap).not.toHaveBeenCalled();
		vi.advanceTimersByTime(DOUBLE_TAP_MS);
		expect(onTap).toHaveBeenCalledTimes(1);
		expect(onSkip).not.toHaveBeenCalled();
	});

	it("skips on a double-tap without toggling the controls", () => {
		const { onSkip, onTap, tap } = setup();
		tap(LEFT);
		tap(LEFT);
		expect(onSkip).toHaveBeenCalledWith(-10);
		tap(RIGHT);
		tap(RIGHT);
		expect(onSkip).toHaveBeenLastCalledWith(30);
		vi.advanceTimersByTime(SKIP_CHAIN_MS);
		expect(onTap).not.toHaveBeenCalled();
		expect(screen.getByText("+30s")).toBeInTheDocument();
	});

	it("adds up further taps on the same side", () => {
		const { onSkip, onTap, tap } = setup();
		tap(LEFT);
		tap(LEFT);
		tap(LEFT);
		tap(LEFT);
		expect(onSkip).toHaveBeenCalledTimes(3);
		expect(screen.getByText("−30s")).toBeInTheDocument();
		vi.advanceTimersByTime(SKIP_CHAIN_MS);
		expect(onTap).not.toHaveBeenCalled();
	});

	it("only toggles the controls when the stream can't seek", () => {
		const { onSkip, onTap, tap } = setup(false);
		tap(LEFT);
		tap(LEFT);
		expect(onTap).toHaveBeenCalledTimes(2);
		expect(onSkip).not.toHaveBeenCalled();
	});

	it("ignores a swipe", () => {
		const { onSkip, onTap, layer } = setup();
		fireEvent.pointerDown(layer, { clientX: MIDDLE, clientY: 100 });
		fireEvent.pointerUp(layer, { clientX: MIDDLE, clientY: 300 });
		vi.advanceTimersByTime(SKIP_CHAIN_MS);
		expect(onTap).not.toHaveBeenCalled();
		expect(onSkip).not.toHaveBeenCalled();
	});
});
