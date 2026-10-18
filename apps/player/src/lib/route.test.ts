// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import { chooseRoute, type ReceiverProfile, type SenderProfile, type StreamFormat } from "./route";

const format = (over: Partial<StreamFormat> = {}): StreamFormat => ({
	container: "mp4",
	video: "h264",
	interlaced: false,
	audio: "aac",
	cors: false,
	...over,
});

// Close to a Chromecast with Google TV, from cast-airplay-formats.md.
const cast: ReceiverProfile = {
	containers: ["hls", "mp4", "mkv"],
	video: ["h264", "hevc"],
	audio: ["aac", "mp3", "opus"],
	interlaced: false,
	hlsNeedsCors: true,
	convertTo: "matroska",
};

// Close to an Apple TV.
const airplay: ReceiverProfile = {
	containers: ["hls", "mp4"],
	video: ["h264", "hevc"],
	audio: ["aac", "mp3", "ac3", "eac3"],
	interlaced: false,
	hlsNeedsCors: false,
	convertTo: "hls",
};

const desktop: SenderProfile = { convert: true, hardwareEncoder: false, convertNeedsScreen: false };
const none: SenderProfile = { convert: false, hardwareEncoder: true, convertNeedsScreen: false };

const converted = (over: Record<string, unknown> = {}) => ({
	ok: true,
	route: {
		via: "converted",
		format: 0,
		video: "copy",
		audio: "copy",
		output: "matroska",
		keep: "on",
		...over,
	},
});

describe("chooseRoute", () => {
	it("goes direct when the receiver plays the stream", () => {
		expect(chooseRoute([format()], cast, desktop)).toEqual({
			ok: true,
			route: { via: "direct", format: 0 },
		});
	});

	it("goes direct with no video or no audio", () => {
		const route = { ok: true, route: { via: "direct", format: 0 } };
		expect(chooseRoute([format({ video: null })], cast, none)).toEqual(route);
		expect(chooseRoute([format({ audio: null })], cast, none)).toEqual(route);
	});

	it("prefers any direct format over converting the first", () => {
		const live = [format({ container: "ts" }), format({ container: "hls" })];
		expect(chooseRoute(live, airplay, desktop)).toEqual({
			ok: true,
			route: { via: "direct", format: 1 },
		});
	});

	it("needs CORS for HLS only where the receiver does", () => {
		const hls = format({ container: "hls" });
		expect(chooseRoute([hls], cast, none)).toEqual({ ok: false, reason: "cors" });
		expect(chooseRoute([{ ...hls, cors: true }], cast, none).ok).toBe(true);
		expect(chooseRoute([hls], airplay, none).ok).toBe(true);
		// Only HLS needs it.
		expect(chooseRoute([format({ container: "mkv" })], cast, none).ok).toBe(true);
	});

	it.each([
		["container", format({ container: "ts" }), "ts"],
		["videoCodec", format({ video: "mpeg2" }), "mpeg2"],
		["audioCodec", format({ audio: "dts" }), "dts"],
	] as const)("says %s when it can't convert", (reason, f, detail) => {
		expect(chooseRoute([f], cast, none)).toEqual({ ok: false, reason, detail });
	});

	it("says interlaced when it can't convert", () => {
		const f = format({ interlaced: true });
		expect(chooseRoute([f], cast, none)).toEqual({ ok: false, reason: "interlaced" });
		expect(chooseRoute([f], { ...cast, interlaced: true }, none).ok).toBe(true);
	});

	it("checks the container, then video, interlacing, audio and CORS", () => {
		const all = format({
			container: "ts",
			video: "mpeg2",
			interlaced: true,
			audio: "mp2",
		});
		const steps = [
			[all, "container"],
			[{ ...all, container: "hls" }, "videoCodec"],
			[{ ...all, container: "hls", video: "h264" }, "interlaced"],
			[{ ...all, container: "hls", video: "h264", interlaced: false }, "audioCodec"],
			[{ ...all, container: "hls", video: "h264", interlaced: false, audio: "aac" }, "cors"],
		] as const;
		for (const [f, reason] of steps)
			expect(chooseRoute([f], cast, none)).toMatchObject({ ok: false, reason });
	});

	it("is unreachable with no formats", () => {
		expect(chooseRoute([], cast, desktop)).toEqual({ ok: false, reason: "unreachable" });
	});

	it("remuxes a container the receiver can't take, copying both tracks", () => {
		expect(chooseRoute([format({ container: "ts" })], cast, desktop)).toEqual(converted());
		expect(chooseRoute([format({ container: "mkv" })], airplay, desktop)).toEqual(
			converted({ output: "hls" })
		);
	});

	it("converts only the audio the receiver lacks", () => {
		expect(chooseRoute([format({ audio: "ac3" })], cast, desktop)).toEqual(
			converted({ audio: "aac" })
		);
		expect(chooseRoute([format({ container: "ts", audio: "ac3" })], airplay, desktop)).toEqual(
			converted({ output: "hls" })
		);
	});

	it("handles a stream with no video or no audio", () => {
		expect(chooseRoute([format({ container: "ts", video: null })], cast, desktop)).toEqual(
			converted({ video: "none" })
		);
		expect(chooseRoute([format({ container: "ts", audio: null })], cast, desktop)).toEqual(
			converted({ audio: "none" })
		);
	});

	it("transcodes video only with a hardware encoder", () => {
		const hw = { ...desktop, hardwareEncoder: true };
		expect(chooseRoute([format({ video: "mpeg2" })], cast, desktop)).toEqual({
			ok: false,
			reason: "videoCodec",
			detail: "mpeg2",
		});
		expect(chooseRoute([format({ video: "mpeg2" })], cast, hw)).toEqual(
			converted({ video: "transcode" })
		);
		expect(chooseRoute([format({ interlaced: true })], cast, desktop)).toEqual({
			ok: false,
			reason: "interlaced",
		});
		expect(chooseRoute([format({ interlaced: true })], cast, hw)).toEqual(
			converted({ video: "transcode" })
		);
		// An unsupported codec that's also interlaced is named as the codec.
		expect(
			chooseRoute(
				[format({ video: "mpeg2", interlaced: true })],
				{ ...cast, interlaced: true },
				desktop
			)
		).toEqual({ ok: false, reason: "videoCodec", detail: "mpeg2" });
	});

	it("copies interlaced video to a receiver that plays it", () => {
		const f = format({ container: "ts", interlaced: true });
		expect(chooseRoute([f], { ...cast, interlaced: true }, desktop)).toEqual(converted());
	});

	it("says to keep Cinette on screen when the conversion needs it", () => {
		const ios = { ...desktop, convertNeedsScreen: true };
		expect(chooseRoute([format({ container: "ts" })], cast, ios)).toEqual(
			converted({ keep: "onScreen" })
		);
	});

	it("converts the first format that can be converted", () => {
		const list = [format({ video: "mpeg2" }), format({ container: "ts" })];
		expect(chooseRoute(list, cast, desktop)).toEqual(converted({ format: 1 }));
	});

	it("gives the first format's reason when nothing works", () => {
		const list = [format({ video: "mpeg2", container: "ts" }), format({ interlaced: true })];
		expect(chooseRoute(list, cast, desktop)).toEqual({
			ok: false,
			reason: "videoCodec",
			detail: "mpeg2",
		});
		expect(chooseRoute(list, cast, none)).toEqual({
			ok: false,
			reason: "container",
			detail: "ts",
		});
	});
});
