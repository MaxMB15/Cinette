// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Cast } from "lucide-react";
import type { PlaybackCapabilities, PlaybackDestination, PlaybackState } from "@/lib/destination";
import { DestinationView } from "./DestinationView";

const state = (patch: Partial<PlaybackState> = {}): PlaybackState => ({
	status: "playing",
	item: { title: "A Film", contentType: "movie", ref: "mv1" },
	position: 600,
	positionAt: performance.now(),
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

/** A destination whose state the test sets, with every method a mock. */
const fakeDestination = (s: PlaybackState, caps = capabilities()) => {
	let current = s;
	const listeners = new Set<(state: PlaybackState) => void>();
	const ok = () => vi.fn(() => Promise.resolve());
	const destination = {
		id: "cast:tv",
		kind: "cast",
		name: "Hotel TV",
		catalog: { kind: "local" },
		capabilities: caps,
		route: vi.fn(),
		load: ok(),
		play: ok(),
		pause: ok(),
		seek: vi.fn<(value: number) => Promise<void>>(() => Promise.resolve()),
		setVolume: vi.fn<(value: number) => Promise<void>>(() => Promise.resolve()),
		selectSubtitle: vi.fn<(id: string | null) => Promise<void>>(() => Promise.resolve()),
		selectAudio: vi.fn<(id: string) => Promise<void>>(() => Promise.resolve()),
		stop: ok(),
		getState: () => current,
		subscribe: (listener: (state: PlaybackState) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const set = (next: PlaybackState) =>
		act(() => {
			current = next;
			for (const l of listeners) l(next);
		});
	return { destination: destination as unknown as PlaybackDestination & typeof destination, set };
};

const handlers = () => ({
	onFailed: vi.fn(),
	onStop: vi.fn(),
	onPlayHere: vi.fn(),
});

const show = (
	s: PlaybackState = state(),
	caps = capabilities(),
	more: Partial<Parameters<typeof DestinationView>[0]> = {}
) => {
	const fake = fakeDestination(s, caps);
	const on = handlers();
	const view = render(
		<DestinationView
			destination={fake.destination}
			name="Hotel TV"
			label="Google Cast"
			icon={Cast}
			touchLayout={false}
			skip={{ back: 10, forward: 30 }}
			{...on}
			{...more}
		/>
	);
	return { ...fake, on, view };
};

afterEach(() => {
	vi.useRealTimers();
});

describe("DestinationView", () => {
	it("says where it plays and what, with the region named for the destination", () => {
		show();
		const region = screen.getByRole("region", { name: "Google Cast" });
		expect(region).toHaveTextContent("Playing on Hotel TV");
		expect(region).toHaveTextContent("A Film");
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("leaves out the title with no item", () => {
		show(state({ item: null, status: "idle" }));
		expect(screen.queryByText("A Film")).toBeNull();
	});

	it("says where it stands", () => {
		const { set } = show(state({ status: "opening" }));
		expect(screen.getByRole("status")).toHaveTextContent("Starting on Hotel TV…");
		set(state({ status: "buffering" }));
		expect(screen.getByRole("status")).toHaveTextContent("Buffering…");
	});

	it("words an error in the destination's own words", () => {
		show(state({ error: { code: "refused", message: "403" } }), capabilities(), {
			failure: (m) => `It said ${m}.`,
		});
		expect(screen.getByRole("status")).toHaveTextContent("It said 403.");
	});

	it("says it stopped, with only the ways out left", () => {
		show(state({ status: "ended" }));
		expect(screen.getByText(/Stopped on/)).toHaveTextContent("Stopped on Hotel TV");
		expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
		expect(screen.queryByRole("slider")).toBeNull();
		expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
		expect(screen.getByRole("button", { name: /^Play here/ })).toBeTruthy();
	});

	it("pauses while playing or buffering, and plays while paused", () => {
		const { destination, set } = show();
		fireEvent.click(screen.getByRole("button", { name: "Pause" }));
		expect(destination.pause).toHaveBeenCalled();
		set(state({ status: "buffering" }));
		expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
		set(state({ status: "paused" }));
		fireEvent.click(screen.getByRole("button", { name: "Play" }));
		expect(destination.play).toHaveBeenCalled();
	});

	it("has no Pause where it can't pause, but plays when paused", () => {
		const { set } = show(state(), capabilities({ pause: false }));
		expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
		set(state({ status: "paused" }));
		expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
	});

	it("seeks with the bar and the skips, within the item", () => {
		const { destination, set } = show();
		const bar = screen.getByRole("slider", { name: "Seek" });
		fireEvent.keyDown(bar, { key: "End" });
		expect(destination.seek).toHaveBeenLastCalledWith(5400);
		fireEvent.click(screen.getByRole("button", { name: "Skip back 10 seconds" }));
		const back = destination.seek.mock.lastCall![0];
		expect(back).toBeGreaterThanOrEqual(590);
		expect(back).toBeLessThan(592);
		set(state({ position: 5390 }));
		fireEvent.click(screen.getByRole("button", { name: "Skip forward 30 seconds" }));
		expect(destination.seek).toHaveBeenLastCalledWith(5400);
		set(state({ position: 3, status: "paused" }));
		fireEvent.click(screen.getByRole("button", { name: "Skip back 10 seconds" }));
		expect(destination.seek).toHaveBeenLastCalledWith(0);
	});

	it("has no bar or skips without seeking or a length", () => {
		show(state(), capabilities({ seek: false }));
		expect(screen.queryByRole("slider", { name: "Seek" })).toBeNull();
		expect(screen.queryByRole("button", { name: /Skip/ })).toBeNull();
		show(state({ duration: 0 }));
		expect(screen.queryByRole("slider", { name: "Seek" })).toBeNull();
	});

	it("moves the position on each second while it plays", () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
		show(state({ positionAt: performance.now() }));
		expect(screen.getByText("10:00")).toBeTruthy();
		act(() => vi.advanceTimersByTime(2000));
		expect(screen.getByText("10:02")).toBeTruthy();
	});

	it("stops the clock once it's paused", () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] });
		const { set } = show(state({ positionAt: performance.now() }));
		set(state({ status: "paused", positionAt: performance.now() }));
		act(() => vi.advanceTimersByTime(3000));
		expect(screen.getByText("10:00")).toBeTruthy();
	});

	it("sets the volume up to 100, and mutes, unless it's fixed", () => {
		const { destination } = show();
		const volume = screen.getByRole("slider", { name: "Volume" });
		expect(volume).toHaveAttribute("aria-valuemax", "100");
		fireEvent.keyDown(volume, { key: "End" });
		expect(destination.setVolume).toHaveBeenLastCalledWith(100);
		fireEvent.click(screen.getByRole("button", { name: "Mute" }));
		expect(destination.setVolume).toHaveBeenLastCalledWith(0);
		show(state(), capabilities({ volume: "none" }));
		expect(screen.getAllByRole("slider", { name: "Volume" })).toHaveLength(1);
		expect(screen.getAllByRole("button", { name: "Mute" })).toHaveLength(1);
	});

	it("picks subtitles and audio there, and none for no subtitles", () => {
		const tracks = state({
			subtitles: [{ id: "s1", label: "English" }],
			subtitleId: "s1",
			audio: [
				{ id: "a1", label: "English" },
				{ id: "a2", label: "French" },
			],
			audioId: "a1",
		});
		const { destination } = show(
			tracks,
			capabilities({ subtitles: "select", audioTracks: true })
		);
		const subtitles = screen.getByRole("combobox", { name: "Subtitles" });
		expect(subtitles).toHaveValue("s1");
		fireEvent.change(subtitles, { target: { value: "" } });
		expect(destination.selectSubtitle).toHaveBeenLastCalledWith(null);
		fireEvent.change(subtitles, { target: { value: "s1" } });
		expect(destination.selectSubtitle).toHaveBeenLastCalledWith("s1");
		fireEvent.change(screen.getByRole("combobox", { name: "Audio" }), {
			target: { value: "a2" },
		});
		expect(destination.selectAudio).toHaveBeenLastCalledWith("a2");
	});

	it("shows no subtitle picked as none, and leaves out pickers it can't use", () => {
		show(state(), capabilities({ subtitles: "select" }));
		expect(screen.getByRole("combobox", { name: "Subtitles" })).toHaveValue("");
		expect(screen.queryByRole("combobox", { name: "Audio" })).toBeNull();
		show(state({ status: "ended" }), capabilities({ subtitles: "select", audioTracks: true }));
		expect(screen.getAllByRole("combobox")).toHaveLength(1);
	});

	it("goes to the episode before or after, when there's one", () => {
		const onPrevEpisode = vi.fn();
		const onNextEpisode = vi.fn();
		show(state(), capabilities(), { onPrevEpisode, onNextEpisode });
		fireEvent.click(screen.getByRole("button", { name: "Previous episode" }));
		fireEvent.click(screen.getByRole("button", { name: "Next episode" }));
		expect(onPrevEpisode).toHaveBeenCalled();
		expect(onNextEpisode).toHaveBeenCalled();
	});

	it("plays here from where it is, or from the start for live", () => {
		const { on } = show();
		fireEvent.click(screen.getByRole("button", { name: /^Play here from 10:0/ }));
		expect(on.onPlayHere.mock.lastCall![0]).toBeGreaterThanOrEqual(600);
		expect(on.onPlayHere.mock.lastCall![1]).toBeTruthy();
		const live = show(state({ duration: 0 }));
		fireEvent.click(screen.getAllByRole("button", { name: "Play here" })[0]);
		expect(live.on.onPlayHere).toHaveBeenLastCalledWith(0, expect.anything());
		show(state(), capabilities({ resumeAt: false }));
		expect(screen.getAllByRole("button", { name: "Play here" })).toHaveLength(2);
	});

	it("says what Play here does, where it opens a list", () => {
		show(state(), capabilities(), { playHereNote: "Choose this iPhone." });
		expect(screen.getByText("Choose this iPhone.")).toBeTruthy();
	});

	it("has no Play here where there's none", () => {
		show(state(), capabilities(), { onPlayHere: undefined });
		expect(screen.queryByRole("button", { name: /^Play here/ })).toBeNull();
	});

	it("stops", () => {
		const { on } = show();
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(on.onStop).toHaveBeenCalled();
	});

	it("says when a command fails, and whether it was a seek", async () => {
		const { destination, on } = show();
		destination.pause.mockRejectedValueOnce("gone");
		fireEvent.click(screen.getByRole("button", { name: "Pause" }));
		await waitFor(() => expect(on.onFailed).toHaveBeenLastCalledWith("gone", false));
		destination.seek.mockRejectedValueOnce("late");
		fireEvent.click(screen.getByRole("button", { name: "Skip back 10 seconds" }));
		await waitFor(() => expect(on.onFailed).toHaveBeenLastCalledWith("late", true));
	});

	it("uses the touch layout, with play in the middle and no volume slider", () => {
		show(state(), capabilities(), { touchLayout: true });
		expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
		expect(screen.queryByRole("slider", { name: "Volume" })).toBeNull();
		expect(screen.getByRole("button", { name: "Mute" })).toBeTruthy();
	});

	it("has no button in the middle while it plays where it can't pause", () => {
		const { set } = show(state(), capabilities({ pause: false }), { touchLayout: true });
		expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
		expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
		set(state({ status: "paused" }));
		expect(screen.getByRole("button", { name: "Play" })).toBeTruthy();
	});
});
