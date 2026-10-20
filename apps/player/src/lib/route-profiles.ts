// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

/**
 * What each receiver plays from a URL, and what this device can convert,
 * for `chooseRoute`. The Cast numbers come from Google's supported media
 * list and from what VLC sends the Default Media Receiver.
 */

import type { Container, ReceiverProfile, SenderProfile, StreamFormat } from "@/lib/route";

/** Cast models that play HEVC. Others named just "Chromecast" may too, but
 *  the name doesn't tell a Chromecast with Google TV from an older one. */
const HEVC_CAST_MODELS = ["Chromecast Ultra", "Google TV Streamer"];

const H264_CONTAINERS: readonly Container[] = ["hls-ts", "hls-fmp4", "mp4", "mkv"];
/** HEVC plays in HLS only with fMP4 segments. */
const HEVC_CONTAINERS: readonly Container[] = ["hls-fmp4", "mp4", "mkv"];

/**
 * Google's Default Media Receiver on the Cast device whose model, from the
 * `md` discovery key, is `model`, or "" when it gave none.
 *
 * - Raw MPEG-TS doesn't play: Chromium has no TS demuxer outside HLS.
 * - AC-3 and E-AC-3 only pass through to a TV that decodes them, so they
 *   count as unplayable and get converted to AAC.
 * - Interlaced video is undocumented, so it counts as unplayable until a
 *   device test says otherwise.
 * - Converted streams go out as live Matroska, as VLC sends them. MKV
 *   isn't on Google's list of supported containers; it plays because VLC
 *   relies on it and a device test showed it.
 * - H.264 counts as playable at any level, but Google lists 1st and 2nd
 *   generation Chromecasts at level 4.1 (1080p30 or 720p60) and the 3rd at
 *   4.2 (1080p60). `md` is "Chromecast" for all three, so 1080p50 or 60 may
 *   stutter on the older two. `StreamFormat` doesn't carry the resolution
 *   and frame rate yet, which a cap for them would need.
 */
export const castProfile = (model: string): ReceiverProfile => ({
	containers: H264_CONTAINERS,
	video: {
		h264: H264_CONTAINERS,
		...(HEVC_CAST_MODELS.includes(model) ? { hevc: HEVC_CONTAINERS } : {}),
	},
	audio: ["aac", "mp3", "opus"],
	interlaced: false,
	audioOnly: true,
	hlsNeedsCors: true,
	convertTo: "matroska",
});

/** What AirPlay plays from a URL. Never MKV, and never an endless raw TS. */
const AIRPLAY_CONTAINERS: readonly Container[] = ["hls-ts", "hls-fmp4", "mp4"];

/**
 * An Apple TV. It plays HEVC in fMP4, and AC-3 and E-AC-3 itself. Nothing
 * on iOS tells an Apple TV from another receiver, so this isn't used yet.
 */
export const appleTvProfile: ReceiverProfile = {
	containers: AIRPLAY_CONTAINERS,
	video: { h264: AIRPLAY_CONTAINERS, hevc: ["hls-fmp4", "mp4"] },
	audio: ["aac", "mp3", "ac3", "eac3"],
	interlaced: false,
	audioOnly: true,
	hlsNeedsCors: false,
	convertTo: "hls",
};

/**
 * An AirPlay 2 TV, such as a Samsung, LG or Sony. Their makers publish
 * nothing, so this keeps to what every one is reported to play: H.264 with
 * AAC or MP3, and never audio alone. It's the profile for every AirPlay
 * receiver, since apps can't tell which kind they picked.
 */
export const airplayTvProfile: ReceiverProfile = {
	containers: AIRPLAY_CONTAINERS,
	video: { h264: AIRPLAY_CONTAINERS },
	audio: ["aac", "mp3"],
	interlaced: false,
	audioOnly: false,
	hlsNeedsCors: false,
	convertTo: "hls",
};

/** What the backend says this computer's ffmpeg can do. */
export interface ConverterSupport {
	/** It can remux and convert audio to AAC. */
	convert: boolean;
	/** It has a hardware H.264 encoder that works. */
	hardwareEncoder: boolean;
}

/** A Mac or Linux computer, which converts with the bundled ffmpeg and
 *  stays awake while it does. */
export const desktopSender = (support: ConverterSupport): SenderProfile => ({
	convert: support.convert,
	hardwareEncoder: support.convert && support.hardwareEncoder,
	convertNeedsScreen: false,
});

/** What mpv says about the item it plays, from `mpvGetMediaInfo`. */
export interface PlayingInfo {
	fileFormat: string | null;
	videoCodec: string | null;
	audioCodec: string | null;
	interlaced: boolean;
	hdr: boolean;
}

/** The formats an item comes in, best first, from `getStreamFormats`. */
export interface StreamFormats {
	formats: StreamFormat[];
	/** For each format, its URL's place in the backend's list, which a load
	 *  passes back. The URLs themselves stay in the backend. */
	sources: number[];
	/** Seconds, when the probe found a length. */
	duration: number | null;
	/** Names the backend's list that `sources` point into. A load passes it
	 *  back, and fails as stale once a newer list replaced it. */
	generation: number;
}

/** What `getStreamFormats` rejects with when the provider answered 401 or
 *  403, so the login may have expired. */
export const REFUSED = "refused";

/** An iPhone or iPad. It converts in the app, with MPVKit's libraries.
 *  `needsScreen` is for Cast, which stops when Cinette leaves the screen.
 *  AirPlay keeps going with the screen locked. */
export const iosSender = (
	support: ConverterSupport,
	{ needsScreen }: { needsScreen: boolean }
): SenderProfile => ({
	convert: support.convert,
	hardwareEncoder: support.convert && support.hardwareEncoder,
	convertNeedsScreen: needsScreen,
});
/** What `getStreamFormats` rejects with while mpv is still opening the
 *  item and doesn't know its codecs. Ask again shortly. */
export const NOT_READY = "notReady";
