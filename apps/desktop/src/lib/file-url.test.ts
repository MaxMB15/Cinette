// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect } from "vitest";
import {
	displayUrl,
	filenameFromPath,
	fileUrlFromPath,
	isFileUrl,
	isPlaylistFile,
	nameFromFilename,
	pathFromFileUrl,
} from "./file-url";

describe("file URLs", () => {
	it("tells file URLs from remote ones", () => {
		expect(isFileUrl("file:///Users/me/list.m3u")).toBe(true);
		expect(isFileUrl("http://example.com/list.m3u")).toBe(false);
		expect(isFileUrl("/Users/me/list.m3u")).toBe(false);
	});

	it("round-trips a path through a file URL", () => {
		const url = fileUrlFromPath("/Users/me/list.m3u");
		expect(url).toBe("file:///Users/me/list.m3u");
		expect(pathFromFileUrl(url)).toBe("/Users/me/list.m3u");
	});

	it("leaves a remote URL alone when asked for its path", () => {
		expect(pathFromFileUrl("http://example.com/list.m3u")).toBe("http://example.com/list.m3u");
	});
});

describe("filenameFromPath", () => {
	it("takes the last part of a Unix path", () => {
		expect(filenameFromPath("/Users/me/lists/sports.m3u")).toBe("sports.m3u");
	});

	it("takes the last part of a Windows path", () => {
		expect(filenameFromPath("C:\\Users\\me\\sports.m3u8")).toBe("sports.m3u8");
	});

	it("returns a bare file name as it is", () => {
		expect(filenameFromPath("sports.m3u")).toBe("sports.m3u");
	});

	it("falls back to the whole path when it ends in a separator", () => {
		expect(filenameFromPath("/Users/me/")).toBe("/Users/me/");
	});
});

describe("nameFromFilename", () => {
	it.each([
		["sports.m3u", "sports"],
		["sports.m3u8", "sports"],
		["Sports.M3U", "Sports"],
		["sports.txt", "sports"],
	])("drops the playlist extension from %s", (filename, name) => {
		expect(nameFromFilename(filename)).toBe(name);
	});

	it("keeps other extensions and dots inside the name", () => {
		expect(nameFromFilename("my.sports.list.json")).toBe("my.sports.list.json");
		expect(nameFromFilename("my.sports.m3u")).toBe("my.sports");
	});
});

describe("isPlaylistFile", () => {
	it("accepts the extensions the file picker offers", () => {
		expect(isPlaylistFile("/a/b.m3u")).toBe(true);
		expect(isPlaylistFile("/a/b.M3U8")).toBe(true);
		expect(isPlaylistFile("/a/b.txt")).toBe(true);
	});

	it("rejects anything else", () => {
		expect(isPlaylistFile("/a/b.mp4")).toBe(false);
		expect(isPlaylistFile("/a/m3u")).toBe(false);
	});
});

describe("displayUrl", () => {
	it("shows only the file name of a local playlist", () => {
		expect(displayUrl("file:///Users/me/lists/sports.m3u")).toBe("sports.m3u");
	});

	it("shows a remote URL in full", () => {
		expect(displayUrl("http://example.com/get.php?type=m3u")).toBe(
			"http://example.com/get.php?type=m3u"
		);
	});
});
