// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useNowNext } from "@/hooks/useNowNext";
import { formatHHMM } from "@/lib/epg-window";
import type { Channel, EpgProgram } from "@/lib/types";
import { makeChannel } from "@/test/channel-fixtures";
import { makeProgramme } from "@/test/detail-fixtures";
import { timeLeft } from "./TvControls";
import { TvGuidePage, TvGuidePanel } from "./TvGuide";
import { timeSpan } from "./TvLive";
import { TvNavContext } from "./tv-nav";

/** The time the guide reads. Setting it renders what reads it again, as the real clock's tick does. */
const clock = vi.hoisted(() => {
	const listeners = new Set<() => void>();
	const state = {
		now: 0,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set: (now: number) => {
			state.now = now;
			listeners.forEach((l) => l());
		},
	};
	return state;
});

vi.mock("@/hooks/useNow", async () => {
	const { useSyncExternalStore } = await import("react");
	return { useNow: () => useSyncExternalStore(clock.subscribe, () => clock.now) };
});
vi.mock("@/hooks/useNowNext", () => ({ useNowNext: vi.fn() }));

const HALF = 1800;
/** On the half hour, where the grid starts. */
const NINE = 1_800_000_000;

const MORNING = makeProgramme("Morning", NINE - HALF, NINE + 900);
const HEADLINES = makeProgramme("Headlines", NINE + 900, NINE + 2700, {
	description: "The day's stories",
});
const FILM = makeProgramme("Film", NINE + 2700, NINE + 9000);
const LATE = makeProgramme("Late", NINE + 6 * HALF, NINE + 7 * HALF);
const CONCERT = makeProgramme("Concert", NINE, NINE + 300);
const ENCORE = makeProgramme("Encore", NINE + HALF, NINE + 2 * HALF);

const news = makeChannel({ id: "news", name: "News", groupTitle: "News" });
const music = makeChannel({ id: "music", name: "Music", groupTitle: "Music" });
const sports = makeChannel({ id: "sports", name: "Sports", groupTitle: "Music" });
const CHANNELS = [news, music, sports];

const PROGRAMS: Record<string, EpgProgram[]> = {
	news: [MORNING, HEADLINES, FILM, LATE],
	music: [CONCERT, ENCORE],
};

const renderPanel = (currentId = "news", channels: readonly Channel[] = CHANNELS) => {
	const handlers = { onPlay: vi.fn(), onClose: vi.fn() };
	render(<TvGuidePanel channels={channels} currentId={currentId} {...handlers} />);
	return handlers;
};

const cursor = () => screen.getByRole("option", { selected: true });
const row = (name: string) => screen.getByRole("option", { name: new RegExp(`^${name}`) });
const press = (key: string) => fireEvent.keyDown(cursor(), { key });
/** A program's block in its channel's row. */
const block = (name: string, title: string) => within(row(name)).getByText(title).parentElement!;
/** The line under the title above the grid. */
const detailsLine = (text: string) => screen.getByText(text, { selector: "p" });
const programLine = (program: EpgProgram, left?: number) =>
	["News", timeSpan(program), ...(left === undefined ? [] : [timeLeft(left)])].join(", ");
const marks = () => screen.getByRole("listbox").parentElement!.previousElementSibling!;
const nowLine = () =>
	screen.getByRole("listbox").parentElement!.children[1]?.firstElementChild as
		HTMLElement | undefined;

let consoleError: MockInstance<typeof console.error>;

beforeEach(() => {
	consoleError = vi.spyOn(console, "error");
});

afterEach(() => {
	// React warns once about a list with no keys, so every test looks for it.
	const keyWarnings = consoleError.mock.calls.filter(([message]) =>
		String(message).includes('unique "key"')
	);
	consoleError.mockRestore();
	expect(keyWarnings).toEqual([]);
});

