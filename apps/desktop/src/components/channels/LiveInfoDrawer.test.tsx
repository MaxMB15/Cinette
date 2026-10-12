// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DownloadRecord, EpgProgram } from "@/lib/types";
import { formatHHMM } from "@/lib/epg-window";
import {
	makeCityNews,
	makeNewsChannel,
	makeProgramme,
	makeRecording,
} from "@/test/detail-fixtures";
import { deferred } from "@/test/deferred";

const tauri = vi.hoisted(() => ({
	getEpgProgrammes: vi.fn<(id: string, start: number, end: number) => Promise<EpgProgram[]>>(),
	scheduleRecording: vi.fn(() => Promise.resolve({})),
	stopRecording: vi.fn<(id: string) => Promise<void>>(() => Promise.resolve()),
}));
const state = vi.hoisted(() => ({ downloads: [] as DownloadRecord[] }));

vi.mock("@/lib/tauri", () => ({
	getEpgProgrammes: tauri.getEpgProgrammes,
	scheduleRecording: tauri.scheduleRecording,
	stopRecording: tauri.stopRecording,
}));
vi.mock("@/hooks/useDownloads", () => ({ useDownloads: () => ({ downloads: state.downloads }) }));
vi.mock("@/hooks/useChannels", () => ({ useProviderIds: () => ["xt-1"] }));

import { LiveInfoDrawer } from "./LiveInfoDrawer";

/** Noon UTC. The tests run at ten past. */
const T = Date.UTC(2026, 9, 12, 12, 0) / 1000;
const NOW = T + 600;
const HOUR = 3600;

const breakfast = makeProgramme("Breakfast News", T - 2700, T);
const midday = makeProgramme("Midday Report", T, T + 900);
const film = makeProgramme("Afternoon Film", T + 900, T + 6300);
const evening = makeProgramme("Evening News", T + 6300, T + 13500);
const schedule = [breakfast, midday, film, evening];

const channel = makeNewsChannel({ tvgId: "news24.uk" });

/** The schedule's row for a programme. The timeline shows the same titles. */
const row = (title: string) =>
	within(screen.getByRole("list")).getByText(title).closest("button") as HTMLElement;

const flush = () => act(async () => {});

const advance = (ms: number) =>
	act(() => {
		vi.advanceTimersByTime(ms);
	});

