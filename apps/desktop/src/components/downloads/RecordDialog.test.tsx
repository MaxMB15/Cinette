// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { RecordDialog } from "./RecordDialog";
import { scheduleRecording, stopRecording } from "@/lib/tauri";
import { toLocalInputValue } from "@/lib/recordings";
import type { Channel, DownloadRecord, EpgProgram } from "@/lib/types";

let downloads: DownloadRecord[] = [];
vi.mock("@/hooks/useDownloads", () => ({ useDownloads: () => ({ downloads }) }));
vi.mock("@/lib/tauri", () => ({
	scheduleRecording: vi.fn(() => Promise.resolve({})),
	stopRecording: vi.fn(() => Promise.resolve()),
}));

const MIN = 60;
// A whole minute, so the datetime input shows it exactly.
const NOW = 1_791_835_200;

const channel: Channel = {
	id: "xt-1-xt-0",
	name: "City News",
	url: "http://example.com/live/0.ts",
	groupTitle: "News",
	isFavorite: false,
	contentType: "live",
	sources: [],
};

const prog = (startTime: number, endTime: number, title = "Evening News"): EpgProgram => ({
	channelId: "city.news",
	title,
	startTime,
	endTime,
});

const rec = (overrides: Partial<DownloadRecord> = {}): DownloadRecord => ({
	id: "rec-1",
	channelId: "rec-1",
	title: "Sports One",
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
	sourceChannelId: "xt-1-xt-7",
	startAt: NOW + 30 * MIN,
	endAt: NOW + 90 * MIN,
	programTitle: null,
	...overrides,
});

const dialog = () => within(screen.getByRole("dialog"));

describe("RecordDialog", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW * 1000);
		localStorage.clear();
		downloads = [];
		vi.mocked(scheduleRecording).mockClear();
		vi.mocked(stopRecording).mockClear();
	});
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("records now until the program on air ends, plus the margin", async () => {
		const onClose = vi.fn();
		const onAir = prog(NOW - 10 * MIN, NOW + 20 * MIN);
		render(
			<RecordDialog channel={channel} request={{ type: "now", onAir }} onClose={onClose} />
		);
		expect(
			dialog().getByText(
				"Records City News until Evening News ends and 5 minutes more. You can stop it sooner."
			)
		).toBeDefined();
		fireEvent.click(dialog().getByText("Record"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(scheduleRecording).toHaveBeenCalledWith(
			"xt-1-xt-0",
			NOW,
			NOW + 25 * MIN,
			"Evening News"
		);
	});

	it("records a program with the margins and warns about another channel at the same time", async () => {
		downloads = [rec()];
		const onClose = vi.fn();
		const p = prog(NOW + 60 * MIN, NOW + 120 * MIN, "Late Show");
		render(
			<RecordDialog
				channel={channel}
				request={{ type: "program", program: p }}
				onClose={onClose}
			/>
		);
		expect(dialog().getByText(/^It overlaps a recording of Sports One\./)).toBeDefined();
		fireEvent.click(dialog().getByText("Record"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(scheduleRecording).toHaveBeenCalledWith(
			"xt-1-xt-0",
			NOW + 58 * MIN,
			NOW + 125 * MIN,
			"Late Show"
		);
	});

	it("records a time range once it has a start and a length", async () => {
		const onClose = vi.fn();
		render(<RecordDialog channel={channel} request={{ type: "range" }} onClose={onClose} />);
		const record = dialog().getByText("Record") as HTMLButtonElement;
		const [start, length] = [
			dialog().getByLabelText("Start") as HTMLInputElement,
			dialog().getByLabelText("Length in minutes") as HTMLInputElement,
		];

		fireEvent.change(length, { target: { value: "0" } });
		expect(record.disabled).toBe(true);

		fireEvent.change(length, { target: { value: "30" } });
		fireEvent.change(start, { target: { value: toLocalInputValue(NOW - 60 * MIN) } });
		expect(dialog().getByText("That time has already passed.")).toBeDefined();
		expect(record.disabled).toBe(true);

		fireEvent.change(start, { target: { value: toLocalInputValue(NOW + 60 * MIN) } });
		expect(record.disabled).toBe(false);
		fireEvent.click(record);
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(scheduleRecording).toHaveBeenCalledWith(
			"xt-1-xt-0",
			NOW + 60 * MIN,
			NOW + 90 * MIN,
			null
		);
	});

	it("stays open with the reason when the app says no", async () => {
		vi.mocked(scheduleRecording).mockRejectedValueOnce("Only live channels can be recorded.");
		const onClose = vi.fn();
		render(
			<RecordDialog
				channel={channel}
				request={{ type: "now", onAir: null }}
				onClose={onClose}
			/>
		);
		fireEvent.click(dialog().getByText("Record"));
		expect(await screen.findByText("Only live channels can be recorded.")).toBeDefined();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("asks before it stops a recording", async () => {
		const onClose = vi.fn();
		const running = rec({ id: "rec-9", status: "recording", title: "City News" });
		render(
			<RecordDialog
				channel={channel}
				request={{ type: "stop", recording: running }}
				onClose={onClose}
			/>
		);
		expect(
			dialog().getByText("The recording of City News keeps what it has so far.")
		).toBeDefined();
		fireEvent.click(dialog().getByText("Stop"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(stopRecording).toHaveBeenCalledWith("rec-9");
	});
});
