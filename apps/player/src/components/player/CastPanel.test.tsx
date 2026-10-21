// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { PlaybackCapabilities, PlaybackState } from "@/lib/destination";
import { CastPanel } from "./CastPanel";

const state = (patch: Partial<PlaybackState> = {}): PlaybackState => ({
	status: "playing",
	item: { title: "A Film", contentType: "movie", ref: "mv1" },
	position: 600,
	positionAt: 1000,
	duration: 5400,
	volume: 40,
	subtitles: [],
	subtitleId: null,
	audio: [],
	audioId: null,
	connection: "connected",
	error: null,
	...patch,
});

const capabilities = (patch: Partial<PlaybackCapabilities> = {}): PlaybackCapabilities => ({
	seek: true,
	pause: true,
	volume: "absolute",
	subtitles: "none",
	externalSubtitles: false,
	audioTracks: false,
	resumeAt: true,
	catalog: false,
	...patch,
});

const handlers = () => ({
	onPlay: vi.fn(),
	onPause: vi.fn(),
	onSeek: vi.fn(),
	onVolume: vi.fn(),
	onPlayHere: vi.fn(),
	onStop: vi.fn(),
});

const show = (
	s: PlaybackState,
	caps = capabilities(),
	more: Partial<Parameters<typeof CastPanel>[0]> = {}
) => {
	const on = handlers();
	const view = render(
		<CastPanel name="Hotel TV" state={s} capabilities={caps} {...on} {...more} />
	);
	return { on, view };
};

afterEach(() => {
	vi.useRealTimers();
});

