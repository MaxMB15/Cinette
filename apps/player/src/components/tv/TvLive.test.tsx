// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useChannels } from "@/hooks/useChannels";
import { useNowNext } from "@/hooks/useNowNext";
import { formatHHMM } from "@/lib/epg-window";
import { TV_START_ATTRIBUTE } from "@/lib/tv-focus";
import type { Channel, EpgProgram } from "@/lib/types";
import { makeChannel } from "@/test/channel-fixtures";
import { makeProgramme } from "@/test/detail-fixtures";
import { ChannelInfo, TvLive, timeSpan } from "./TvLive";
import { TvNavContext } from "./tv-nav";

vi.mock("@/hooks/useNow", () => ({ useNow: () => NOW }));
vi.mock("@/hooks/useChannels", () => ({ useChannels: vi.fn() }));
vi.mock("@/hooks/useNowNext", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks/useNowNext")>()),
	useNowNext: vi.fn(),
}));

const NOW = 1_800_000_000;

const HEADLINES = makeProgramme("Headlines", NOW - 600, NOW + 600);
const WEATHER = makeProgramme("Weather", NOW + 600, NOW + 1200);

const news1 = makeChannel({ id: "n1", name: "News One", groupTitle: "News" });
const news2 = makeChannel({ id: "n2", name: "News Two", groupTitle: "News" });
const sport = makeChannel({ id: "s1", name: "Sport", groupTitle: "Sport" });
const LIVE = [news1, news2, sport];

const toggleFavorite = vi.fn();

const live = (
	memory: Map<string, unknown>,
	channels: readonly Channel[] = LIVE,
	onPlay: (channel: Channel, list: readonly Channel[]) => void = () => {}
) => (
	<TvNavContext.Provider value={{ section: "live", openSection: () => {}, memory }}>
		<TvLive live={channels} onPlay={onPlay} />
	</TvNavContext.Provider>
);

const groups = () => screen.getByRole("listbox", { name: "Groups" });
const channelList = (group = "All channels") =>
	screen.getByRole("listbox", { name: `Channels in ${group}` });
const active = (list: HTMLElement) => within(list).getByRole("option", { selected: true });
const names = (list: HTMLElement) =>
	within(list)
		.getAllByRole("option")
		.map((row) => row.textContent);

