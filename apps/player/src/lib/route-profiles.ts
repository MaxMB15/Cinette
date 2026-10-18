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
 * - Converted streams go out as live Matroska, as VLC sends them.
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
}

/** The formats an item comes in, best first, from `getStreamFormats`. */
export interface StreamFormats {
	formats: StreamFormat[];
	/** For each format, its URL's place in the backend's list, which a load
	 *  passes back. The URLs themselves stay in the backend. */
	sources: number[];
	/** Seconds, when the probe found a length. */
	duration: number | null;
}

/** What `getStreamFormats` rejects with when the provider answered 401 or
 *  403, so the login may have expired. */
export const REFUSED = "refused";
