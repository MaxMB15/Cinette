// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	readSubtitleSession,
	saveSubtitleSession,
	updateSubtitleSession,
	type SubtitleSession,
} from "./subtitle-session";

const STREAM = "https://cdn.example.test/movies/lantern-keeper.mkv";

const session = (): SubtitleSession => ({
	channelId: "mv1",
	url: STREAM,
	fileId: 101,
	entry: { fileId: 101, languageCode: "en", format: "srt" },
	cues: [{ start: 1, end: 4, text: "Mind the lantern" }],
	delay: 1.5,
	position: { x: 40, y: 70 },
	fontSize: 24,
	fontFamily: "Georgia, serif",
	preference: { languageCode: "en", rankInLanguage: 1 },
	autoLoad: false,
});

describe("subtitle session", () => {
	beforeEach(() => {
		sessionStorage.clear();
		localStorage.clear();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("has nothing saved at first", () => {
		expect(readSubtitleSession()).toBeNull();
	});

	it("gives back what was saved for the rest of the session", () => {
		saveSubtitleSession(session());
		expect(readSubtitleSession()).toEqual(session());
		expect(localStorage.length).toBe(0);
	});

	it("forgets the saved subtitles for null", () => {
		saveSubtitleSession(session());
		saveSubtitleSession(null);
		expect(sessionStorage.getItem("mvp_lastSubtitles")).toBeNull();
		expect(readSubtitleSession()).toBeNull();
	});

	it("has nothing saved when what's stored can't be read", () => {
		sessionStorage.setItem("mvp_lastSubtitles", "{not json");
		expect(readSubtitleSession()).toBeNull();
	});

	it("leaves nothing saved when saving fails, rather than older subtitles", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		saveSubtitleSession({ ...session(), channelId: "mv0" });
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("full", "QuotaExceededError");
		});
		saveSubtitleSession(session());
		expect(readSubtitleSession()).toBeNull();
	});

	it("changes the subtitles saved for the item and stream", () => {
		saveSubtitleSession(session());
		expect(updateSubtitleSession("mv1", STREAM, { fileId: 102, autoLoad: true })).toBe(true);
		expect(readSubtitleSession()).toEqual({ ...session(), fileId: 102, autoLoad: true });
	});

	it("gives a stream to subtitles saved before the item had one", () => {
		saveSubtitleSession({ ...session(), url: null });
		const url = "/downloads/lantern-keeper.mkv";
		expect(updateSubtitleSession("mv1", null, { url })).toBe(true);
		expect(readSubtitleSession()).toEqual({ ...session(), url });
	});

	it("leaves subtitles saved for another item or stream alone", () => {
		saveSubtitleSession(session());
		expect(updateSubtitleSession("mv2", STREAM, { fileId: 102 })).toBe(false);
		expect(updateSubtitleSession("mv1", "/downloads/lantern-keeper.mkv", { fileId: 102 })).toBe(
			false
		);
		expect(updateSubtitleSession("mv1", null, { fileId: 102 })).toBe(false);
		expect(readSubtitleSession()).toEqual(session());
	});

	it("saves nothing when no subtitles are saved", () => {
		expect(updateSubtitleSession("mv1", null, { fileId: 102 })).toBe(false);
		expect(readSubtitleSession()).toBeNull();
	});
});
