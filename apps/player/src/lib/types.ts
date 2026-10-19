// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

export interface Channel {
	id: string;
	name: string;
	url: string;
	logoUrl?: string;
	groupTitle: string;
	tvgId?: string;
	tvgName?: string;
	isFavorite: boolean;
	/** A "recording" is a finished recording of a live channel, played from its file. */
	contentType: "live" | "movie" | "series" | "recording";
	sources: string[];
	/**
	 * Frontend-only: the full ordered source list, captured when a non-default
	 * source is picked so the original order (and "Source N" numbering) survives
	 * `url` being swapped. See `withSource()` in lib/sources.ts.
	 */
	sourceList?: string[];
	seriesTitle?: string;
	season?: number;
	episode?: number;
}

export interface Category {
	id: string;
	name: string;
	channelCount: number;
}

export interface Provider {
	id: string;
	name: string;
	type: "m3u" | "xtream";
	url: string;
	username?: string;
	password?: string;
	lastUpdated?: string;
	channelCount: number;
	epgUrl?: string;
}

export interface Playlist {
	provider: Provider;
	channels: Channel[];
	categories: Category[];
}

export interface PlayerState {
	isPlaying: boolean;
	isPaused: boolean;
	currentUrl: string | null;
	volume: number;
	position: number;
	duration: number;
}

/** What the mpv plugin reports, which adds how the current load is opening. */
export interface MpvPlayerState extends PlayerState {
	/** The current load has opened and shown its first frame or started its
	 *  audio. Set by the mpv plugin and kept until the next load. */
	playbackStarted: boolean;
	/** The current load stopped before it ever started playing. */
	openFailed: boolean;
	/** Playback ran to the end of the file. mpv then pauses on the last frame.
	 *  A pause near the end doesn't set it. A seek back or the next load
	 *  clears it. */
	reachedEnd: boolean;
	/** Playback isn't paused, but the picture doesn't move on, as while mpv
	 *  opens a file, seeks or waits for more of the stream. */
	waiting: boolean;
	/** mpv plays in a window of its own, because the app couldn't draw the
	 *  video in its own window. Nothing the app draws shows over it. */
	fallbackActive: boolean;
}

/** What useMpv keeps of mpv's state, which adds when the position was read. */
export interface PolledMpvState extends MpvPlayerState {
	/** When `position` was read from mpv or set by a seek or a load, in
	 *  `performance.now()` milliseconds. */
	positionAt: number;
}

export interface EpgProgram {
	channelId: string;
	title: string;
	description?: string;
	startTime: number; // Unix timestamp seconds
	endTime: number;
	category?: string;
}

export interface EpgSearchResult {
	channelId: string;
	title: string;
	description?: string;
	startTime: number;
	endTime: number;
	channelName: string;
	channelLogoUrl?: string;
}

export interface OmdbData {
	title: string;
	year?: string;
	rated?: string;
	runtime?: string;
	genre?: string;
	director?: string;
	actors?: string;
	plot?: string;
	posterUrl?: string;
	imdbRating?: string;
	rottenTomatoes?: string;
	imdbId?: string;
	imdbVotes?: string;
}

export interface MdbListData {
	imdbId?: string;
	description?: string;
	language?: string;
	mediaType?: string;
	imdbRating?: number;
	imdbVotes?: number;
	tomatometer?: number;
	tomatometerState?: string;
	tomatometerCount?: number;
	tomatoAudienceScore?: number;
	tomatoAudienceCount?: number;
	tomatoAudienceState?: string;
	metacriticScore?: number;
	metacriticVotes?: number;
	tmdbRating?: number;
	tmdbVotes?: number;
	traktRating?: number;
	traktVotes?: number;
	letterboxdRating?: number;
	mdblistScore?: number;
}

export interface WhatsonData {
	imdbId?: string;
	title?: string;
	image?: string;
	itemType?: string;
	releaseDate?: string;
	runtime?: number;
	certification?: string;
	tagline?: string;
	imdbRating?: number;
	imdbVotes?: number;
	rtCriticsRating?: number;
	rtCriticsCount?: number;
	rtAudienceRating?: number;
	rtAudienceCount?: number;
	metacriticCritics?: number;
	metacriticCriticsCount?: number;
	metacriticUsers?: number;
	letterboxdRating?: number;
	letterboxdCount?: number;
	tmdbRating?: number;
	tmdbVotes?: number;
}

/** A part of a movie or episode the player can skip. */
export type SkipSegmentKind = "intro" | "recap" | "credits" | "preview";

