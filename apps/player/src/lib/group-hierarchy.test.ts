// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import type { Channel, GroupHierarchyEntry } from "./types";
import { groupSamples, groupTitles, superCategoryNames } from "./group-hierarchy";

const channel = (name: string, groupTitle: string, contentType: Channel["contentType"]) =>
	({
		id: name,
		name,
		url: `http://example.com/${name}`,
		groupTitle,
		isFavorite: false,
		contentType,
		sources: [],
	}) satisfies Channel;

const entry = (groupName: string, superCategory: string | null): GroupHierarchyEntry => ({
	providerId: "p1",
	contentType: "movie",
	groupName,
	superCategory,
	sortOrder: 0,
	isUserOverride: false,
});

describe("superCategoryNames", () => {
	it("lists each category once in the order it first appears", () => {
		const entries = [
			entry("Action", "Genres"),
			entry("Misc", null),
			entry("UK", "Countries"),
			entry("Comedy", "Genres"),
		];
		expect(superCategoryNames(entries)).toEqual(["Genres", "Countries"]);
	});

	it("is empty when nothing is categorized", () => {
		expect(superCategoryNames([entry("Misc", null)])).toEqual([]);
		expect(superCategoryNames([])).toEqual([]);
	});
});

describe("groupTitles", () => {
	it("lists the groups of one content type once each", () => {
		const channels = [
			channel("Heat", "Action", "movie"),
			channel("BBC News", "News", "live"),
			channel("Airplane", "Comedy", "movie"),
			channel("Die Hard", "Action", "movie"),
		];
		expect(groupTitles(channels, "movie")).toEqual(["Action", "Comedy"]);
		expect(groupTitles(channels, "series")).toEqual([]);
	});
});

describe("groupSamples", () => {
	const channels = [
		channel("Heat", "Action", "movie"),
		channel("Action News", "Action", "live"),
		channel("Die Hard", "Action", "movie"),
		channel("Speed", "Action", "movie"),
		channel("Airplane", "Comedy", "movie"),
	];

	it("samples only channels of the given content type", () => {
		expect(groupSamples(channels, ["Action"], "movie", 5)).toEqual([
			["Action", ["Heat", "Die Hard", "Speed"]],
		]);
		expect(groupSamples(channels, ["Action"], "live", 5)).toEqual([
			["Action", ["Action News"]],
		]);
	});

	it("takes at most the given number of names per group", () => {
		expect(groupSamples(channels, ["Action"], "movie", 2)).toEqual([
			["Action", ["Heat", "Die Hard"]],
		]);
	});

	it("keeps the order of the groups asked for and includes groups with no channels", () => {
		expect(groupSamples(channels, ["Comedy", "Empty", "Action"], "movie", 1)).toEqual([
			["Comedy", ["Airplane"]],
			["Empty", []],
			["Action", ["Heat"]],
		]);
	});
});