describe("LiveInfoDrawer", () => {
	const scrollIntoView = vi.fn();
	const originalScrollIntoView = Element.prototype.scrollIntoView;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW * 1000);
		// jsdom doesn't scroll, so it has no scrollIntoView.
		Element.prototype.scrollIntoView = scrollIntoView;
		tauri.getEpgProgrammes.mockResolvedValue(schedule);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.clearAllMocks();
		Element.prototype.scrollIntoView = originalScrollIntoView;
	});

	it("asks the guide for twelve hours either side of now by the channel's guide id", async () => {
		render(<LiveInfoDrawer channel={channel} onClose={vi.fn()} />);
		await flush();
		expect(tauri.getEpgProgrammes).toHaveBeenCalledExactlyOnceWith(
			"news24.uk",
			NOW - 12 * HOUR,
			NOW + 12 * HOUR
		);
	});

	it("asks by the channel id when the channel has no guide id", async () => {
		render(<LiveInfoDrawer channel={makeNewsChannel()} onClose={vi.fn()} />);
		await flush();
		expect(tauri.getEpgProgrammes).toHaveBeenCalledWith(
			"ch1",
			NOW - 12 * HOUR,
			NOW + 12 * HOUR
		);
	});

	it("shows the channel's name and logo", async () => {
		const { container } = render(
			<LiveInfoDrawer
				channel={makeNewsChannel({ logoUrl: "https://img.example.test/news24.png" })}
				onClose={vi.fn()}
			/>
		);
		await flush();
		expect(screen.getByText("News 24")).toBeInTheDocument();
		expect(screen.getByText("LIVE")).toBeInTheDocument();
		expect(container.querySelector("img")).toHaveAttribute(
			"src",
			"https://img.example.test/news24.png"
		);
	});

	it("has no logo image for a channel without one", async () => {
		const { container } = render(<LiveInfoDrawer channel={channel} onClose={vi.fn()} />);
		await flush();
		expect(container.querySelector("img")).toBeNull();
	});

	it("shows spinners while the schedule loads", async () => {
		tauri.getEpgProgrammes.mockReturnValue(new Promise(() => {}));
		const { container } = render(<LiveInfoDrawer channel={channel} onClose={vi.fn()} />);
		await flush();
		expect(screen.getByText("Schedule")).toBeInTheDocument();
		expect(container.querySelectorAll(".animate-spin")).toHaveLength(2);
		expect(screen.queryByText("On Air")).toBeNull();
		expect(screen.queryByRole("list")).toBeNull();
		expect(screen.queryByText("Schedule unavailable for this channel.")).toBeNull();
	});

	it("lists each programme with its start time and length", async () => {
		const { container } = render(<LiveInfoDrawer channel={channel} onClose={vi.fn()} />);
		await flush();
		expect(container.querySelectorAll(".animate-spin")).toHaveLength(0);
		const expected: [EpgProgram, string][] = [
			[breakfast, "45 min"],
			[midday, "15 min"],
			[film, "1h 30m"],
			[evening, "2h"],
		];
		for (const [prog, length] of expected) {
			const r = row(prog.title);
			expect(within(r).getByText(formatHHMM(prog.startTime))).toBeInTheDocument();
			expect(within(r).getByText(length)).toBeInTheDocument();
		}
	});

	it("marks the programme on now and ticks off the ones that ended", async () => {
		render(<LiveInfoDrawer channel={channel} onClose={vi.fn()} />);
		await flush();
		expect(within(row("Midday Report")).getByText("▶ now")).toBeInTheDocument();
		expect(within(row("Breakfast News")).getByText("✓")).toBeInTheDocument();
		expect(within(row("Afternoon Film")).queryByText("▶ now")).toBeNull();
		expect(within(row("Afternoon Film")).queryByText("✓")).toBeNull();
		expect(screen.getAllByText("▶ now")).toHaveLength(1);
	});

	it("scrolls the programme on now into view once the schedule loads", async () => {
		render(<LiveInfoDrawer channel={channel} onClose={vi.fn()} />);
		await flush();
		expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({
			behavior: "smooth",
			block: "center",
		});
		expect(scrollIntoView.mock.contexts[0]).toBe(row("Midday Report").closest("li"));
	});

	it("starts with the programme on now picked and shows the timeline", async () => {
		render(<LiveInfoDrawer channel={channel} onClose={vi.fn()} />);
		await flush();
		expect(screen.getByText("On Air")).toBeInTheDocument();
		expect(screen.getByTitle("Midday Report")).toHaveAttribute("role", "button");
		expect(row("Midday Report")).toHaveClass("bg-primary/15");
		expect(row("Evening News")).not.toHaveClass("bg-primary/15");
	});

	it("picks a programme from the timeline or the schedule", async () => {
		render(<LiveInfoDrawer channel={channel} onClose={vi.fn()} />);
		await flush();

		fireEvent.click(screen.getByTitle("Evening News"));
		expect(row("Evening News")).toHaveClass("bg-primary/15");
		expect(row("Midday Report")).not.toHaveClass("bg-primary/15");

		fireEvent.click(row("Breakfast News"));
		expect(row("Breakfast News")).toHaveClass("bg-primary/15");
		expect(row("Evening News")).not.toHaveClass("bg-primary/15");
	});

	it("moves on to the next programme as time passes", async () => {
		render(<LiveInfoDrawer channel={channel} onClose={vi.fn()} />);
		await flush();

		// The clock is read every 30 seconds. The midday report ends five minutes in.
		advance(4.5 * 60 * 1000);
		expect(within(row("Midday Report")).getByText("▶ now")).toBeInTheDocument();

		advance(30 * 1000);
		expect(within(row("Midday Report")).getByText("✓")).toBeInTheDocument();
		expect(within(row("Afternoon Film")).getByText("▶ now")).toBeInTheDocument();
	});

	it("picks nothing and doesn't scroll when nothing is on now", async () => {
		tauri.getEpgProgrammes.mockResolvedValue([film, evening]);
		render(<LiveInfoDrawer channel={channel} onClose={vi.fn()} />);
		await flush();
		expect(row("Afternoon Film")).not.toHaveClass("bg-primary/15");
		expect(screen.queryByText("▶ now")).toBeNull();
		expect(scrollIntoView).not.toHaveBeenCalled();
	});

	it("says the schedule is unavailable when the guide has nothing", async () => {
		tauri.getEpgProgrammes.mockResolvedValue([]);
		render(<LiveInfoDrawer channel={channel} onClose={vi.fn()} />);
		await flush();
		expect(screen.getByText("Schedule unavailable for this channel.")).toBeInTheDocument();
		expect(screen.queryByText("On Air")).toBeNull();
		expect(screen.queryByRole("list")).toBeNull();
	});

	it("says the schedule is unavailable when the guide can't be read", async () => {
		tauri.getEpgProgrammes.mockRejectedValue(new Error("database locked"));
		render(<LiveInfoDrawer channel={channel} onClose={vi.fn()} />);
		await flush();
		expect(screen.getByText("Schedule unavailable for this channel.")).toBeInTheDocument();
	});

	it("keeps the new channel's schedule when the old channel's answer comes late", async () => {
		const first = deferred<EpgProgram[]>();
		const second = deferred<EpgProgram[]>();
		tauri.getEpgProgrammes
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		const { rerender } = render(<LiveInfoDrawer channel={channel} onClose={vi.fn()} />);
		rerender(
			<LiveInfoDrawer
				channel={makeNewsChannel({ id: "ch2", name: "Sports 1", tvgId: "sports1.uk" })}
				onClose={vi.fn()}
			/>
		);
		expect(tauri.getEpgProgrammes).toHaveBeenLastCalledWith(
			"sports1.uk",
			NOW - 12 * HOUR,
			NOW + 12 * HOUR
		);

		second.resolve([makeProgramme("Match Of The Day", T, T + HOUR)]);
		await flush();
		first.resolve(schedule);
		await flush();

		expect(row("Match Of The Day")).toBeInTheDocument();
		expect(screen.queryByText("Midday Report")).toBeNull();
	});

	it("closes after sliding away when the close button is clicked", async () => {
		const onClose = vi.fn();
		render(<LiveInfoDrawer channel={channel} onClose={onClose} />);
		await flush();

		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		advance(299);
		expect(onClose).not.toHaveBeenCalled();
		advance(1);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("closes when the backdrop behind the sheet is clicked", async () => {
		const onClose = vi.fn();
		const { container } = render(<LiveInfoDrawer channel={channel} onClose={onClose} />);
		await flush();

		const backdrop = container.firstElementChild!.firstElementChild as HTMLElement;
		fireEvent.click(backdrop);
		advance(300);
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

describe("LiveInfoDrawer recording", () => {
	const MIN = 60;
	const now = Math.floor(Date.now() / 1000);

	const channel = makeCityNews();

	const schedule = [
		makeProgramme("Morning Show", now - 90 * MIN, now - 30 * MIN),
		makeProgramme("Evening News", now - 30 * MIN, now + 30 * MIN),
		makeProgramme("Late Show", now + 30 * MIN, now + 90 * MIN),
	];

	const rec = (overrides: Partial<DownloadRecord> = {}) =>
		makeRecording({
			startAt: now + 28 * MIN,
			endAt: now + 95 * MIN,
			programTitle: "Late Show",
			...overrides,
		});

	const renderDrawer = async () => {
		render(<LiveInfoDrawer channel={channel} onClose={vi.fn()} />);
		await screen.findAllByText("Late Show");
	};

	beforeEach(() => {
		state.downloads = [];
		localStorage.clear();
		Element.prototype.scrollIntoView = vi.fn();
		tauri.getEpgProgrammes.mockResolvedValue(schedule);
		tauri.stopRecording.mockClear();
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
		expect(screen.getByRole("dialog", { name: "Record this program" })).toBeDefined();
	});

	it("waits for the guide before it offers to record now", () => {
		tauri.getEpgProgrammes.mockReturnValue(new Promise(() => {}));
		render(<LiveInfoDrawer channel={channel} onClose={vi.fn()} />);
		expect((screen.getByText("Record") as HTMLButtonElement).disabled).toBe(true);
	});

	it("asks before it cancels the recording that covers a program, which may cover more", async () => {
		state.downloads = [rec({ endAt: now + 150 * MIN, programTitle: "Late Show" })];
		await renderDrawer();
		fireEvent.click(screen.getByLabelText("Cancel the recording of Late Show"));
		expect(tauri.stopRecording).not.toHaveBeenCalled();
		const dialog = within(screen.getByRole("dialog", { name: "Cancel this recording?" }));
		expect(
			dialog.getByText(/^This cancels the whole recording of Late Show on City News, /)
		).toBeDefined();
		fireEvent.click(dialog.getByText("Cancel recording"));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(tauri.stopRecording).toHaveBeenCalledWith("rec-1");
	});

	it("keeps the recording when the user changes their mind", async () => {
		state.downloads = [rec()];
		await renderDrawer();
		fireEvent.click(screen.getByLabelText("Cancel the recording of Late Show"));
		fireEvent.click(within(screen.getByRole("dialog")).getByText("Keep"));
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(tauri.stopRecording).not.toHaveBeenCalled();
	});

	it("finds the channel's recording after a refresh gave the channel another id", async () => {
		state.downloads = [
			rec({ sourceChannelId: "xt-1-xt-4", status: "recording", startAt: now - MIN }),
		];
		await renderDrawer();
		expect(screen.getByText("Stop recording")).toBeDefined();
	});

	it("leaves out another channel's recording that took over this channel's id", async () => {
		state.downloads = [rec({ title: "Sports One", status: "recording", startAt: now - MIN })];
		await renderDrawer();
		expect(screen.queryByText("Stop recording")).toBeNull();
		expect(screen.getByLabelText("Record Late Show")).toBeDefined();
	});

	it("offers to stop the channel's running recording", async () => {
		state.downloads = [rec({ status: "recording", startAt: now - MIN, endAt: now + 35 * MIN })];
		await renderDrawer();
		expect(screen.queryByText("Record")).toBeNull();
		fireEvent.click(screen.getByText("Stop recording"));
		expect(screen.getByRole("dialog", { name: "Stop recording?" })).toBeDefined();
	});

	it("records a time range", async () => {
		await renderDrawer();
		fireEvent.click(screen.getByLabelText("Record a time range"));
		expect(
			within(screen.getByRole("dialog")).getByLabelText("Length in minutes")
		).toBeDefined();
	});
});
