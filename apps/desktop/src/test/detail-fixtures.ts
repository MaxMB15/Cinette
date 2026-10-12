// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { Channel, DownloadRecord, EpgProgram, OmdbData } from "@/lib/types";

/** A live channel with one source, no logo and no guide id. */
export const makeChannel = (overrides: Partial<Channel> = {}): Channel => ({
	id: "ch1",
	name: "News 24",
	url: "http://live.example.test/news24.ts",
	groupTitle: "News",
	isFavorite: false,
	contentType: "live",
	sources: [],
	...overrides,
});

/** A movie with one source. */
export const makeMovie = (overrides: Partial<Channel> = {}): Channel =>
	makeChannel({
		id: "mv1",
		name: "Sintel",
		url: "https://cdn.example.test/movies/sintel.mkv",
		groupTitle: "Movies",
		contentType: "movie",
		...overrides,
	});

const pad = (n: number) => String(n).padStart(2, "0");

/** An episode of "Show" named the way providers name them, like "Show S01E02 Title". */
export const makeEpisode = (
	season: number,
	episode: number,
	title: string,
	overrides: Partial<Channel> = {}
): Channel =>
	makeChannel({
		id: `s${season}e${episode}`,
		name: `Show S${pad(season)}E${pad(episode)} ${title}`,
		url: `https://cdn.example.test/show/s${season}e${episode}.mkv`,
		groupTitle: "Series",
		contentType: "series",
		seriesTitle: "Show",
		season,
		episode,
		...overrides,
	});

/** A guide entry from `startTime` to `endTime`, both in Unix seconds. */
export const makeProgramme = (
	title: string,
	startTime: number,
	endTime: number,
	overrides: Partial<EpgProgram> = {}
): EpgProgram => ({
	channelId: "news24.uk",
	title,
	startTime,
	endTime,
	...overrides,
});

/** OMDb details for a movie, with every field filled in. */
export const makeOmdb = (overrides: Partial<OmdbData> = {}): OmdbData => ({
	title: "Sintel",
	year: "2010",
	rated: "PG-13",
	runtime: "15 min",
	genre: "Animation",
	director: "Colin Levy",
	actors: "Halina Reijn, Thom Hoffman",
	plot: "A lonely young woman searches for her baby dragon.",
	posterUrl: "https://img.example.test/sintel.jpg",
	imdbRating: "7.4",
	rottenTomatoes: "88%",
	imdbId: "tt1727587",
	...overrides,
});

/** A finished movie download that isn't kept. */
export const makeDownload = (overrides: Partial<DownloadRecord> = {}): DownloadRecord => ({
	id: "dl1",
	channelId: "mv1",
	title: "Sintel",
	kind: "movie",
	seriesChannelId: null,
	status: "completed",
	destPath: "/downloads/sintel.mkv",
	totalBytes: 1000,
	downloadedBytes: 1000,
	avgRateBps: null,
	error: null,
	createdAt: 0,
	finishedAt: Math.floor(Date.now() / 1000),
	keep: false,
	lastPlayedAt: null,
	...overrides,
});
