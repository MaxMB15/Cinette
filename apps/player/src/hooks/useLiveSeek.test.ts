// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useLiveSeek } from "./useLiveSeek";

type Options = Parameters<typeof useLiveSeek>[0];

const PLAYING: Options = { session: "a", playing: true, position: 100, positionAt: 5000 };

const render = (initial: Options) =>
	renderHook((options: Options) => useLiveSeek(options), { initialProps: initial });

describe("useLiveSeek", () => {
	it("is at the live edge while it plays", () => {
		const { result } = render(PLAYING);
		expect(result.current.edge).toBe(100);
		expect(result.current.behind).toBe(0);
	});

	it("falls behind while paused", () => {
		const { result, rerender } = render(PLAYING);
		rerender({ ...PLAYING, playing: false, positionAt: 15_000 });
		expect(result.current.edge).toBe(110);
		expect(result.current.behind).toBe(10);
	});

	it("stays behind after a seek back", () => {
		const { result, rerender } = render(PLAYING);
		rerender({ ...PLAYING, position: 70, positionAt: 6000 });
		expect(result.current.behind).toBe(31);
		rerender({ ...PLAYING, position: 71, positionAt: 7000 });
		expect(result.current.behind).toBe(31);
	});

	it("follows the stream as it catches up", () => {
		const { result, rerender } = render(PLAYING);
		rerender({ ...PLAYING, position: 105, positionAt: 6000 });
		expect(result.current.anchor).toEqual({ position: 105, at: 6000 });
		expect(result.current.behind).toBe(0);
	});

	it("starts over with a new stream", () => {
		const { result, rerender } = render(PLAYING);
		rerender({ ...PLAYING, session: "b", position: 20, positionAt: 9000 });
		expect(result.current.anchor).toEqual({ position: 20, at: 9000 });
	});

	it("knows nothing of a stream that hasn't played yet", () => {
		const { result } = render({ ...PLAYING, playing: false });
		expect(result.current.edge).toBeNull();
		expect(result.current.behind).toBe(0);
	});

	it("forgets the stream when nothing live plays", () => {
		const { result, rerender } = render(PLAYING);
		rerender({ ...PLAYING, session: null });
		expect(result.current.anchor).toBeNull();
		rerender(PLAYING);
		expect(result.current.anchor).toEqual({ position: 100, at: 5000 });
	});
});