describe("TvGuidePanel", () => {
	beforeEach(() => {
		clock.now = NINE + 600;
		vi.mocked(useNowNext).mockReset();
		vi.mocked(useNowNext).mockReturnValue({
			programsOf: (channel: Channel) => PROGRAMS[channel.id] ?? [],
		} as unknown as ReturnType<typeof useNowNext>);
	});

	it("opens over the video with the cursor and the focus on the channel playing", () => {
		renderPanel("music");
		expect(screen.getByRole("dialog", { name: "Guide" })).toBeInTheDocument();
		expect(screen.getByRole("listbox", { name: "Channels" })).toBeInTheDocument();
		expect(cursor()).toBe(row("Music"));
		expect(cursor()).toHaveFocus();
		expect(
			screen.getByText("OK to watch. Left or Right to move through time. Back to close.")
		).toBeInTheDocument();
	});

	it("starts at the first channel when the one playing isn't in the list", () => {
		renderPanel("elsewhere");
		expect(cursor()).toBe(row("News"));
	});

	it("shows two hours of each channel's programs from the half hour, with the times above", () => {
		renderPanel();
		expect(row("News")).toHaveTextContent(/^NewsMorningHeadlinesFilm$/);
		expect(useNowNext).toHaveBeenLastCalledWith(NINE + 4 * HALF);
		expect([...marks().children].map((mark) => mark.textContent)).toEqual(
			[0, 1, 2, 3].map((i) => formatHHMM(NINE + i * HALF))
		);
		expect([...marks().children].map((mark) => (mark as HTMLElement).style.left)).toEqual([
			"0%",
			"25%",
			"50%",
			"75%",
		]);
		expect(block("News", "Headlines").style.left).toBe("calc(12.5% + 0.1rem)");
		expect(block("News", "Headlines").style.width).toBe("calc(25% - 0.2rem)");
	});

	it("lines the times up with the programs, past the channel names", () => {
		renderPanel();
		const name = within(row("News")).getByText("News").parentElement!;
		expect(name.style.width).toBe("10.5rem");
		expect((marks() as HTMLElement).style.marginLeft).toBe("10.5rem");
		expect((marks() as HTMLElement).style.height).toBe("1.6rem");
		expect(screen.getByRole("listbox").style.height).toBe("19.5rem");
		expect(cursor().style.height).toBe("3.25rem");
	});

	it("marks the program under the cursor and dims what's over", () => {
		renderPanel();
		expect(block("News", "Morning")).toHaveClass("tv-guide-focus");
		expect(block("News", "Headlines")).not.toHaveClass("tv-guide-focus");
		expect(row("Music").querySelector(".tv-guide-focus")).toBeNull();
		expect(block("Music", "Concert")).toHaveClass("opacity-50");
		expect(block("News", "Morning")).not.toHaveClass("opacity-50");
	});

	it("describes the program under the cursor, with what's left of it", () => {
		renderPanel();
		const line = detailsLine(programLine(MORNING, 300));
		expect(line.previousElementSibling).toHaveTextContent(/^Morning$/);
		expect(line.parentElement!.style.height).toBe("7.5rem");
		expect(line.nextElementSibling).toBeNull();
	});

	it("counts the time left from a program's first moment", () => {
		clock.now = NINE + 900;
		renderPanel();
		expect(detailsLine(programLine(HEADLINES, 1800))).toBeInTheDocument();
	});

	it("moves through time with Left and Right, and describes a later program without time left", () => {
		renderPanel();
		expect(press("ArrowRight")).toBe(false);
		const line = detailsLine(programLine(HEADLINES));
		expect(line.previousElementSibling).toHaveTextContent(/^Headlines$/);
		expect(line.nextElementSibling).toHaveTextContent("The day's stories");
		expect(block("News", "Headlines")).toHaveClass("tv-guide-focus");
		expect(cursor()).toHaveFocus();

		press("ArrowRight");
		expect(detailsLine(programLine(FILM))).toBeInTheDocument();
		press("ArrowLeft");
		expect(detailsLine(programLine(HEADLINES))).toBeInTheDocument();
		expect(press("ArrowLeft")).toBe(false);
		expect(detailsLine(programLine(MORNING, 300))).toBeInTheDocument();
	});

	it("leaves Left to the page at the program on now", () => {
		renderPanel();
		expect(press("ArrowLeft")).toBe(true);
		expect(detailsLine(programLine(MORNING, 300))).toBeInTheDocument();
	});

	it("keeps the time as Up and Down change channel", () => {
		renderPanel();
		press("ArrowRight");
		press("ArrowRight");
		press("ArrowDown");
		expect(cursor()).toBe(row("Music"));
		expect(block("Music", "Encore")).toHaveClass("tv-guide-focus");
		expect(
			detailsLine(["Music", timeSpan(ENCORE)].join(", ")).previousElementSibling
		).toHaveTextContent(/^Encore$/);
		press("ArrowUp");
		expect(detailsLine(programLine(FILM))).toBeInTheDocument();
	});

	it("says when a channel has nothing on at the cursor's time", () => {
		renderPanel("music");
		expect(row("Music")).toHaveTextContent(/^MusicConcertEncore$/);
		const line = detailsLine("No schedule information for this time");
		expect(line.previousElementSibling).toHaveTextContent(/^Music$/);
	});

	it("says when a channel has no schedule information at all", () => {
		renderPanel("sports");
		expect(row("Sports")).toHaveTextContent(/^SportsNo schedule information$/);
		const line = detailsLine("No schedule information for this channel");
		expect(line.previousElementSibling).toHaveTextContent(/^Sports$/);
		expect(press("ArrowRight")).toBe(true);
	});

	it("moves the grid on when the cursor reaches its last half hour, and back", () => {
		renderPanel();
		press("ArrowRight");
		press("ArrowRight");
		expect(marks().firstElementChild).toHaveTextContent(formatHHMM(NINE));
		press("ArrowRight");
		expect(detailsLine("No schedule information for this time")).toBeInTheDocument();
		expect(marks().firstElementChild).toHaveTextContent(formatHHMM(NINE + 4 * HALF));
		expect(useNowNext).toHaveBeenLastCalledWith(NINE + 8 * HALF);
		expect(row("News")).toHaveTextContent(/^NewsFilmLate$/);
		expect(block("News", "Film").style.left).toBe("calc(0% + 0.1rem)");
		expect(nowLine()).toBeUndefined();

		press("ArrowLeft");
		expect(detailsLine(programLine(FILM))).toBeInTheDocument();
		expect(marks().firstElementChild).toHaveTextContent(formatHHMM(NINE));
		expect(nowLine()).toBeDefined();
	});

	it("draws a line at now while the grid starts at the current half hour", () => {
		renderPanel();
		expect(nowLine()!.style.left).toBe(`${(600 / (4 * HALF)) * 100}%`);
		expect(nowLine()!.parentElement!.style.left).toBe("10.5rem");
	});

	it("moves the cursor and the grid on with the clock", () => {
		renderPanel();
		act(() => clock.set(NINE + 1000));
		expect(detailsLine(programLine(HEADLINES, 1700))).toBeInTheDocument();
		expect(marks().firstElementChild).toHaveTextContent(formatHHMM(NINE));

		act(() => clock.set(NINE + HALF));
		expect(marks().firstElementChild).toHaveTextContent(formatHHMM(NINE + HALF));
		expect(nowLine()!.style.left).toBe("0%");
	});

	it("plays the channel under the cursor with OK", () => {
		const { onPlay } = renderPanel();
		press("ArrowDown");
		press("Enter");
		expect(onPlay).toHaveBeenCalledTimes(1);
		expect(onPlay.mock.calls[0][0]).toBe(music);
	});

	it("closes on Back without playing", () => {
		const { onClose, onPlay } = renderPanel();
		press("Escape");
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onPlay).not.toHaveBeenCalled();
	});

	it("shows no details without any channels, and leaves Right to the page", () => {
		renderPanel("news", []);
		expect(screen.queryByText(/No schedule information/)).not.toBeInTheDocument();
		expect(screen.queryAllByRole("option")).toHaveLength(0);
		expect(fireEvent.keyDown(screen.getByRole("listbox"), { key: "ArrowRight" })).toBe(true);
	});
});

