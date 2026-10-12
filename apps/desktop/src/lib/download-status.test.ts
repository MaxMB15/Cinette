// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, expect, it } from "vitest";
import { aggregateIconState, downloadIconState, isDownloadActive } from "./download-status";
import type { DownloadIconState, DownloadStatus } from "./types";

/**
 * Whether each status counts as active. Keyed by every status, so a new one
 * breaks the type check until it's listed here.
 */
const ACTIVE: Record<DownloadStatus, boolean> = {
	queued: true,
	downloading: true,
	completed: false,
	failed: false,
	cancelled: false,
	scheduled: false,
	recording: false,
	missed: false,
};

/** The button state for each status. A recording's statuses never reach the button. */
const ICON: Record<DownloadStatus, DownloadIconState> = {
	queued: "downloading",
	downloading: "downloading",
	completed: "complete",
	failed: "failed",
	cancelled: "idle",
	scheduled: "idle",
	recording: "idle",
	missed: "idle",
};

const statuses = (active: boolean) =>
	(Object.keys(ACTIVE) as DownloadStatus[]).filter((s) => ACTIVE[s] === active);

describe("isDownloadActive", () => {
	it.each(statuses(true))("counts a %s download as active", (status) => {
		expect(isDownloadActive({ status })).toBe(true);
	});

	it.each(statuses(false))("doesn't count a %s download as active", (status) => {
		expect(isDownloadActive({ status })).toBe(false);
	});
});

describe("downloadIconState", () => {
	it.each(Object.entries(ICON) as [DownloadStatus, DownloadIconState][])(
		"shows a %s download as %s",
		(status, state) => {
			expect(downloadIconState({ status })).toBe(state);
		}
	);

	it("shows idle when there's no download", () => {
		expect(downloadIconState(undefined)).toBe("idle");
	});
});

describe("aggregateIconState", () => {
	it("shows a series with nothing downloaded as idle", () => {
		expect(aggregateIconState("none")).toBe("idle");
	});

	it("shows a series that is downloading, partly downloaded or complete as it is", () => {
		expect(aggregateIconState("downloading")).toBe("downloading");
		expect(aggregateIconState("partial")).toBe("partial");
		expect(aggregateIconState("complete")).toBe("complete");
	});
});