/**
 * How well the video's length matched the length the skip times were taken
 * from. "exact" is within 2 seconds and "shifted" within 15. "unchecked" means
 * the source had no length to compare, and "mismatch" that the lengths differ
 * by more, so the times may be off.
 */
export type SkipSegmentFit = "exact" | "shifted" | "unchecked" | "mismatch";

export interface SkipSegment {
	kind: SkipSegmentKind;
	/** Where the segment starts, in seconds. */
	start: number;
	/** Where it ends, in seconds. The Skip button jumps here. */
	end: number;
	source: "skipdb" | "introdb";
	fit: SkipSegmentFit;
	/** How sure the source is of the times, from 0 to 1. */
	confidence: number | null;
	/** The video's length minus the length the times were taken from, in seconds. */
	offset: number | null;
	/**
	 * Where the player may skip from without asking, or null when the times
	 * are only good enough for a button.
	 */
	autoFrom: number | null;
	/**
	 * Where skipping without asking jumps to, set along with `autoFrom`. It
	 * can stop short of `end` when the times may run late.
	 */
	autoTo: number | null;
}

export interface WatchHistoryEntry {
	channelId: string;
	channelName: string;
	channelLogo?: string;
	contentType: string;
	firstWatchedAt: number;
	lastWatchedAt: number;
	totalDurationSeconds: number;
	playCount: number;
	/** The show a series entry belongs to. Set on every series entry, null on the rest. */
	seriesTitle?: string | null;
}

export interface SubtitleEntry {
	fileId: number;
	languageCode: string;
	format: string;
	releaseName?: string;
	downloadCount?: number;
}

export interface SubtitleSearchResult {
	entries: SubtitleEntry[];
	languages: string[];
}

export interface SubtitleCue {
	start: number; // seconds
	end: number; // seconds
	text: string;
}

/** `tv` is Android TV, Google TV and Fire TV. Other Android devices are `android`. */
export type Platform = "macos" | "ios" | "android" | "tv" | "windows" | "linux";
export type LayoutMode = "desktop" | "tablet" | "mobile" | "tv";

export interface GroupHierarchyEntry {
	providerId: string;
	contentType: string;
	groupName: string;
	superCategory: string | null;
	sortOrder: number;
	isUserOverride: boolean;
}

export interface PinnedGroup {
	providerId: string;
	contentType: string;
	groupName: string;
	sortOrder: number;
}

export interface PlaybackPosition {
	contentKey: string;
	positionSeconds: number;
	durationSeconds: number;
	updatedAt: number;
}

/**
 * A recording waits as "scheduled", runs as "recording" and ends as
 * "completed". One whose whole window passed while the app was closed is
 * "missed".
 */
export type DownloadStatus =
	| "queued"
	| "downloading"
	| "completed"
	| "failed"
	| "cancelled"
	| "scheduled"
	| "recording"
	| "missed";

export interface DownloadRecord {
	id: string;
	channelId: string;
	title: string;
	/** A recording's `channelId` is its own id. `sourceChannelId` is the live channel. */
	kind: "movie" | "episode" | "recording";
	seriesChannelId: string | null;
	status: DownloadStatus;
	destPath: string;
	totalBytes: number | null;
	downloadedBytes: number;
	avgRateBps: number | null;
	error: string | null;
	createdAt: number;
	finishedAt: number | null;
	/** The user chose Keep, so the retention setting never deletes it. */
	keep: boolean;
	/** When the downloaded file last started playing, in Unix seconds. */
	lastPlayedAt: number | null;
	/** For a recording, the live channel it records. */
	sourceChannelId?: string | null;
	/** For a recording, when it starts, in Unix seconds. */
	startAt?: number | null;
	/** For a recording, when it ends, in Unix seconds. */
	endAt?: number | null;
	/** For a recording, the program or programs it records. */
	programTitle?: string | null;
	/** For a recording of a program, when the program itself starts, in Unix seconds. */
	programStart?: number | null;
	/** For a recording of a program, when the program itself ends, in Unix seconds. */
	programEnd?: number | null;
}

/** A program from the guide that a recording is for, with its times in Unix seconds. */
export interface GuideProgram {
	title: string;
	start: number;
	end: number;
}

/** Aggregate download state for a series card (computed in the hook). */
export type AggregateDownloadState = "none" | "downloading" | "partial" | "complete";

/** What the download button shows. A series or season can be partly downloaded. */
export type DownloadIconState = "idle" | "downloading" | "partial" | "complete" | "failed";
