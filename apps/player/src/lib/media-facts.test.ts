// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import { mediaFacts } from "./media-facts";
import type { OmdbData, WhatsonData } from "./types";

const omdb: OmdbData = {
	title: "Sintel",
	year: "2010",
	rated: "PG",
	genre: "Fantasy",
	runtime: "15 min",
	director: "Colin Levy",
	actors: "Halina Reijn",
	plot: "A girl looks for her dragon.",
	posterUrl: "http://omdb.example.test/sintel.jpg",
};

const whatson: WhatsonData = {
	image: "http://whatson.example.test/sintel.jpg",
	certification: "12A",
	tagline: "The search is on.",
};

const LOGO = "http://logo.example.test/sintel.png";

const NOTHING = {
	poster: null,
	year: null,
	rated: null,
	genre: null,
	runtime: null,
	director: null,
	actors: null,
	plot: null,
};

describe("mediaFacts", () => {
	it("shows what OMDb knows", () => {
		expect(mediaFacts(omdb, null, null)).toEqual({
			poster: omdb.posterUrl,
			year: "2010",
			rated: "PG",
			genre: "Fantasy",
			runtime: "15 min",
			director: "Colin Levy",
			actors: "Halina Reijn",
			plot: "A girl looks for her dragon.",
		});
	});

	it("takes the poster and rating from Whatson first", () => {
		const facts = mediaFacts(omdb, whatson, LOGO);
		expect(facts.poster).toBe(whatson.image);
		expect(facts.rated).toBe("12A");
	});

	it("prefers OMDb's plot to Whatson's tagline, which fills in without one", () => {
		expect(mediaFacts(omdb, whatson, null).plot).toBe(omdb.plot);
		expect(mediaFacts(null, whatson, null).plot).toBe("The search is on.");
	});

	it("falls back to the channel's logo when no service has a poster", () => {
		expect(mediaFacts(omdb, null, LOGO).poster).toBe(omdb.posterUrl);
		expect(mediaFacts({ title: "Sintel" }, {}, LOGO).poster).toBe(LOGO);
		expect(mediaFacts(null, null, LOGO).poster).toBe(LOGO);
	});

	it("shows nothing it doesn't know, with or without the services' answers", () => {
		expect(mediaFacts(null, null, null)).toEqual(NOTHING);
		expect(mediaFacts(undefined, undefined, undefined)).toEqual(NOTHING);
		expect(mediaFacts({ title: "Sintel" }, {}, null)).toEqual(NOTHING);
	});

	it("treats OMDb's N/A and an empty answer as not knowing", () => {
		for (const unknown of ["N/A", ""]) {
			expect(
				mediaFacts(
					{
						title: "Sintel",
						year: unknown,
						rated: unknown,
						genre: unknown,
						runtime: unknown,
						director: unknown,
						actors: unknown,
						plot: unknown,
						posterUrl: unknown,
					},
					null,
					null
				)
			).toEqual(NOTHING);
		}
	});
});
