// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * How an item reaches a destination. Cinette on a TV plays everything
 * through its own mpv. A Cast or AirPlay receiver fetches the stream itself
 * when it can play it. Otherwise this device converts the stream and serves
 * it, which means this device has to stay on for as long as it plays.
 */

export type Container = "hls" | "mp4" | "mkv" | "ts" | "other";
export type VideoCodec = "h264" | "hevc" | "mpeg2" | "other";
export type AudioCodec = "aac" | "mp3" | "ac3" | "eac3" | "mp2" | "dts" | "opus" | "other";

/** What a probe found out about one way of fetching an item, such as an
 *  Xtream live channel as `.m3u8` or as `.ts`. */
export interface StreamFormat {
	container: Container;
	/** `null` when the stream has no video. */
	video: VideoCodec | null;
	interlaced: boolean;
	/** `null` when the stream has no audio. */
	audio: AudioCodec | null;
	/** For HLS, whether the playlist and its segments send CORS headers. */
	cors: boolean;
}

/** What a Cast or AirPlay receiver plays from a URL. */
export interface ReceiverProfile {
	containers: readonly Container[];
	video: readonly VideoCodec[];
	audio: readonly AudioCodec[];
	interlaced: boolean;
	/** Chromecast only fetches HLS from servers that send CORS headers. */
	hlsNeedsCors: boolean;
	/** What this device serves the receiver when it converts. */
	convertTo: "hls" | "fmp4" | "matroska";
}

/** What this device can do for a receiver. */
export interface SenderProfile {
	/** Whether this device can convert a stream for this receiver at all. */
	convert: boolean;
	/** A full video transcode only runs on a hardware encoder. */
	hardwareEncoder: boolean;
	/** The conversion stops when Cinette leaves the screen, as Cast from iOS does. */
	convertNeedsScreen: boolean;
}

export type PlayRoute =
	| { via: "local" }
	| { via: "cinette" }
	/** The receiver fetches `formats[format]` itself, so this device can sleep. */
	| { via: "direct"; format: number }
	| {
			via: "converted";
			format: number;
			video: "copy" | "transcode" | "none";
			audio: "copy" | "aac" | "none";
			output: ReceiverProfile["convertTo"];
			/** What the UI tells the user before it starts: keep this device
			 *  on, or keep Cinette open on screen. */
			keep: "on" | "onScreen";
	  };

/** Why no route works. `detail` names the format, like `mkv` or `dts`. */
export type PlayBlocker =
	"container" | "videoCodec" | "interlaced" | "audioCodec" | "cors" | "unreachable" | "notFound";

export type RouteDecision =
	{ ok: true; route: PlayRoute } | { ok: false; reason: PlayBlocker; detail?: string };

type Blocked = Extract<RouteDecision, { ok: false }>;

const directBlocker = (f: StreamFormat, r: ReceiverProfile): Blocked | null => {
	if (!r.containers.includes(f.container))
		return { ok: false, reason: "container", detail: f.container };
	if (f.video !== null && !r.video.includes(f.video))
		return { ok: false, reason: "videoCodec", detail: f.video };
	if (f.interlaced && !r.interlaced) return { ok: false, reason: "interlaced" };
	if (f.audio !== null && !r.audio.includes(f.audio))
		return { ok: false, reason: "audioCodec", detail: f.audio };
	if (f.container === "hls" && r.hlsNeedsCors && !f.cors) return { ok: false, reason: "cors" };
	return null;
};

const convert = (
	f: StreamFormat,
	format: number,
	r: ReceiverProfile,
	s: SenderProfile
): RouteDecision => {
	let video: "copy" | "transcode" | "none" = "none";
	if (f.video !== null) {
		const plays = r.video.includes(f.video) && (r.interlaced || !f.interlaced);
		if (!plays && !s.hardwareEncoder)
			return f.interlaced && !r.interlaced
				? { ok: false, reason: "interlaced" }
				: { ok: false, reason: "videoCodec", detail: f.video };
		video = plays ? "copy" : "transcode";
	}
	let audio: "copy" | "aac" | "none" = "none";
	if (f.audio !== null) audio = r.audio.includes(f.audio) ? "copy" : "aac";
	return {
		ok: true,
		route: {
			via: "converted",
			format,
			video,
			audio,
			output: r.convertTo,
			keep: s.convertNeedsScreen ? "onScreen" : "on",
		},
	};
};

/**
 * The route to a Cast or AirPlay receiver. `formats` are the ways of
 * fetching the item, best first. Any format the receiver plays directly
 * wins, then any this device can convert. When neither works, the reason
 * comes from the first format, so the UI can say why and keep playing
 * locally.
 */
export const chooseRoute = (
	formats: readonly StreamFormat[],
	receiver: ReceiverProfile,
	sender: SenderProfile
): RouteDecision => {
	if (formats.length === 0) return { ok: false, reason: "unreachable" };
	const direct = formats.findIndex((f) => directBlocker(f, receiver) === null);
	if (direct >= 0) return { ok: true, route: { via: "direct", format: direct } };
	const first = directBlocker(formats[0], receiver) as Blocked;
	if (!sender.convert) return first;
	const converted = formats.map((f, i) => convert(f, i, receiver, sender));
	return converted.find((d) => d.ok) ?? converted[0];
};
