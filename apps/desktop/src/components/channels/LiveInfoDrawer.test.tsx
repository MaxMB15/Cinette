// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpgProgram } from "@/lib/types";
import { formatHHMM } from "@/lib/epg-window";
import { makeNewsChannel, makeProgramme } from "@/test/detail-fixtures";

const tauri = vi.hoisted(() => ({
	getEpgProgrammes: vi.fn<(id: string, start: number, end: number) => Promise<EpgProgram[]>>(),
}));

vi.mock("@/lib/tauri", () => ({ getEpgProgrammes: tauri.getEpgProgrammes }));

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

const deferred = <T,>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
};

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
