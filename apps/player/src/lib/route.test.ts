// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import { chooseRoute, type ReceiverProfile, type SenderProfile, type StreamFormat } from "./route";

const format = (over: Partial<StreamFormat> = {}): StreamFormat => ({
	container: "mp4",
	video: "h264",
	interlaced: false,
	hdr: false,
	audio: "aac",
	cors: false,
	...over,
});

// Close to a Chromecast with Google TV, from cast-airplay-formats.md.
const cast: ReceiverProfile = {
	containers: ["hls-ts", "hls-fmp4", "mp4", "mkv"],
	video: { h264: ["hls-ts", "hls-fmp4", "mp4", "mkv"], hevc: ["hls-fmp4", "mp4", "mkv"] },
	audio: ["aac", "mp3", "opus"],
	interlaced: false,
	audioOnly: true,
	hlsNeedsCors: true,
	convertTo: "matroska",
};

// Close to an Apple TV.
const airplay: ReceiverProfile = {
	containers: ["hls-ts", "hls-fmp4", "mp4"],
	video: { h264: ["hls-ts", "hls-fmp4", "mp4"], hevc: ["hls-fmp4", "mp4"] },
	audio: ["aac", "mp3", "ac3", "eac3"],
	interlaced: false,
	audioOnly: true,
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
		const live = [format({ container: "ts" }), format({ container: "hls-ts" })];
		expect(chooseRoute(live, airplay, desktop)).toEqual({
			ok: true,
			route: { via: "direct", format: 1 },
		});
	});

	it("needs CORS for HLS only where the receiver does", () => {
		const hls = format({ container: "hls-ts" });
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
			[{ ...all, container: "hls-ts" }, "videoCodec"],
			[{ ...all, container: "hls-ts", video: "h264" }, "interlaced"],
			[{ ...all, container: "hls-ts", video: "h264", interlaced: false }, "audioCodec"],
			[
				{ ...all, container: "hls-ts", video: "h264", interlaced: false, audio: "aac" },
				"cors",
			],
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

	it("copies HDR video but doesn't transcode it", () => {
		const hw = { ...desktop, hardwareEncoder: true };
		const hdr = format({ container: "ts", video: "hevc", hdr: true });
		expect(chooseRoute([hdr], cast, hw)).toEqual(converted());
		expect(chooseRoute([{ ...hdr, container: "mp4" }], cast, hw)).toEqual({
			ok: true,
			route: { via: "direct", format: 0 },
		});
		const h264Only = { ...cast, video: { h264: cast.video.h264 } };
		expect(chooseRoute([hdr], h264Only, hw)).toEqual({ ok: false, reason: "hdr" });
		// Without an encoder, that's the reason.
		expect(chooseRoute([hdr], h264Only, desktop)).toEqual({
			ok: false,
			reason: "videoCodec",
			detail: "hevc",
		});
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

	it("plays HEVC only in the containers the receiver takes it in", () => {
		const hevc = format({ video: "hevc", container: "hls-ts", cors: true });
		expect(chooseRoute([hevc], cast, none)).toEqual({
			ok: false,
			reason: "videoCodec",
			detail: "hevc",
		});
		expect(chooseRoute([{ ...hevc, container: "hls-fmp4" }], cast, none).ok).toBe(true);
		// Remuxed into Matroska, it plays with the video copied.
		expect(chooseRoute([hevc], cast, desktop)).toEqual(converted());
		// Without HEVC at all, it needs a transcode.
		const old = { ...cast, video: { h264: cast.video.h264 } };
		expect(chooseRoute([hevc], old, desktop)).toMatchObject({ ok: false, detail: "hevc" });
	});

	it("needs CORS for HLS with fMP4 segments too", () => {
		const f = format({ container: "hls-fmp4" });
		expect(chooseRoute([f], cast, none)).toEqual({ ok: false, reason: "cors" });
	});

	it("checks the copied video against what this device serves", () => {
		// HLS out of the converter uses fMP4 segments, where AirPlay plays HEVC.
		const f = format({ video: "hevc", container: "mkv" });
		expect(chooseRoute([f], airplay, desktop)).toEqual(converted({ output: "hls" }));
		const tsOnly = { ...airplay, video: { hevc: ["hls-ts"] as const } };
		expect(chooseRoute([f], tsOnly, desktop)).toMatchObject({
			ok: false,
			reason: "videoCodec",
		});
	});

	it("serves progressive fMP4 as MP4", () => {
		const fmp4 = { ...cast, convertTo: "fmp4" as const, video: { h264: ["mp4"] as const } };
		expect(chooseRoute([format({ container: "ts" })], fmp4, desktop)).toEqual(
			converted({ output: "fmp4" })
		);
	});

	it("can't route a stream with neither video nor audio", () => {
		const empty = format({ video: null, audio: null });
		expect(chooseRoute([empty], cast, desktop)).toEqual({ ok: false, reason: "unreachable" });
		expect(chooseRoute([empty], cast, none)).toEqual({ ok: false, reason: "unreachable" });
	});

	it("doesn't send audio alone to a receiver that won't play it", () => {
		const tv = { ...airplay, audioOnly: false };
		const radio = format({ video: null });
		expect(chooseRoute([radio], tv, none)).toEqual({ ok: false, reason: "audioOnly" });
		expect(chooseRoute([radio], tv, desktop)).toEqual({ ok: false, reason: "audioOnly" });
		expect(chooseRoute([radio], airplay, none).ok).toBe(true);
		expect(chooseRoute([format()], tv, none).ok).toBe(true);
	});

	it("converts the format that costs least, the earlier one on a tie", () => {
		const hw = { ...desktop, hardwareEncoder: true };
		const transcode = format({ container: "ts", interlaced: true });
		const audio = format({ container: "ts", audio: "dts" });
		const remux = format({ container: "ts" });
		expect(chooseRoute([transcode, audio, remux], cast, hw)).toEqual(converted({ format: 2 }));
		expect(chooseRoute([transcode, audio], cast, hw)).toEqual(
			converted({ format: 1, audio: "aac" })
		);
		// A transcode costs more than converting the audio as well.
		const both = format({ container: "ts", interlaced: true, audio: "dts" });
		expect(chooseRoute([both, transcode], cast, hw)).toEqual(
			converted({ format: 1, video: "transcode" })
		);
		expect(chooseRoute([remux, format({ container: "ts" })], cast, hw)).toEqual(converted());
	});
});