describe("TvLive", () => {
	beforeEach(() => {
		vi.mocked(useChannels).mockReturnValue({ toggleFavorite } as unknown as ReturnType<
			typeof useChannels
		>);
		vi.mocked(useNowNext).mockReturnValue({
			now: NOW,
			programsOf: () => [],
			nowNextOf: (channel) => ({
				now: channel.id === "n1" ? HEADLINES : null,
				next: null,
			}),
			scheduleOf: (channel) => (channel.id === "n1" ? [HEADLINES, WEATHER] : []),
		});
	});

	afterEach(() => {
		cleanup();
		toggleFavorite.mockClear();
	});

	it("shows the groups, every channel first, beside the channels of the first group", () => {
		render(live(new Map()));
		expect(screen.getByRole("heading", { name: "Live TV" })).toBeInTheDocument();
		expect(names(groups())).toEqual(["All channels3", "News2", "Sport1"]);
		expect(names(channelList())).toEqual([`NNews OneHeadlines`, "NNews Two", "SSport"]);
	});

	it("sizes the channel rows and the list for the screen", () => {
		render(live(new Map()));
		expect(channelList().style.height).toBe("32rem");
		expect(active(channelList()).style.height).toBe("3.4rem");
	});

	it("starts in the channels, so one OK plays the channel with its group for zapping", () => {
		const onPlay = vi.fn();
		render(live(new Map(), LIVE, onPlay));
		expect(document.activeElement).toBe(active(channelList()));
		expect(active(channelList())).toHaveAttribute(TV_START_ATTRIBUTE);
		expect(active(groups())).not.toHaveAttribute(TV_START_ATTRIBUTE);

		fireEvent.keyDown(active(groups()), { key: "ArrowDown" });
		fireEvent.keyDown(active(channelList("News")), { key: "ArrowDown" });
		fireEvent.keyDown(active(channelList("News")), { key: "Enter" });
		expect(onPlay).toHaveBeenCalledExactlyOnceWith(news2, [news1, news2]);
	});

	it("shows the channels of the group the cursor reaches, from the first of them", () => {
		const memory = new Map<string, unknown>();
		render(live(memory));
		fireEvent.keyDown(active(channelList()), { key: "ArrowDown" });
		expect(memory.get("live")).toEqual({ group: 0, channel: 1, inGroups: false });

		fireEvent.keyDown(active(groups()), { key: "ArrowDown" });
		fireEvent.keyDown(active(groups()), { key: "ArrowDown" });
		expect(names(channelList("Sport"))).toEqual(["SSport"]);
		expect(memory.get("live")).toEqual({ group: 2, channel: 0, inGroups: true });
	});

	it("shows what's on the channel under the cursor", () => {
		render(live(new Map()));
		const info = screen.getByRole("complementary");
		expect(within(info).getByText("Headlines")).toBeInTheDocument();

		fireEvent.keyDown(active(channelList()), { key: "ArrowDown" });
		expect(within(info).queryByText("Headlines")).not.toBeInTheDocument();
		expect(within(info).getByText("No guide for this channel")).toBeInTheDocument();
	});

	it("favorites the channel under the cursor", () => {
		render(live(new Map()));
		fireEvent.keyDown(active(channelList()), { key: "ArrowDown" });
		fireEvent.click(screen.getByRole("button", { name: "Add to favorites" }));
		expect(toggleFavorite).toHaveBeenCalledExactlyOnceWith("n2");
	});

	it("comes back to the groups if that's where the focus was", () => {
		const memory = new Map<string, unknown>([
			["live", { group: 1, channel: 1, inGroups: true }],
		]);
		render(live(memory));
		expect(document.activeElement).toBe(active(groups()));
		expect(active(groups())).toHaveAttribute(TV_START_ATTRIBUTE);
		expect(active(channelList("News"))).toHaveTextContent("News Two");
		expect(active(channelList("News"))).not.toHaveAttribute(TV_START_ATTRIBUTE);
	});

	it("falls back to the last group and channel when the remembered ones have gone", () => {
		const memory = new Map<string, unknown>([
			["live", { group: 9, channel: 9, inGroups: false }],
		]);
		render(live(memory, [news1, news2, sport, makeChannel({ id: "s2", groupTitle: "Sport" })]));
		// Sport has as many channels as News, so it follows it.
		expect(active(channelList("Sport"))).toHaveTextContent("Test Channel");
		expect(
			within(screen.getByRole("complementary")).getByText("No guide for this channel")
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Add to favorites" })).toBeInTheDocument();
	});

	it("shows no channel details without a channel", () => {
		render(live(new Map(), []));
		expect(names(groups())).toEqual(["All channels0"]);
		expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
	});

	it("keeps a channel's row when the channels change order", () => {
		const memory = new Map<string, unknown>();
		const { rerender } = render(live(memory));
		const row = screen.getByRole("option", { name: "S Sport" });
		rerender(live(memory, [...LIVE].reverse()));
		expect(screen.getByRole("option", { name: "S Sport" })).toBe(row);
	});
});

describe("timeSpan", () => {
	it("gives a program's start and end", () => {
		expect(timeSpan(HEADLINES)).toBe(
			`${formatHHMM(HEADLINES.startTime)} to ${formatHHMM(HEADLINES.endTime)}`
		);
	});
});

describe("ChannelInfo", () => {
	afterEach(cleanup);

	const info = (
		schedule: readonly EpgProgram[],
		overrides: Partial<Parameters<typeof ChannelInfo>[0]> = {}
	) =>
		render(
			<ChannelInfo
				channel={news1}
				schedule={schedule}
				now={NOW}
				onToggleFavorite={() => {}}
				{...overrides}
			/>
		);

	const upcoming = () => screen.queryAllByRole("listitem").map((row) => row.textContent);

	const program = (i: number): EpgProgram =>
		makeProgramme(`Program ${i}`, NOW + i * 600, NOW + (i + 1) * 600);

	it("offers to add a channel that isn't a favorite", () => {
		const onToggleFavorite = vi.fn();
		info([], { onToggleFavorite });
		fireEvent.click(screen.getByRole("button", { name: "Add to favorites" }));
		expect(onToggleFavorite).toHaveBeenCalledTimes(1);
	});

	it("offers to remove a channel that is a favorite", () => {
		info([], { channel: { ...news1, isFavorite: true } });
		expect(screen.getByRole("button", { name: "Remove from favorites" })).toBeInTheDocument();
	});

	it("says there's no guide without any programs", () => {
		info([]);
		expect(screen.getByText("No guide for this channel")).toBeInTheDocument();
		expect(screen.queryByRole("list")).not.toBeInTheDocument();
	});

	it("says nothing's on before the first program, and lists what's coming", () => {
		info([program(1), program(2)]);
		expect(screen.getByText("Nothing on right now")).toBeInTheDocument();
		expect(upcoming()).toEqual([
			`${formatHHMM(program(1).startTime)}Program 1`,
			`${formatHHMM(program(2).startTime)}Program 2`,
		]);
	});

	it("lists four programs at most when nothing's on", () => {
		info([1, 2, 3, 4, 5].map(program));
		expect(upcoming()).toHaveLength(4);
		expect(upcoming()[3]).toContain("Program 4");
	});

	it("shows the program on now, how far through it is, and the next four after it", () => {
		const { container } = info([HEADLINES, ...[1, 2, 3, 4, 5].map(program)]);
		expect(screen.getByText(timeSpan(HEADLINES))).toBeInTheDocument();
		expect(screen.getByText("Headlines")).toBeInTheDocument();
		expect(screen.queryByText("Nothing on right now")).not.toBeInTheDocument();
		expect(container.querySelector<HTMLElement>("[style*=width]")?.style.width).toBe("50%");
		expect(upcoming()).toHaveLength(4);
		expect(upcoming()[0]).toContain("Program 1");
		expect(upcoming()[3]).toContain("Program 4");
	});

	it("keeps a program's row as the ones before it end", () => {
		const { rerender } = info([program(1), program(2)]);
		const row = screen.getByText("Program 2").closest("li");
		rerender(
			<ChannelInfo
				channel={news1}
				schedule={[program(2)]}
				now={NOW}
				onToggleFavorite={() => {}}
			/>
		);
		expect(screen.getByText("Program 2").closest("li")).toBe(row);
	});

	it("counts a program starting this very second as on now", () => {
		info([makeProgramme("Starting", NOW, NOW + 600)]);
		expect(screen.queryByRole("list")).not.toBeInTheDocument();
		expect(screen.getByText("Starting")).toBeInTheDocument();
	});

	it("shows a program's description only if it has one", () => {
		info([makeProgramme("Starting", NOW, NOW + 600, { description: "All about it" })]);
		expect(screen.getByText("All about it")).toBeInTheDocument();
		cleanup();
		const { container } = info([HEADLINES]);
		expect(container.querySelectorAll("p")).toHaveLength(2);
	});

	it("is the height it's told to be, and the screen's column height otherwise", () => {
		info([]);
		expect(screen.getByRole("complementary").style.height).toBe("32rem");
		cleanup();
		info([], { height: 30 });
		expect(screen.getByRole("complementary").style.height).toBe("30rem");
	});
});
