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
	contentType: "live" | "movie" | "series";
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

export interface WatchHistoryEntry {
	channelId: string;
	channelName: string;
	channelLogo?: string;
	contentType: string;
	firstWatchedAt: number;
	lastWatchedAt: number;
	totalDurationSeconds: number;
	playCount: number;
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

export type Platform = "macos" | "ios" | "android" | "windows" | "linux";
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

export type DownloadStatus = "queued" | "downloading" | "completed" | "failed" | "cancelled";

export interface DownloadRecord {
	id: string;
	channelId: string;
	title: string;
	kind: "movie" | "episode";
	seriesChannelId: string | null;
	status: DownloadStatus;
	destPath: string;
	totalBytes: number | null;
	downloadedBytes: number;
	avgRateBps: number | null;
	error: string | null;
	createdAt: number;
	finishedAt: number | null;
}

/** Aggregate download state for a series card (computed in the hook). */
export type AggregateDownloadState = "none" | "downloading" | "partial" | "complete";
