// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { PlaybackCapabilities, PlaybackState } from "@/lib/destination";
import { AirPlayPanel } from "./AirPlayPanel";

const state = (patch: Partial<PlaybackState> = {}): PlaybackState => ({
	status: "playing",
	item: { title: "A Film", contentType: "movie", ref: "mv1" },
	position: 125,
	positionAt: 0,
	duration: 3600,
	volume: 100,
	subtitles: [
		{ id: "0", label: "English" },
		{ id: "1", label: "French" },
	],
	subtitleId: "1",
	audio: [
		{ id: "0", label: "Main" },
		{ id: "1", label: "Commentary" },
	],
	audioId: "1",
	connection: "connected",
	error: null,
	...patch,
});

const all: PlaybackCapabilities = {
	seek: true,
	pause: true,
	volume: "none",
	subtitles: "select",
	externalSubtitles: false,
	audioTracks: true,
	resumeAt: true,
	catalog: false,
};

const show = (s: PlaybackState, capabilities: PlaybackCapabilities = all) => {
	const props = {
		onPlay: vi.fn(),
		onPause: vi.fn(),
		onSeek: vi.fn(),
		onSubtitle: vi.fn(),
		onAudio: vi.fn(),
		onPlayHere: vi.fn(),
		onStop: vi.fn(),
	};
	render(<AirPlayPanel name="Living Room TV" state={s} capabilities={capabilities} {...props} />);
	return props;
};

const status = () => screen.queryByRole("status")?.textContent ?? null;

describe("AirPlayPanel", () => {
	it("says where it plays and what", () => {
		show(state());
		expect(screen.getByText("Playing on Living Room TV")).toBeTruthy();
		expect(screen.getByText("A Film")).toBeTruthy();
		expect(status()).toBeNull();
	});

	it("leaves out the title with no item", () => {
		show(state({ item: null }));
		expect(screen.queryByText("A Film")).toBeNull();
	});

	it("says what the TV is doing", () => {
		const cases: [Partial<PlaybackState>, string][] = [
			[{ status: "opening" }, "Starting on the TV…"],
			[{ status: "buffering" }, "Buffering…"],
			[{ connection: "reconnecting" }, "Reconnecting…"],
		];
		for (const [patch, line] of cases) {
			const { unmount } = render(<></>);
			unmount();
			document.body.innerHTML = "";
			show(state(patch));
			expect(status()).toBe(line);
		}
	});

	it("says it stopped, and why, with only the way back", () => {
		const cases: [Partial<PlaybackState>, string][] = [
			[{ connection: "lost" }, "Lost the connection to the TV."],
			[
				{ connection: "lost", error: { code: "failed", message: "x" } },
				"Lost the connection to the TV.",
			],
			[{ status: "error", error: { code: "refused", message: "Refused." } }, "Refused."],
			[{ status: "error", error: { code: "failed" } }, "The stream stopped on the TV."],
			[{ status: "ended" }, "Finished."],
		];
		for (const [patch, line] of cases) {
			document.body.innerHTML = "";
			show(state(patch));
			expect(screen.getByText("Stopped on Living Room TV")).toBeTruthy();
			expect(status()).toBe(line);
			expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
			expect(screen.queryByRole("slider")).toBeNull();
			expect(screen.queryByRole("combobox")).toBeNull();
			expect(screen.getByRole("button", { name: "Play here from 2:05" })).toBeTruthy();
		}
	});

	it("pauses while playing or buffering, and plays while paused", () => {
		let props = show(state());
		fireEvent.click(screen.getByRole("button", { name: "Pause" }));
		expect(props.onPause).toHaveBeenCalled();
		document.body.innerHTML = "";
		props = show(state({ status: "buffering" }));
		fireEvent.click(screen.getByRole("button", { name: "Pause" }));
		expect(props.onPause).toHaveBeenCalled();
		document.body.innerHTML = "";
		props = show(state({ status: "paused" }));
		fireEvent.click(screen.getByRole("button", { name: "Play" }));
		expect(props.onPlay).toHaveBeenCalled();
		expect(props.onPause).not.toHaveBeenCalled();
	});

	it("seeks along the item", () => {
		const props = show(state());
		const slider = screen.getByRole("slider", { name: "Position" }) as HTMLInputElement;
		expect(slider.min).toBe("0");
		expect(slider.max).toBe("3600");
		expect(slider.step).toBe("1");
		expect(slider.value).toBe("125");
		expect(screen.getByText("2:05")).toBeTruthy();
		expect(screen.getByText("1:00:00")).toBeTruthy();
		fireEvent.change(slider, { target: { value: "300" } });
		expect(props.onSeek).toHaveBeenCalledWith(300);
	});

	it("picks subtitles and audio", () => {
		const props = show(state());
		const subtitles = screen.getByRole("combobox", { name: "Subtitles" }) as HTMLSelectElement;
		expect(subtitles.value).toBe("1");
		expect([...subtitles.options].map((o) => o.text)).toEqual([
			"No subtitles",
			"English",
			"French",
		]);
		fireEvent.change(subtitles, { target: { value: "0" } });
		fireEvent.change(subtitles, { target: { value: "" } });
		expect(props.onSubtitle.mock.calls).toEqual([["0"], [null]]);
		const audio = screen.getByRole("combobox", { name: "Audio" }) as HTMLSelectElement;
		expect(audio.value).toBe("1");
		expect([...audio.options].map((o) => o.text)).toEqual(["Main", "Commentary"]);
		fireEvent.change(audio, { target: { value: "0" } });
		expect(props.onAudio).toHaveBeenCalledWith("0");
	});

	it("shows no subtitle picked as none", () => {
		show(state({ subtitleId: null, audioId: null }));
		const subtitles = screen.getByRole("combobox", { name: "Subtitles" }) as HTMLSelectElement;
		expect(subtitles.value).toBe("");
		expect(subtitles.selectedIndex).toBe(0);
	});

	it("leaves out what the TV can't do", () => {
		show(state(), { ...all, seek: false, pause: false, subtitles: "none", audioTracks: false });
		expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
		expect(screen.queryByRole("slider")).toBeNull();
		expect(screen.queryByRole("combobox")).toBeNull();
	});

	it("plays here from the TV's position, or from now for live", () => {
		let props = show(state());
		fireEvent.click(screen.getByRole("button", { name: "Play here from 2:05" }));
		expect(props.onPlayHere).toHaveBeenCalledWith(125);
		document.body.innerHTML = "";
		props = show(state(), { ...all, resumeAt: false });
		fireEvent.click(screen.getByRole("button", { name: "Play here" }));
		expect(props.onPlayHere).toHaveBeenCalledWith(0);
		document.body.innerHTML = "";
		props = show(state({ position: 0 }));
		fireEvent.click(screen.getByRole("button", { name: "Play here" }));
		expect(props.onPlayHere).toHaveBeenCalledWith(0);
	});

	it("stops", () => {
		const props = show(state());
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		expect(props.onStop).toHaveBeenCalled();
	});
});
