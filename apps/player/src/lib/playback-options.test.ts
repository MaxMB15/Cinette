// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import {
	audioPicks,
	audioTrackName,
	PLAYBACK_SPEEDS,
	sourcePicks,
	speedLabel,
	speedPicks,
} from "./playback-options";
import type { MpvTrack } from "./types";

const track = (over: Partial<MpvTrack> = {}): MpvTrack => ({
	id: 2,
	kind: "audio",
	codec: "aac",
	default: false,
	selected: false,
	language: null,
	title: null,
	channels: null,
	...over,
});

describe("audioTrackName", () => {
	it("names the track by its language, with its channels", () => {
		expect(audioTrackName(track({ language: "en", channels: 6 }))).toBe("English 5.1");
		expect(audioTrackName(track({ language: "fr", channels: 2 }))).toBe("French Stereo");
		expect(audioTrackName(track({ language: "de", channels: 1 }))).toBe("German Mono");
		expect(audioTrackName(track({ language: "es", channels: 8 }))).toBe("Spanish 7.1");
	});

	it("takes the language over the title", () => {
		expect(audioTrackName(track({ language: "en", title: "Commentary" }))).toBe("English");
	});

	it("falls back to the title, then the number", () => {
		expect(audioTrackName(track({ title: "Director's cut" }))).toBe("Director's cut");
		expect(audioTrackName(track({ title: "" }))).toBe("Track 2");
		expect(audioTrackName(track())).toBe("Track 2");
	});

	it("leaves out a channel count it has no name for", () => {
		expect(audioTrackName(track({ language: "en", channels: 3 }))).toBe("English");
	});
});

describe("speeds", () => {
	it("goes from half speed to double, with normal speed among them", () => {
		expect(PLAYBACK_SPEEDS).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2]);
	});

	it("calls normal speed Normal, and the rest by how many times faster", () => {
		expect(speedLabel(1)).toBe("Normal");
		expect(speedLabel(1.5)).toBe("1.5×");
		expect(speedLabel(0.75)).toBe("0.75×");
	});
});

describe("picks", () => {
	it("numbers the sources and describes each without its login", () => {
		expect(sourcePicks(["http://user:pass@first.example.test/movie.mkv", "not a url"])).toEqual(
			[
				{
					key: "http://user:pass@first.example.test/movie.mkv",
					label: "Source 1",
					detail: "first.example.test · MKV",
				},
				{ key: "not a url", label: "Source 2", detail: undefined },
			]
		);
	});

	it("keys the audio tracks by id, with the title under a language, or else the codec", () => {
		expect(
			audioPicks([
				track({ id: 1, language: "en", title: "Commentary", codec: "aac" }),
				track({ id: 2, language: "en", codec: "ac3", channels: 6 }),
				track({ id: 3, title: "Original", codec: "eac3" }),
				track({ id: 4, codec: null }),
			])
		).toEqual([
			{ key: "1", label: "English", detail: "Commentary" },
			{ key: "2", label: "English 5.1", detail: "AC3" },
			{ key: "3", label: "Original", detail: "EAC3" },
			{ key: "4", label: "Track 4", detail: undefined },
		]);
	});

	it("keys the speeds by their number", () => {
		expect(speedPicks()).toEqual([
			{ key: "0.5", label: "0.5×" },
			{ key: "0.75", label: "0.75×" },
			{ key: "1", label: "Normal" },
			{ key: "1.25", label: "1.25×" },
			{ key: "1.5", label: "1.5×" },
			{ key: "2", label: "2×" },
		]);
	});
});
