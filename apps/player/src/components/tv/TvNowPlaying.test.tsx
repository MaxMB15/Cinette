// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { useNowNext, type NowNext } from "@/hooks/useNowNext";
import { formatHHMM } from "@/lib/epg-window";
import type { Channel, EpgProgram } from "@/lib/types";
import { makeChannel } from "@/test/channel-fixtures";
import { makeOmdb } from "@/test/detail-fixtures";
import { timeSpan } from "./TvLive";
import { LiveChip, TvLiveDetails, TvVideoDetails } from "./TvNowPlaying";

vi.mock("@/hooks/useNowNext", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks/useNowNext")>()),
	useNowNext: vi.fn(),
}));

// A half hour boundary, so the guide's marks fall on its edges.
const NOW = 1_800_000_000;
const MIN = 60;

const NEWS = makeChannel({
	id: "news",
	name: "news 24",
	contentType: "live",
	groupTitle: "News",
	logoUrl: "https://img.example.test/news.png",
});

const program = (title: string, from: number, to: number, extra: Partial<EpgProgram> = {}) => ({
	channelId: "news",
	title,
	startTime: NOW + from * MIN,
	endTime: NOW + to * MIN,
	...extra,
});

const guideIs = (programs: EpgProgram[], now: EpgProgram | null = null) =>
	vi.mocked(useNowNext).mockReturnValue({
		now: NOW,
		programsOf: (channel: Channel) => (channel.id === "news" ? programs : []),
		nowNextOf: (): NowNext => ({ now, next: null }),
		scheduleOf: () => [],
	});

const guide = () => screen.getByRole("group", { name: "Guide" });
const block = (title: string) => within(guide()).getByText(title).parentElement!;

describe("LiveChip", () => {
	it("says live, or that it can go live", () => {
		const { rerender } = render(<LiveChip />);
		expect(screen.getByText("LIVE")).toBeInTheDocument();
		rerender(<LiveChip live={false} />);
		expect(screen.getByText("GO LIVE")).toBeInTheDocument();
	});
});

describe("TvVideoDetails", () => {
	it("shows the poster, the facts, the ratings, the plot and what's next", () => {
		render(
			<TvVideoDetails
				eyebrow="Northern Lights"
				title="S1 E2 · The Ice Road"
				omdbData={makeOmdb()}
				upNext="S1 E3 · Thaw"
			/>
		);
		expect(screen.getByText("Northern Lights")).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "S1 E2 · The Ice Road" })).toBeInTheDocument();
		expect(document.querySelector("img")).toHaveAttribute(
			"src",
			"https://img.example.test/sintel.jpg"
		);
		const facts = screen.getByText("2010").parentElement!;
		expect(Array.from(facts.children, (fact) => fact.textContent)).toEqual([
			"2010",
			"15 min",
			"PG-13",
			"Animation",
		]);
		expect(screen.getByText("7.4")).toBeInTheDocument();
		expect(screen.getByText("A lonely young woman searches for her baby dragon.").tagName).toBe(
			"P"
		);
		expect(screen.getByText("UP NEXT")).toBeInTheDocument();
		expect(screen.getByText("S1 E3 · Thaw")).toBeInTheDocument();
	});

	it("shows the logo as the poster when nothing else has one", () => {
		render(<TvVideoDetails title="Sintel" logoUrl="https://img.example.test/logo.png" />);
		expect(document.querySelector("img")).toHaveAttribute(
			"src",
			"https://img.example.test/logo.png"
		);
	});

	it("puts the show's first letter in place of a poster", () => {
		render(<TvVideoDetails eyebrow="northern Lights" title="S1 E2 · The Ice Road" />);
		expect(document.querySelector("img")).toBeNull();
		expect(screen.getByText("N")).toBeInTheDocument();
	});

	it("puts the title's first letter there for a movie", () => {
		render(<TvVideoDetails title="sintel" />);
		expect(screen.getByText("S")).toBeInTheDocument();
	});

	it("leaves out what it doesn't know", () => {
		render(<TvVideoDetails title="Sintel" omdbData={makeOmdb({ plot: undefined })} />);
		expect(screen.queryByText("UP NEXT")).not.toBeInTheDocument();
		expect(screen.queryByText(/baby dragon/)).not.toBeInTheDocument();
		expect(document.querySelector("p:empty")).toBeNull();
		expect(screen.getByRole("heading").previousElementSibling).toBeNull();
	});
});

