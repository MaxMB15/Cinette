// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, screen } from "@testing-library/react";
import { installPointerEvent } from "@/test/pointer-event";
import { VideoTapLayer, DOUBLE_TAP_MS, SKIP_CHAIN_MS } from "./VideoTapLayer";

installPointerEvent();

const WIDTH = 1000;
const LEFT = 100;
const MIDDLE = 500;
const RIGHT = 900;

/** A finger on the screen at `x`, `y`. */
const finger = (x: number, y = 250) => ({ clientX: x, clientY: y, pointerType: "touch" });

const setup = (seekable = true) => {
	// Adds up skips in the same direction, as the player does. The label shows the total.
	let total = 0;
	const onSkip = vi.fn((seconds: number) =>
		Math.sign(total) === Math.sign(seconds) ? (total += seconds) : (total = seconds)
	);
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
		fireEvent.pointerDown(layer, finger(x));
		fireEvent.pointerUp(layer, finger(x));
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

	it("shows how far the player really skipped", () => {
		const { onSkip, tap } = setup();
		onSkip.mockReturnValueOnce(-4);
		tap(LEFT);
		tap(LEFT);
		expect(screen.getByText("−4s")).toBeInTheDocument();
	});

	it("drops a waiting tap at the side when a tap in the middle follows", () => {
		const { onSkip, onTap, tap } = setup();
		tap(LEFT);
		tap(MIDDLE);
		vi.advanceTimersByTime(DOUBLE_TAP_MS);
		expect(onTap).toHaveBeenCalledTimes(1);
		expect(onSkip).not.toHaveBeenCalled();
	});

	it("drops a waiting tap on one side when a tap on the other side follows", () => {
		const { onSkip, onTap, tap } = setup();
		tap(LEFT);
		tap(RIGHT);
		vi.advanceTimersByTime(DOUBLE_TAP_MS);
		expect(onTap).toHaveBeenCalledTimes(1);
		expect(onSkip).not.toHaveBeenCalled();
	});

	it("ignores a release whose press started somewhere else", () => {
		const { onSkip, onTap, layer } = setup();
		fireEvent.pointerUp(layer, finger(MIDDLE));
		fireEvent.pointerUp(layer, finger(LEFT));
		vi.advanceTimersByTime(SKIP_CHAIN_MS);
		expect(onTap).not.toHaveBeenCalled();
		expect(onSkip).not.toHaveBeenCalled();
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
		fireEvent.pointerDown(layer, finger(MIDDLE, 100));
		fireEvent.pointerUp(layer, finger(MIDDLE, 300));
		vi.advanceTimersByTime(SKIP_CHAIN_MS);
		expect(onTap).not.toHaveBeenCalled();
		expect(onSkip).not.toHaveBeenCalled();
	});
});
