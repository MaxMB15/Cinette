// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import { channelSources, withSource, describeSource } from "./sources";
import type { Channel } from "./types";

const base: Channel = {
	id: "vod-1",
	name: "Movie",
	url: "http://a.example/1.mkv",
	groupTitle: "",
	isFavorite: false,
	contentType: "movie",
	sources: ["http://b.example/2.mp4", "http://a.example/1.mkv", "http://c.example/3.ts"],
};

describe("channelSources", () => {
	it("puts the default url first and dedupes", () => {
		expect(channelSources(base)).toEqual([
			"http://a.example/1.mkv",
			"http://b.example/2.mp4",
			"http://c.example/3.ts",
		]);
	});
	it("returns just the url when there are no extra sources", () => {
		expect(channelSources({ ...base, sources: [] })).toEqual(["http://a.example/1.mkv"]);
	});
});

describe("withSource", () => {
	it("switches url but keeps the original source order", () => {
		const picked = withSource(base, "http://c.example/3.ts");
		expect(picked.url).toBe("http://c.example/3.ts");
		expect(channelSources(picked)).toEqual(channelSources(base));
	});
	it("is stable across repeated switches", () => {
		const twice = withSource(
			withSource(base, "http://c.example/3.ts"),
			"http://b.example/2.mp4"
		);
		expect(twice.url).toBe("http://b.example/2.mp4");
		expect(channelSources(twice)).toEqual(channelSources(base));
	});
});

describe("describeSource", () => {
	it("shows host and extension only", () => {
		expect(describeSource("http://host.tv:8080/movie/user/pass/123.mkv")).toBe("host.tv · MKV");
	});
	it("omits the extension when there is none", () => {
		expect(describeSource("http://host.tv/live/stream")).toBe("host.tv");
	});
	it("returns null for invalid urls", () => {
		expect(describeSource("not a url")).toBeNull();
	});
});
