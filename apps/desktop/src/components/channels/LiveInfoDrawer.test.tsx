// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { LiveInfoDrawer } from "./LiveInfoDrawer";
import { getEpgProgrammes, stopRecording } from "@/lib/tauri";
import type { Channel, DownloadRecord, EpgProgram } from "@/lib/types";

let downloads: DownloadRecord[] = [];
vi.mock("@/hooks/useDownloads", () => ({ useDownloads: () => ({ downloads }) }));
vi.mock("@/lib/tauri", () => ({
	getEpgProgrammes: vi.fn(),
	scheduleRecording: vi.fn(() => Promise.resolve({})),
	stopRecording: vi.fn(() => Promise.resolve()),
}));

const MIN = 60;
const now = Math.floor(Date.now() / 1000);

const channel: Channel = {
	id: "xt-1-xt-0",
	name: "City News",
	url: "http://example.com/live/0.ts",
	groupTitle: "News",
	isFavorite: false,
	contentType: "live",
	sources: [],
};

const prog = (startTime: number, endTime: number, title: string): EpgProgram => ({
	channelId: "city.news",
	title,
	startTime,
	endTime,
});

const schedule = [
	prog(now - 90 * MIN, now - 30 * MIN, "Morning Show"),
	prog(now - 30 * MIN, now + 30 * MIN, "Evening News"),
	prog(now + 30 * MIN, now + 90 * MIN, "Late Show"),
];

const rec = (overrides: Partial<DownloadRecord> = {}): DownloadRecord => ({
	id: "rec-1",
	channelId: "rec-1",
	title: "City News",
	kind: "recording",
	seriesChannelId: null,
	status: "scheduled",
	destPath: "",
	totalBytes: null,
	downloadedBytes: 0,
	avgRateBps: null,
	error: null,
	createdAt: 0,
	finishedAt: null,
	keep: false,
	lastPlayedAt: null,
	sourceChannelId: "xt-1-xt-0",
	startAt: now + 28 * MIN,
	endAt: now + 95 * MIN,
	programTitle: "Late Show",
	...overrides,
});

const renderDrawer = async () => {
	render(<LiveInfoDrawer channel={channel} onClose={vi.fn()} />);
	await screen.findAllByText("Late Show");
};

describe("LiveInfoDrawer recording", () => {
	beforeEach(() => {
		downloads = [];
		localStorage.clear();
		Element.prototype.scrollIntoView = vi.fn();
		vi.mocked(getEpgProgrammes).mockResolvedValue(schedule);
		vi.mocked(stopRecording).mockClear();
	});
	afterEach(cleanup);

	it("offers to record now, until the program on air ends", async () => {
		await renderDrawer();
		fireEvent.click(screen.getByText("Record"));
		const dialog = within(screen.getByRole("dialog"));
		expect(dialog.getByText(/until Evening News ends/)).toBeDefined();
	});

	it("records a program from the schedule, but not one that's over", async () => {
		await renderDrawer();
		expect(screen.queryByLabelText("Record Morning Show")).toBeNull();
		fireEvent.click(screen.getByLabelText("Record Late Show"));
		expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Record this program");
	});

	it("cancels the recording that covers a program", async () => {
		downloads = [rec()];
		await renderDrawer();
		fireEvent.click(screen.getByLabelText("Cancel the recording of Late Show"));
		expect(stopRecording).toHaveBeenCalledWith("rec-1");
	});

	it("offers to stop the channel's running recording", async () => {
		downloads = [rec({ status: "recording", startAt: now - MIN, endAt: now + 35 * MIN })];
		await renderDrawer();
		expect(screen.queryByText("Record")).toBeNull();
		fireEvent.click(screen.getByText("Stop recording"));
		expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("Stop recording?");
	});

	it("records a time range", async () => {
		await renderDrawer();
		fireEvent.click(screen.getByLabelText("Record a time range"));
		expect(
			within(screen.getByRole("dialog")).getByLabelText("Length in minutes")
		).toBeDefined();
	});
});