describe("CastPanel", () => {
	it("says where it casts, what, and each status", () => {
		const { view } = show(state());
		expect(screen.getByRole("region", { name: "Google Cast" })).toBeTruthy();
		expect(screen.getByText("Casting to Hotel TV")).toBeTruthy();
		expect(screen.getByText("A Film")).toBeTruthy();
		expect(screen.queryByRole("status")).toBeNull();
		const line = (s: PlaybackState) => {
			view.rerender(
				<CastPanel
					name="Hotel TV"
					state={s}
					capabilities={capabilities()}
					{...handlers()}
				/>
			);
			return screen.queryByRole("status")?.textContent ?? null;
		};
		expect(line(state({ status: "opening" }))).toBe("Starting on the TV…");
		expect(line(state({ status: "buffering" }))).toBe("Buffering…");
		expect(line(state({ status: "ended" }))).toBe("Finished.");
		expect(line(state({ connection: "reconnecting", status: "opening" }))).toBe("Connecting…");
		expect(
			line(state({ error: { code: "failed" }, connection: "reconnecting", status: "error" }))
		).toBe("The stream stopped on the TV.");
		// A load that failed says why.
		expect(
			line(state({ error: { code: "openFailed", message: "refused" }, status: "error" }))
		).toBe("The provider refused the stream. The login may have expired.");
		expect(line(state({ item: null }))).toBeNull();
		expect(screen.queryByText("A Film")).toBeNull();
	});

	it("says it stopped after an error, at the end, or idle with an item", () => {
		const stopped = (s: PlaybackState) => {
			const { view } = show(s);
			const text = screen.getByRole("region").textContent;
			const controls = screen.queryByRole("slider", { name: "Position" });
			view.unmount();
			return { stopped: text?.includes("Stopped on Hotel TV"), controls };
		};
		expect(stopped(state({ error: { code: "failed" }, status: "error" }))).toEqual({
			stopped: true,
			controls: null,
		});
		expect(stopped(state({ status: "ended" })).stopped).toBe(true);
		expect(stopped(state({ status: "idle" })).stopped).toBe(true);
		expect(stopped(state({ status: "idle", item: null })).stopped).toBe(false);
		const going = stopped(state({ status: "paused" }));
		expect(going.stopped).toBe(false);
		expect(going.controls).not.toBeNull();
	});

	it("plays, pauses and keeps playing while it buffers", () => {
		const { on, view } = show(state({ status: "paused" }));
		fireEvent.click(screen.getByRole("button", { name: "Play" }));
		expect(on.onPlay).toHaveBeenCalled();
		view.rerender(
			<CastPanel
				name="Hotel TV"
				state={state({ status: "buffering" })}
				capabilities={capabilities()}
				{...on}
			/>
		);
		fireEvent.click(screen.getByRole("button", { name: "Pause" }));
		expect(on.onPause).toHaveBeenCalled();
		view.rerender(
			<CastPanel
				name="Hotel TV"
				state={state()}
				capabilities={capabilities({ pause: false })}
				{...on}
			/>
		);
		expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
	});

	it("seeks once the slider is let go, by pointer or key", () => {
		const { on } = show(state({ status: "paused" }));
		const slider = screen.getByRole("slider", { name: "Position" });
		expect(slider).toHaveAttribute("max", "5400");
		expect(screen.getByText("10:00")).toBeTruthy();
		fireEvent.change(slider, { target: { value: "900" } });
		expect(screen.getByText("15:00")).toBeTruthy();
		expect(on.onSeek).not.toHaveBeenCalled();
		fireEvent.pointerUp(slider);
		expect(on.onSeek).toHaveBeenCalledWith(900);
		// Let go again without a drag, nothing more.
		fireEvent.pointerUp(slider);
		expect(on.onSeek).toHaveBeenCalledTimes(1);
		fireEvent.change(slider, { target: { value: "60" } });
		fireEvent.keyUp(slider, { key: "ArrowLeft" });
		expect(on.onSeek).toHaveBeenLastCalledWith(60);
		// It shows the receiver's place again.
		expect(screen.getByText("10:00")).toBeTruthy();
	});

	it("has no slider without seeking or a length", () => {
		const { view } = show(state(), capabilities({ seek: false }));
		expect(screen.queryByRole("slider", { name: "Position" })).toBeNull();
		view.unmount();
		show(state({ duration: 0 }));
		expect(screen.queryByRole("slider", { name: "Position" })).toBeNull();
	});

	it("moves the position on each second while it plays", () => {
		vi.useFakeTimers();
		vi.spyOn(performance, "now").mockReturnValue(1000);
		show(state());
		expect(screen.getByText("10:00")).toBeTruthy();
		vi.mocked(performance.now).mockReturnValue(3000);
		act(() => vi.advanceTimersByTime(999));
		expect(screen.getByText("10:00")).toBeTruthy();
		act(() => vi.advanceTimersByTime(1));
		expect(screen.getByText("10:02")).toBeTruthy();
		vi.mocked(performance.now).mockRestore();
	});

	it("stops the clock once it's paused or gone", () => {
		vi.useFakeTimers();
		const clear = vi.spyOn(globalThis, "clearInterval");
		const { view } = show(state());
		view.rerender(
			<CastPanel
				name="Hotel TV"
				state={state({ status: "paused" })}
				capabilities={capabilities()}
				{...handlers()}
			/>
		);
		expect(clear).toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("sets the receiver's volume, unless it's fixed", () => {
		const { on, view } = show(state());
		const volume = screen.getByRole("slider", { name: "Volume" });
		expect(volume).toHaveValue("40");
		fireEvent.change(volume, { target: { value: "70" } });
		expect(on.onVolume).toHaveBeenCalledWith(70);
		view.unmount();
		show(state(), capabilities({ volume: "none" }));
		expect(screen.queryByRole("slider", { name: "Volume" })).toBeNull();
	});

	it("goes to the episode before or after, when there's one", () => {
		const onPrevEpisode = vi.fn();
		const onNextEpisode = vi.fn();
		const { view } = show(state(), capabilities(), { onPrevEpisode, onNextEpisode });
		fireEvent.click(screen.getByRole("button", { name: "Previous episode" }));
		fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
		expect(onPrevEpisode).toHaveBeenCalledTimes(1);
		expect(onNextEpisode).toHaveBeenCalledTimes(1);
		view.unmount();
		show(state());
		expect(screen.queryByRole("button", { name: "Previous episode" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Next episode" })).toBeNull();
	});

	it("plays here from where the receiver is, or from now", () => {
		const { on, view } = show(state({ status: "paused" }));
		fireEvent.click(screen.getByRole("button", { name: "Play here from 10:00" }));
		expect(on.onPlayHere).toHaveBeenCalledWith(600);
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(on.onStop).toHaveBeenCalled();
		view.unmount();
		// Live, or a destination that can't resume, starts here from now.
		for (const [s, caps] of [
			[state({ duration: 0 }), capabilities()],
			[state({ status: "paused" }), capabilities({ resumeAt: false })],
		] as const) {
			const shown = show(s, caps);
			fireEvent.click(screen.getByRole("button", { name: "Play here" }));
			expect(shown.on.onPlayHere).toHaveBeenCalledWith(0);
			shown.view.unmount();
		}
		// From the very start, it just plays here.
		show(state({ status: "paused", position: 0 }));
		expect(screen.getByRole("button", { name: "Play here" })).toBeTruthy();
	});
});
