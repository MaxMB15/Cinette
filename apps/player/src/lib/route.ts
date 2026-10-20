// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * How an item reaches a destination. Cinette on a TV plays everything
 * through its own mpv. A Cast or AirPlay receiver fetches the stream itself
 * when it can play it. Otherwise this device converts the stream and serves
 * it, which means this device has to stay on for as long as it plays.
 */

/** HLS is split by its segments, since receivers play HEVC only in fMP4 ones. */
export type Container = "hls-ts" | "hls-fmp4" | "mp4" | "mkv" | "ts" | "other";
export type VideoCodec = "h264" | "hevc" | "mpeg2" | "other";
export type AudioCodec = "aac" | "mp3" | "ac3" | "eac3" | "mp2" | "dts" | "opus" | "other";

/** What a probe found out about one way of fetching an item, such as an
 *  Xtream live channel as `.m3u8` or as `.ts`. */
export interface StreamFormat {
	container: Container;
	/** `null` when the stream has no video. */
	video: VideoCodec | null;
	interlaced: boolean;
	/** HDR10 or HLG video, which a transcode can't tone map yet. */
	hdr: boolean;
	/** `null` when the stream has no audio. */
	audio: AudioCodec | null;
	/** For HLS, whether the playlist and its segments send CORS headers. */
	cors: boolean;
}

/** What a Cast or AirPlay receiver plays from a URL. */
export interface ReceiverProfile {
	containers: readonly Container[];
	/** The containers each video codec plays in. A codec that isn't listed
	 *  doesn't play at all. */
	video: Partial<Record<VideoCodec, readonly Container[]>>;
	audio: readonly AudioCodec[];
	interlaced: boolean;
	/** Whether it plays a stream with no video, which AirPlay 2 TVs don't. */
	audioOnly: boolean;
	/** Chromecast only fetches HLS from servers that send CORS headers. */
	hlsNeedsCors: boolean;
	/** What this device serves the receiver when it converts. HLS output
	 *  uses MPEG-TS segments: MPVKit's FFmpeg has no HLS muxer, so the iOS
	 *  converter cuts TS itself, and the desktop's `-f hls` writes TS too. */
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
	| "container"
	| "videoCodec"
	| "interlaced"
	| "hdr"
	| "audioCodec"
	| "audioOnly"
	| "cors"
	| "unreachable"
	| "notFound";

export type RouteDecision =
	{ ok: true; route: PlayRoute } | { ok: false; reason: PlayBlocker; detail?: string };

type Blocked = Extract<RouteDecision, { ok: false }>;
type Converted = Extract<PlayRoute, { via: "converted" }>;

const OUTPUT: Record<ReceiverProfile["convertTo"], Container> = {
	hls: "hls-ts",
	fmp4: "mp4",
	matroska: "mkv",
};

/** The containers whose AAC comes with its settings up front. Anywhere else,
 *  as in MPEG-TS, AAC comes as ADTS, which Matroska written to a pipe can't
 *  take, so it's converted. The same rule as `matroska_copies` in mvp-core. */
const AAC_SETTINGS_FIRST: readonly Container[] = ["mp4", "mkv", "hls-fmp4"];

const copiesAudio = (f: StreamFormat, audio: AudioCodec, r: ReceiverProfile) =>
	r.audio.includes(audio) &&
	!(r.convertTo === "matroska" && audio === "aac" && !AAC_SETTINGS_FIRST.includes(f.container));

const playsVideo = (r: ReceiverProfile, video: VideoCodec, container: Container) =>
	r.video[video]?.includes(container) ?? false;

/** Blockers that no conversion changes. */
const contentBlocker = (f: StreamFormat, r: ReceiverProfile): Blocked | null => {
	if (f.video === null && f.audio === null) return { ok: false, reason: "unreachable" };
	if (f.video === null && !r.audioOnly) return { ok: false, reason: "audioOnly" };
	return null;
};

const directBlocker = (f: StreamFormat, r: ReceiverProfile): Blocked | null => {
	const content = contentBlocker(f, r);
	if (content) return content;
	if (!r.containers.includes(f.container))
		return { ok: false, reason: "container", detail: f.container };
	if (f.video !== null && !playsVideo(r, f.video, f.container))
		return { ok: false, reason: "videoCodec", detail: f.video };
	if (f.interlaced && !r.interlaced) return { ok: false, reason: "interlaced" };
	if (f.audio !== null && !r.audio.includes(f.audio))
		return { ok: false, reason: "audioCodec", detail: f.audio };
	if (f.container.startsWith("hls") && r.hlsNeedsCors && !f.cors)
		return { ok: false, reason: "cors" };
	return null;
};

const convert = (
	f: StreamFormat,
	format: number,
	r: ReceiverProfile,
	s: SenderProfile
): RouteDecision => {
	const content = contentBlocker(f, r);
	if (content) return content;
	let video: Converted["video"] = "none";
	if (f.video !== null) {
		const plays =
			playsVideo(r, f.video, OUTPUT[r.convertTo]) && (r.interlaced || !f.interlaced);
		if (!plays && !s.hardwareEncoder)
			return f.interlaced && !r.interlaced
				? { ok: false, reason: "interlaced" }
				: { ok: false, reason: "videoCodec", detail: f.video };
		// A transcode would wash HDR out to SDR, so it's refused for now.
		if (!plays && f.hdr) return { ok: false, reason: "hdr" };
		video = plays ? "copy" : "transcode";
	}
	let audio: Converted["audio"] = "none";
	if (f.audio !== null) audio = copiesAudio(f, f.audio, r) ? "copy" : "aac";
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

/** A remux costs least, then converting the audio, then a video transcode. */
const cost = (route: Converted) =>
	(route.video === "transcode" ? 2 : 0) + (route.audio === "aac" ? 1 : 0);

/**
 * The route to a Cast or AirPlay receiver. `formats` are the ways of
 * fetching the item, best first. The first format the receiver plays
 * directly wins. Otherwise this device converts the format that costs it
 * least, the earlier one on a tie. When neither works, the reason comes
 * from the first format, so the UI can say why and keep playing locally.
 */
export const chooseRoute = (
	formats: readonly StreamFormat[],
	receiver: ReceiverProfile,
	sender: SenderProfile
): RouteDecision => {
	if (formats.length === 0) return { ok: false, reason: "unreachable" };
	const direct = formats.findIndex((f) => directBlocker(f, receiver) === null);
	if (direct >= 0) return { ok: true, route: { via: "direct", format: direct } };
	if (!sender.convert) return directBlocker(formats[0], receiver) as Blocked;
	const decisions = formats.map((f, i) => convert(f, i, receiver, sender));
	let best: Converted | null = null;
	for (const d of decisions)
		if (d.ok && (best === null || cost(d.route as Converted) < cost(best)))
			best = d.route as Converted;
	return best ? { ok: true, route: best } : decisions[0];
};
