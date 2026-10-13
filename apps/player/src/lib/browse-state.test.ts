// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
	addWatchedTime,
	consumeBrowseState,
	saveBrowseSearch,
	saveBrowseTab,
	SEARCH_RESET_AFTER_MS,
} from "./browse-state";

describe("browse-state", () => {
	beforeEach(() => sessionStorage.clear());

	it("returns defaults when nothing is stored", () => {
		expect(consumeBrowseState()).toEqual({ tab: undefined, search: "" });
	});

	it("restores tab and search", () => {
		saveBrowseTab("movie");
		saveBrowseSearch("matrix");
		expect(consumeBrowseState()).toEqual({ tab: "movie", search: "matrix" });
	});

	it("keeps the search after a short watch", () => {
		saveBrowseSearch("matrix");
		addWatchedTime(SEARCH_RESET_AFTER_MS - 1);
		expect(consumeBrowseState().search).toBe("matrix");
	});

	it("clears the search after watching for a minute", () => {
		saveBrowseSearch("matrix");
		addWatchedTime(SEARCH_RESET_AFTER_MS);
		expect(consumeBrowseState().search).toBe("");
		// The cleared search sticks.
		expect(consumeBrowseState().search).toBe("");
	});

	it("adds up watch time across player visits", () => {
		saveBrowseSearch("matrix");
		addWatchedTime(SEARCH_RESET_AFTER_MS / 2);
		addWatchedTime(SEARCH_RESET_AFTER_MS / 2);
		expect(consumeBrowseState().search).toBe("");
	});

	it("resets the watch time once consumed", () => {
		saveBrowseSearch("matrix");
		addWatchedTime(SEARCH_RESET_AFTER_MS - 1);
		consumeBrowseState();
		addWatchedTime(1);
		expect(consumeBrowseState().search).toBe("matrix");
	});

	it("restores the state saved before the page reloaded", () => {
		sessionStorage.setItem(
			"mvp_browseState",
			JSON.stringify({ tab: "series", search: "show" })
		);
		expect(consumeBrowseState()).toEqual({ tab: "series", search: "show" });
	});

	it("doesn't take time off for a negative amount", () => {
		saveBrowseSearch("matrix");
		addWatchedTime(SEARCH_RESET_AFTER_MS);
		addWatchedTime(-1);
		expect(consumeBrowseState().search).toBe("");
	});

	it("ignores non-positive amounts", () => {
		saveBrowseSearch("matrix");
		addWatchedTime(0);
		addWatchedTime(-SEARCH_RESET_AFTER_MS);
		addWatchedTime(SEARCH_RESET_AFTER_MS - 1);
		expect(consumeBrowseState().search).toBe("matrix");
	});

	it("starts fresh when the stored state is corrupt", () => {
		sessionStorage.setItem("mvp_browseState", "{not json");
		expect(consumeBrowseState()).toEqual({ tab: undefined, search: "" });

		saveBrowseTab("live");
		expect(consumeBrowseState()).toEqual({ tab: "live", search: "" });
	});

	it("keeps working when the browser refuses to store anything", () => {
		const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new DOMException("Quota exceeded", "QuotaExceededError");
		});
		try {
			expect(() => saveBrowseSearch("matrix")).not.toThrow();
			expect(consumeBrowseState()).toEqual({ tab: undefined, search: "" });
		} finally {
			setItem.mockRestore();
		}
	});
});
