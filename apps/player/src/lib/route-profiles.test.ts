// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import {
	airplayTvProfile,
	appleTvProfile,
	castProfile,
	desktopSender,
	iosSender,
	NOT_READY,
	REFUSED,
} from "@/lib/route-profiles";
import { chooseRoute, type StreamFormat } from "@/lib/route";

const format = (f: Partial<StreamFormat>): StreamFormat => ({
	container: "hls-ts",
	video: "h264",
	interlaced: false,
	hdr: false,
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

describe("AirPlay profiles", () => {
	it("lists what each receiver plays", () => {
		expect(appleTvProfile).toEqual({
			containers: ["hls-ts", "hls-fmp4", "mp4"],
			video: { h264: ["hls-ts", "hls-fmp4", "mp4"], hevc: ["hls-fmp4", "mp4"] },
			audio: ["aac", "mp3", "ac3", "eac3"],
			interlaced: false,
			audioOnly: true,
			hlsNeedsCors: false,
			convertTo: "hls",
		});
		expect(airplayTvProfile).toEqual({
			containers: ["hls-ts", "hls-fmp4", "mp4"],
			video: { h264: ["hls-ts", "hls-fmp4", "mp4"] },
			audio: ["aac", "mp3"],
			interlaced: false,
			audioOnly: false,
			hlsNeedsCors: false,
			convertTo: "hls",
		});
	});

	const iphone = iosSender({ convert: true, hardwareEncoder: true }, { needsScreen: false });

	it("plays H.264 in HLS and MP4 on every receiver, and never MKV or raw TS", () => {
		for (const profile of [appleTvProfile, airplayTvProfile]) {
			for (const container of ["hls-ts", "hls-fmp4", "mp4"] as const)
				expect(chooseRoute([format({ container })], profile, iphone)).toEqual({
					ok: true,
					route: { via: "direct", format: 0 },
				});
			for (const container of ["mkv", "ts"] as const)
				expect(chooseRoute([format({ container })], profile, iphone)).toMatchObject({
					ok: true,
					route: { via: "converted", output: "hls", video: "copy", audio: "copy" },
				});
		}
	});

	it("needs no CORS for HLS", () => {
		const f = format({ cors: false });
		expect(chooseRoute([f], airplayTvProfile, iphone)).toMatchObject({
			route: { via: "direct" },
		});
		expect(chooseRoute([f], appleTvProfile, iphone)).toMatchObject({
			route: { via: "direct" },
		});
	});

	it("plays AC-3 and HEVC on an Apple TV only", () => {
		const ac3 = format({ container: "mp4", audio: "ac3" });
		expect(chooseRoute([ac3], appleTvProfile, iphone)).toMatchObject({
			route: { via: "direct" },
		});
		expect(chooseRoute([ac3], airplayTvProfile, iphone)).toMatchObject({
			route: { via: "converted", audio: "aac" },
		});
		const hevc = format({ container: "hls-fmp4", video: "hevc" });
		expect(chooseRoute([hevc], appleTvProfile, iphone)).toMatchObject({
			route: { via: "direct" },
		});
		expect(chooseRoute([hevc], airplayTvProfile, iphone)).toMatchObject({
			route: { via: "converted", video: "transcode" },
		});
	});

	it("doesn't play audio alone on a TV", () => {
		const radio = format({ video: null });
		expect(chooseRoute([radio], appleTvProfile, iphone)).toMatchObject({
			route: { via: "direct" },
		});
		expect(chooseRoute([radio], airplayTvProfile, iphone)).toEqual({
			ok: false,
			reason: "audioOnly",
		});
	});

	it("never plays interlaced video directly", () => {
		for (const profile of [appleTvProfile, airplayTvProfile])
			expect(profile.interlaced).toBe(false);
	});
});

describe("iosSender", () => {
	it("keeps the screen rule to the destination", () => {
		expect(iosSender({ convert: true, hardwareEncoder: true }, { needsScreen: false })).toEqual(
			{
				convert: true,
				hardwareEncoder: true,
				convertNeedsScreen: false,
			}
		);
		expect(iosSender({ convert: true, hardwareEncoder: false }, { needsScreen: true })).toEqual(
			{
				convert: true,
				hardwareEncoder: false,
				convertNeedsScreen: true,
			}
		);
	});

	it("has no encoder without a converter", () => {
		expect(
			iosSender({ convert: false, hardwareEncoder: true }, { needsScreen: false })
		).toEqual({
			convert: false,
			hardwareEncoder: false,
			convertNeedsScreen: false,
		});
	});
});

describe("NOT_READY", () => {
	it("is the error get_stream_formats sends while mpv opens the item", () => {
		// The same text as `NOT_READY` in src-tauri/src/streams/mod.rs.
		expect(NOT_READY).toBe("notReady");
	});
});
