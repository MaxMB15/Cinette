// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { render, screen, fireEvent, cleanup, waitFor, within } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { RecordDialog } from "./RecordDialog";
import { scheduleRecording, stopRecording } from "@/lib/tauri";
import { formatWindow, toLocalInputValue } from "@/lib/recordings";
import type { DownloadRecord } from "@/lib/types";
import { makeCityNews, makeProgramme, makeRecording } from "@/test/detail-fixtures";

let downloads: DownloadRecord[] = [];
vi.mock("@/hooks/useDownloads", () => ({ useDownloads: () => ({ downloads }) }));
vi.mock("@/hooks/useChannels", () => ({ useProviderIds: () => ["xt-1"] }));
vi.mock("@/lib/tauri", () => ({
	scheduleRecording: vi.fn(() => Promise.resolve({})),
	stopRecording: vi.fn(() => Promise.resolve()),
}));

const MIN = 60;
// A whole minute, so the datetime input shows it exactly.
const NOW = 1_791_835_200;

const channel = makeCityNews();

const prog = (startTime: number, endTime: number, title = "Evening News") =>
	makeProgramme(title, startTime, endTime);

const rec = (overrides: Partial<DownloadRecord> = {}) =>
	makeRecording({
		title: "Sports One",
		sourceChannelId: "xt-1-xt-7",
		startAt: NOW + 30 * MIN,
		endAt: NOW + 90 * MIN,
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
		expect(scheduleRecording).toHaveBeenCalledWith("xt-1-xt-0", NOW, NOW + 25 * MIN, {
			title: "Evening News",
			start: NOW - 10 * MIN,
			end: NOW + 20 * MIN,
		});
	});

	it("records a program with the margins and warns about another channel of its provider", async () => {
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
		expect(
			dialog().getByText(/^It overlaps a recording of Sports One from the same provider\./)
		).toBeDefined();
		fireEvent.click(dialog().getByText("Record"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(scheduleRecording).toHaveBeenCalledWith(
			"xt-1-xt-0",
			NOW + 58 * MIN,
			NOW + 125 * MIN,
			{ title: "Late Show", start: NOW + 60 * MIN, end: NOW + 120 * MIN }
		);
	});

	it("won't record a program that runs longer than a recording can", () => {
		const p = prog(NOW + 60 * MIN, NOW + 14 * 60 * MIN, "Marathon");
		render(
			<RecordDialog
				channel={channel}
				request={{ type: "program", program: p }}
				onClose={() => {}}
			/>
		);
		expect(dialog().getByText("A recording can be up to 12 hours long.")).toBeDefined();
		expect((dialog().getByText("Record") as HTMLButtonElement).disabled).toBe(true);
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

	it("asks before it stops a recording, naming its whole time", async () => {
		const onClose = vi.fn();
		const running = rec({ id: "rec-9", status: "recording", title: "City News" });
		render(
			<RecordDialog
				channel={channel}
				request={{ type: "stop", recording: running }}
				onClose={onClose}
			/>
		);
		const when = formatWindow(NOW + 30 * MIN, NOW + 90 * MIN, NOW);
		expect(
			dialog().getByText(
				`This stops the whole recording of City News, ${when}. What it recorded so far stays.`
			)
		).toBeDefined();
		fireEvent.click(dialog().getByText("Stop"));
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(stopRecording).toHaveBeenCalledWith("rec-9");
	});

	it("asks before it cancels a waiting recording, and stops once however often it's clicked", async () => {
		const onClose = vi.fn();
		const waiting = rec({ title: "City News", programTitle: "Late Show" });
		render(
			<RecordDialog
				channel={channel}
				request={{ type: "stop", recording: waiting }}
				onClose={onClose}
			/>
		);
		const when = formatWindow(NOW + 30 * MIN, NOW + 90 * MIN, NOW);
		expect(dialog().getByText("Cancel this recording?")).toBeDefined();
		expect(
			dialog().getByText(
				`This cancels the whole recording of Late Show on City News, ${when}.`
			)
		).toBeDefined();
		const cancel = dialog().getByText("Cancel recording");
		fireEvent.click(cancel);
		fireEvent.click(cancel);
		await waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(stopRecording).toHaveBeenCalledTimes(1);
	});

	it("goes by the recording's latest state", () => {
		const asked = rec({ status: "recording" });
		downloads = [{ ...asked, status: "completed" }];
		render(
			<RecordDialog
				channel={channel}
				request={{ type: "stop", recording: asked }}
				onClose={() => {}}
			/>
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("stays open with the reason when stopping fails", async () => {
		vi.mocked(stopRecording).mockRejectedValueOnce("The recording couldn't be found.");
		const onClose = vi.fn();
		render(
			<RecordDialog
				channel={channel}
				request={{ type: "stop", recording: rec({ status: "recording" }) }}
				onClose={onClose}
			/>
		);
		fireEvent.click(dialog().getByText("Stop"));
		expect(await screen.findByText("The recording couldn't be found.")).toBeDefined();
		expect(onClose).not.toHaveBeenCalled();
		expect((dialog().getByText("Stop") as HTMLButtonElement).disabled).toBe(false);
	});
});
