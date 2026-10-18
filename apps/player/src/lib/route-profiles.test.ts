// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import { castProfile, desktopSender, NOT_READY, REFUSED } from "@/lib/route-profiles";
import { chooseRoute, type StreamFormat } from "@/lib/route";

const format = (f: Partial<StreamFormat>): StreamFormat => ({
	container: "hls-ts",
	video: "h264",
	interlaced: false,
	audio: "aac",
	cors: true,
	...f,
});

const mac = desktopSender({ convert: true, hardwareEncoder: true });
const noConverter = desktopSender({ convert: false, hardwareEncoder: true });

describe("castProfile", () => {
	it("plays H.264 in HLS, MP4 and Matroska, with AAC, MP3 or Opus", () => {
		const cast = castProfile("Chromecast");
		expect(cast).toEqual({
			containers: ["hls-ts", "hls-fmp4", "mp4", "mkv"],
			video: { h264: ["hls-ts", "hls-fmp4", "mp4", "mkv"] },
			audio: ["aac", "mp3", "opus"],
			interlaced: false,
			audioOnly: true,
			hlsNeedsCors: true,
			convertTo: "matroska",
		});
	});

	it("adds HEVC only for the models known to play it", () => {
		for (const model of ["Chromecast Ultra", "Google TV Streamer"])
			expect(castProfile(model).video.hevc).toEqual(["hls-fmp4", "mp4", "mkv"]);
		for (const model of ["Chromecast", "Chromecast HD", "Living Room TV", ""])
			expect(castProfile(model).video.hevc).toBeUndefined();
	});
});

describe("desktopSender", () => {
	it("converts with whatever the bundled ffmpeg can do, and never needs the screen", () => {
		expect(mac).toEqual({ convert: true, hardwareEncoder: true, convertNeedsScreen: false });
		expect(desktopSender({ convert: true, hardwareEncoder: false })).toEqual({
			convert: true,
			hardwareEncoder: false,
			convertNeedsScreen: false,
		});
	});

	it("has no encoder without a converter", () => {
		expect(noConverter).toEqual({
			convert: false,
			hardwareEncoder: false,
			convertNeedsScreen: false,
		});
	});
});

describe("Cast routes from the research table", () => {
	const cast = castProfile("Chromecast");

	it("sends Xtream live as HLS when the server allows CORS", () => {
		const live = [format({}), format({ container: "ts" })];
		expect(chooseRoute(live, cast, mac)).toEqual({
			ok: true,
			route: { via: "direct", format: 0 },
		});
	});

	it("remuxes raw TS, and HLS without CORS, on this computer", () => {
		const live = [format({ cors: false }), format({ container: "ts" })];
		expect(chooseRoute(live, cast, mac)).toEqual({
			ok: true,
			route: {
				via: "converted",
				format: 0,
				video: "copy",
				audio: "copy",
				output: "matroska",
				keep: "on",
			},
		});
		expect(chooseRoute(live, cast, noConverter)).toEqual({ ok: false, reason: "cors" });
		expect(chooseRoute([format({ container: "ts" })], cast, noConverter)).toEqual({
			ok: false,
			reason: "container",
			detail: "ts",
		});
	});

	it("plays MP4 and Matroska with H.264 and AAC directly", () => {
		for (const container of ["mp4", "mkv"] as const)
			expect(chooseRoute([format({ container })], cast, mac)).toEqual({
				ok: true,
				route: { via: "direct", format: 0 },
			});
	});

	it("converts MP2, AC-3, E-AC-3 and DTS audio to AAC", () => {
		for (const audio of ["mp2", "ac3", "eac3", "dts"] as const)
			expect(chooseRoute([format({ container: "mkv", audio })], cast, mac)).toMatchObject({
				ok: true,
				route: { via: "converted", video: "copy", audio: "aac" },
			});
	});

	it("needs a hardware encoder for MPEG-2, interlaced video, or HEVC on an older Chromecast", () => {
		const software = desktopSender({ convert: true, hardwareEncoder: false });
		const mpeg2 = [format({ container: "ts", video: "mpeg2", audio: "mp2" })];
		expect(chooseRoute(mpeg2, cast, software)).toEqual({
			ok: false,
			reason: "videoCodec",
			detail: "mpeg2",
		});
		expect(chooseRoute(mpeg2, cast, mac)).toMatchObject({
			ok: true,
			route: { video: "transcode", audio: "aac" },
		});
		const interlaced = [format({ container: "ts", interlaced: true })];
		expect(chooseRoute(interlaced, cast, software)).toEqual({
			ok: false,
			reason: "interlaced",
		});
		const hevc = [format({ container: "mkv", video: "hevc" })];
		expect(chooseRoute(hevc, cast, software)).toEqual({
			ok: false,
			reason: "videoCodec",
			detail: "hevc",
		});
		expect(chooseRoute(hevc, castProfile("Google TV Streamer"), software)).toEqual({
			ok: true,
			route: { via: "direct", format: 0 },
		});
	});
});

describe("REFUSED", () => {
	it("is the error get_stream_formats sends for a 401 or 403", () => {
		// The same text as `REFUSED` in src-tauri/src/streams/mod.rs.
		expect(REFUSED).toBe("refused");
	});
});

describe("NOT_READY", () => {
	it("is the error get_stream_formats sends while mpv opens the item", () => {
		// The same text as `NOT_READY` in src-tauri/src/streams/mod.rs.
		expect(NOT_READY).toBe("notReady");
	});
});