describe("TvLiveDetails", () => {
	beforeEach(() => guideIs([]));

	it("shows the channel with its logo and group", () => {
		render(<TvLiveDetails channel={NEWS} />);
		expect(screen.getByRole("heading", { name: "news 24" })).toBeInTheDocument();
		expect(screen.getByText("LIVE")).toBeInTheDocument();
		expect(screen.getByText("News")).toBeInTheDocument();
		expect(document.querySelector("img")).toHaveAttribute(
			"src",
			"https://img.example.test/news.png"
		);
	});

	it("puts the channel's first letter in place of a logo", () => {
		render(<TvLiveDetails channel={{ ...NEWS, logoUrl: undefined }} />);
		expect(screen.getByText("N")).toBeInTheDocument();
	});

	it("leaves out a group the channel isn't in", () => {
		render(<TvLiveDetails channel={{ ...NEWS, groupTitle: "" }} />);
		expect(screen.getByRole("heading").parentElement!.nextElementSibling).toBeNull();
	});

	it("shows what's on air, when, what kind and what it's about", () => {
		const on = program("Headlines", -20, 10, {
			category: "News",
			description: "The day's top stories.",
		});
		guideIs([on], on);
		render(<TvLiveDetails channel={{ ...NEWS, groupTitle: "" }} />);
		expect(screen.getByText("ON AIR")).toBeInTheDocument();
		expect(screen.getAllByText("Headlines")[0].tagName).toBe("P");
		expect(screen.getByText(`${timeSpan(on)} · News`)).toBeInTheDocument();
		expect(screen.getByText("The day's top stories.")).toBeInTheDocument();
		expect(
			screen.queryByText("No schedule information for this channel")
		).not.toBeInTheDocument();
	});

	it("shows only the time of a program with nothing more to say", () => {
		const on = program("Headlines", -20, 10);
		guideIs([on], on);
		render(<TvLiveDetails channel={NEWS} />);
		const when = screen.getByText(timeSpan(on));
		expect(when.nextElementSibling).toBeNull();
	});

	it("says when the channel has no guide", () => {
		render(<TvLiveDetails channel={NEWS} />);
		expect(screen.getByText("No schedule information for this channel")).toBeInTheDocument();
		expect(screen.queryByText("ON AIR")).not.toBeInTheDocument();
		expect(screen.queryByRole("group", { name: "Guide" })).not.toBeInTheDocument();
	});

	describe("guide", () => {
		it("marks every half hour from 2½ hours ago to 1½ hours ahead", () => {
			guideIs([program("Headlines", -20, 10)]);
			render(<TvLiveDetails channel={NEWS} />);
			const marks = guide().firstElementChild!.children;
			expect(Array.from(marks, (mark) => mark.textContent)).toEqual(
				[-150, -120, -90, -60, -30, 0, 30, 60].map((m) => formatHHMM(NOW + m * MIN))
			);
			expect((marks[1] as HTMLElement).style.left).toBe("12.5%");
		});

		it("shows the programs that overlap it, past, on now and to come", () => {
			guideIs([
				program("Too early", -200, -150),
				program("Morning", -60, -20),
				program("Headlines", -20, 10),
				program("Weather", 10, 40),
				program("Too late", 90, 120),
			]);
			const error = vi.spyOn(console, "error");
			render(<TvLiveDetails channel={NEWS} />);
			// React says so when two blocks share a key.
			expect(error).not.toHaveBeenCalled();
			error.mockRestore();
			const titles = Array.from(
				guide().lastElementChild!.children,
				(b) => b.firstElementChild!.textContent
			);
			expect(titles).toEqual(["Morning", "Headlines", "Weather", ""]);
			expect(block("Morning")).toHaveClass("text-white/55");
			expect(block("Headlines")).toHaveClass("bg-[hsl(214_72%_46%)]");
			expect(block("Weather")).toHaveClass("border");
		});

		it("gives the start time of what's on and to come, but not of what's done", () => {
			guideIs([program("Morning", -60, 0), program("Headlines", 0, 30)]);
			render(<TvLiveDetails channel={NEWS} />);
			expect(block("Morning").children).toHaveLength(1);
			expect(block("Headlines").lastElementChild).toHaveTextContent(formatHHMM(NOW));
			// What starts this minute is on now.
			expect(block("Headlines")).toHaveClass("bg-[hsl(214_72%_46%)]");
		});

		it("places each program by its time, with a gap each side", () => {
			guideIs([program("Headlines", -30, 30)]);
			render(<TvLiveDetails channel={NEWS} />);
			expect(block("Headlines").style.left).toBe("calc(50% + 0.1rem)");
			expect(block("Headlines").style.width).toBe("calc(25% - 0.2rem)");
		});

		it("draws a line at now", () => {
			guideIs([program("Headlines", -30, 30)]);
			render(<TvLiveDetails channel={NEWS} />);
			expect((guide().lastElementChild!.lastElementChild as HTMLElement).style.left).toBe(
				"62.5%"
			);
		});
	});
});
