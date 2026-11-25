// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeChannel } from "@/test/channel-fixtures";
import { getZapList, setZapList, zapListFor, zapNeighbor } from "./tv-zap";

const news = makeChannel({ id: "news" });
const sport = makeChannel({ id: "sport" });
const music = makeChannel({ id: "music" });
const picked = [news, sport, music];

beforeEach(() => {
	setZapList([]);
});

describe("the zap list", () => {
	it("has no channels until one is picked", async () => {
		vi.resetModules();
		const fresh = await import("./tv-zap");
		expect(fresh.getZapList()).toEqual([]);
	});

	it("gives back the list it was given", () => {
		setZapList(picked);
		expect(getZapList()).toBe(picked);
	});
});

describe("zapNeighbor", () => {
	it("steps forward and back through the list", () => {
		expect(zapNeighbor("sport", 1, picked)).toBe(music);
		expect(zapNeighbor("sport", -1, picked)).toBe(news);
	});

	it("goes around at both ends of the list", () => {
		expect(zapNeighbor("music", 1, picked)).toBe(news);
		expect(zapNeighbor("news", -1, picked)).toBe(music);
	});

	it("steps between the two channels of a list of two", () => {
		expect(zapNeighbor("news", 1, [news, sport])).toBe(sport);
		expect(zapNeighbor("sport", 1, [news, sport])).toBe(news);
	});

	it("finds no neighbor for the only channel in a list", () => {
		expect(zapNeighbor("news", 1, [news])).toBeNull();
	});

	it("finds no neighbor for a channel that isn't in the list", () => {
		expect(zapNeighbor("cinema", 1, picked)).toBeNull();
	});

	it("uses the list the channel was picked from when it's given no other", () => {
		setZapList(picked);
		expect(zapNeighbor("news", 1)).toBe(sport);
	});
});

describe("zapListFor", () => {
	const movie = makeChannel({ id: "movie", contentType: "movie" });
	const series = makeChannel({ id: "series", contentType: "series" });
	const cinema = makeChannel({ id: "cinema" });
	const everything = [movie, cinema, series, news];

	it("keeps to the list a channel was picked from", () => {
		setZapList(picked);
		expect(zapListFor("sport", everything)).toBe(picked);
	});

	it("gives every live channel for one from somewhere else", () => {
		setZapList(picked);
		expect(zapListFor("elsewhere", everything)).toEqual([cinema, news]);
	});

	it("gives every live channel when none was picked", () => {
		expect(zapListFor("cinema", everything)).toEqual([cinema, news]);
	});
});
