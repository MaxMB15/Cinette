// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { Channel, DownloadRecord, EpgProgram, OmdbData } from "@/lib/types";
import { makeChannel, makeDownload } from "./channel-fixtures";

/** News 24, a live channel with no logo and no guide id. */
export const makeNewsChannel = (overrides: Partial<Channel> = {}): Channel =>
	makeChannel({
		id: "ch1",
		name: "News 24",
		url: "http://live.example.test/news24.ts",
		groupTitle: "News",
		...overrides,
	});

/** City News, a live channel of the Xtream provider "xt-1", which `makeRecording` records. */
export const makeCityNews = (overrides: Partial<Channel> = {}): Channel =>
	makeNewsChannel({
		id: "xt-1-xt-0",
		name: "City News",
		url: "http://live.example.test/city-news.ts",
		...overrides,
	});

/** Sintel, a movie. */
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

/** A download of `makeMovie` that finished just now and isn't kept. */
export const makeMovieDownload = (overrides: Partial<DownloadRecord> = {}): DownloadRecord =>
	makeDownload({
		id: "dl1",
		channelId: "mv1",
		title: "Sintel",
		destPath: "/downloads/sintel.mkv",
		finishedAt: Math.floor(Date.now() / 1000),
		...overrides,
	});

/**
 * A recording of `makeCityNews` from 1 000 to 2 000 that hasn't started. A recording's
 * `channelId` is its own id, and `sourceChannelId` is the live channel's.
 */
export const makeRecording = (overrides: Partial<DownloadRecord> = {}): DownloadRecord =>
	makeDownload({
		id: "rec-1",
		channelId: "rec-1",
		title: "City News",
		kind: "recording",
		status: "scheduled",
		destPath: "",
		totalBytes: null,
		downloadedBytes: 0,
		finishedAt: null,
		sourceChannelId: "xt-1-xt-0",
		startAt: 1_000,
		endAt: 2_000,
		programTitle: null,
		...overrides,
	});