describe("TvGuidePage", () => {
	beforeEach(() => {
		clock.now = NINE + 600;
		vi.mocked(useNowNext).mockReturnValue({
			programsOf: (channel: Channel) => PROGRAMS[channel.id] ?? [],
		} as unknown as ReturnType<typeof useNowNext>);
	});

	const page = (
		memory: Map<string, unknown>,
		onPlay: (channel: Channel, list: readonly Channel[]) => void = () => {}
	) => (
		<TvNavContext.Provider value={{ section: "guide", openSection: () => {}, memory }}>
			<TvGuidePage live={CHANNELS} onPlay={onPlay} />
		</TvNavContext.Provider>
	);
	const groups = () => screen.getByRole("listbox", { name: "Groups" });
	const grid = (group = "All channels") =>
		screen.getByRole("listbox", { name: `Channels in ${group}` });
	const active = (list: HTMLElement) => within(list).getByRole("option", { selected: true });

	it("shows the groups beside the grid, with the focus in the grid", () => {
		render(page(new Map()));
		expect(screen.getByRole("heading", { name: "Guide" })).toBeInTheDocument();
		expect(within(groups()).getAllByRole("option")).toHaveLength(3);
		expect(document.activeElement).toBe(active(grid()));
		expect(grid().style.height).toBe("22.75rem");
	});

	it("shows the group the cursor reaches, and remembers where it was", () => {
		const memory = new Map<string, unknown>();
		render(page(memory));
		fireEvent.keyDown(active(grid()), { key: "ArrowDown" });
		expect(memory.get("guide")).toEqual({ group: 0, channel: 1, inGroups: false });

		fireEvent.keyDown(active(groups()), { key: "ArrowDown" });
		expect(within(grid("Music")).getAllByRole("option")).toHaveLength(2);
		expect(memory.get("guide")).toEqual({ group: 1, channel: 0, inGroups: true });
	});

	it("comes back to the groups if that's where the focus was", () => {
		render(page(new Map([["guide", { group: 1, channel: 0, inGroups: true }]])));
		expect(document.activeElement).toBe(active(groups()));
	});

	it("describes the last channel when the remembered one has gone", () => {
		render(page(new Map([["guide", { group: 1, channel: 9, inGroups: false }]])));
		expect(detailsLine("No schedule information for this channel")).toBeInTheDocument();
	});

	it("plays the channel under the cursor with its group to step through", () => {
		const onPlay = vi.fn();
		render(page(new Map([["guide", { group: 1, channel: 1, inGroups: false }]]), onPlay));
		fireEvent.keyDown(active(grid("Music")), { key: "Enter" });
		expect(onPlay).toHaveBeenCalledExactlyOnceWith(sports, [music, sports]);
	});
});
