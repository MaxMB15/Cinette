// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EpgTimelineBar } from "./EpgTimelineBar";
import { formatHHMM } from "@/lib/epg-window";
import { makeProgramme } from "@/test/detail-fixtures";

/** 11:00 UTC. The window below runs three hours from here, with now at 12:00. */
const T = Date.UTC(2026, 9, 12, 11, 0) / 1000;
const now = T + 3600;
const windowStart = T;
const windowEnd = T + 3 * 3600;

const morning = makeProgramme("Morning Show", T - 1800, T + 1800);
const midday = makeProgramme("Midday Report", T + 1800, T + 5400);
const film = makeProgramme("Afternoon Film", T + 5400, T + 9000);
// Six minutes is wide enough to draw but too narrow for its title.
const flash = makeProgramme("News Flash", T + 9000, T + 9360);
const programmes = [morning, midday, film, flash];

const block = (title: string) => screen.getByTitle(title);

/** Where a programme's block starts and how wide it is, in percent of the bar. */
const placement = (title: string) => ({
	left: parseFloat(block(title).style.left),
	width: parseFloat(block(title).style.width),
});

describe("EpgTimelineBar", () => {
	afterEach(cleanup);

	it("places each programme by its start and length within the window", () => {
		render(
			<EpgTimelineBar
				programmes={programmes}
				now={now}
				windowStart={windowStart}
				windowEnd={windowEnd}
			/>
		);
		// The morning show started before the window, so it's cut at the left edge.
		expect(placement("Morning Show")).toEqual({ left: 0, width: 16.667 });
		expect(placement("Midday Report")).toEqual({ left: 16.667, width: 33.333 });
		expect(placement("Afternoon Film")).toEqual({ left: 50, width: 33.333 });
	});

	it("leaves out programmes outside the window and ones too short to see", () => {
		render(
			<EpgTimelineBar
				programmes={[
					makeProgramme("Yesterday", T - 7200, T - 3600),
					makeProgramme("Ends At Start", T - 1800, T),
					makeProgramme("Twenty Seconds", T + 9360, T + 9380),
					makeProgramme("Starts At End", windowEnd, windowEnd + 1800),
					midday,
				]}
				now={now}
				windowStart={windowStart}
				windowEnd={windowEnd}
			/>
		);
		expect(block("Midday Report")).toBeInTheDocument();
		for (const title of ["Yesterday", "Ends At Start", "Twenty Seconds", "Starts At End"]) {
			expect(screen.queryByTitle(title)).toBeNull();
		}
	});

	it("writes the title inside blocks wide enough to read it", () => {
		render(
			<EpgTimelineBar
				programmes={programmes}
				now={now}
				windowStart={windowStart}
				windowEnd={windowEnd}
			/>
		);
		expect(within(block("Midday Report")).getByText("Midday Report")).toBeInTheDocument();
		expect(within(block("News Flash")).queryByText("News Flash")).toBeNull();
	});

	it("draws the now marker at the current time", () => {
		const { container } = render(
			<EpgTimelineBar
				programmes={programmes}
				now={now}
				windowStart={windowStart}
				windowEnd={windowEnd}
			/>
		);
		const marker = container.querySelector<HTMLElement>('[class*="bg-red-400"]');
		expect(parseFloat(marker!.style.left)).toBe(33.333);
	});

	it("shows an hour before now through two hours after it by default", () => {
		render(
			<EpgTimelineBar
				programmes={[
					makeProgramme("Last Hour", now - 3600, now),
					makeProgramme("Later Tonight", now + 7200, now + 9000),
				]}
				now={now}
			/>
		);
		expect(placement("Last Hour")).toEqual({ left: 0, width: 33.333 });
		expect(screen.queryByTitle("Later Tonight")).toBeNull();
	});

	it("labels the half hours under the bar but not the ones at its edges", () => {
		// Each end of this window sits a minute from a mark, too close to fit a label.
		render(
			<EpgTimelineBar
				programmes={programmes}
				now={now}
				windowStart={T - 60}
				windowEnd={T + 5460}
				showLabels
			/>
		);
		expect(screen.getByText(formatHHMM(T + 1800))).toBeInTheDocument();
		expect(screen.getByText(formatHHMM(T + 3600))).toBeInTheDocument();
		expect(screen.queryByText(formatHHMM(T))).toBeNull();
		expect(screen.queryByText(formatHHMM(T + 5400))).toBeNull();
	});

	it("keeps each time label on one line", () => {
		// Near the right edge, a label has less room than its text, and a 12-hour
		// time like "06:30 AM" would wrap there.
		render(
			<EpgTimelineBar
				programmes={programmes}
				now={now}
				windowStart={windowStart}
				windowEnd={windowEnd}
				showLabels
			/>
		);
		for (const halfHours of [1, 2, 3, 4, 5]) {
			expect(screen.getByText(formatHHMM(T + halfHours * 1800))).toHaveClass(
				"whitespace-nowrap"
			);
		}
	});

	it("has no time labels unless asked", () => {
		render(
			<EpgTimelineBar
				programmes={programmes}
				now={now}
				windowStart={windowStart}
				windowEnd={windowEnd}
			/>
		);
		expect(screen.queryByText(formatHHMM(T + 3600))).toBeNull();
	});

	it("picks a programme on click without the click reaching the row behind it", () => {
		const onSelect = vi.fn();
		const onRowClick = vi.fn();
		render(
			<div onClick={onRowClick}>
				<EpgTimelineBar
					programmes={programmes}
					now={now}
					windowStart={windowStart}
					windowEnd={windowEnd}
					onSelect={onSelect}
				/>
			</div>
		);
		fireEvent.click(screen.getByRole("button", { name: "Afternoon Film" }));
		expect(onSelect).toHaveBeenCalledExactlyOnceWith(film);
		expect(onRowClick).not.toHaveBeenCalled();
	});

	it("picks a programme with Enter or Space and ignores other keys", () => {
		const onSelect = vi.fn();
		render(
			<EpgTimelineBar
				programmes={programmes}
				now={now}
				windowStart={windowStart}
				windowEnd={windowEnd}
				onSelect={onSelect}
			/>
		);
		const midBlock = screen.getByRole("button", { name: "Midday Report" });
		expect(midBlock).toHaveAttribute("tabindex", "0");

		fireEvent.keyDown(midBlock, { key: "a" });
		expect(onSelect).not.toHaveBeenCalled();

		fireEvent.keyDown(midBlock, { key: "Enter" });
		fireEvent.keyDown(midBlock, { key: " " });
		expect(onSelect).toHaveBeenCalledTimes(2);
		expect(onSelect).toHaveBeenNthCalledWith(1, midday);
		expect(onSelect).toHaveBeenNthCalledWith(2, midday);
	});

	it("can't be clicked or focused without a handler", () => {
		const onRowClick = vi.fn();
		render(
			<div onClick={onRowClick}>
				<EpgTimelineBar
					programmes={programmes}
					now={now}
					windowStart={windowStart}
					windowEnd={windowEnd}
				/>
			</div>
		);
		expect(screen.queryAllByRole("button")).toHaveLength(0);
		expect(block("Midday Report")).not.toHaveAttribute("tabindex");
		// The click goes on to the row, which plays the channel.
		fireEvent.click(block("Midday Report"));
		expect(onRowClick).toHaveBeenCalledTimes(1);

		const before = block("Midday Report").style.background;
		fireEvent.mouseEnter(block("Midday Report"));
		expect(block("Midday Report").style.background).toBe(before);
	});

	it("shades the picked, current, past and upcoming programmes differently", () => {
		render(
			<EpgTimelineBar
				programmes={programmes}
				now={now}
				windowStart={windowStart}
				windowEnd={windowEnd}
				onSelect={vi.fn()}
				selected={film}
			/>
		);
		const shades = [morning, midday, film, flash].map((p) => block(p.title).style.background);
		expect(shades.every(Boolean)).toBe(true);
		expect(new Set(shades).size).toBe(4);
	});

	it("matches the picked programme by its channel as well as its start", () => {
		const { rerender } = render(
			<EpgTimelineBar
				programmes={programmes}
				now={now}
				windowStart={windowStart}
				windowEnd={windowEnd}
				onSelect={vi.fn()}
				selected={null}
			/>
		);
		const unpicked = block("Afternoon Film").style.background;

		rerender(
			<EpgTimelineBar
				programmes={programmes}
				now={now}
				windowStart={windowStart}
				windowEnd={windowEnd}
				onSelect={vi.fn()}
				selected={{ ...film, channelId: "other.channel" }}
			/>
		);
		expect(block("Afternoon Film").style.background).toBe(unpicked);
	});

	it("lights up a programme under the pointer and restores it after", () => {
		render(
			<EpgTimelineBar
				programmes={programmes}
				now={now}
				windowStart={windowStart}
				windowEnd={windowEnd}
				onSelect={vi.fn()}
			/>
		);
		const target = block("Midday Report");
		const resting = target.style.background;

		fireEvent.mouseEnter(target);
		expect(target.style.background).not.toBe(resting);

		fireEvent.mouseLeave(target);
		expect(target.style.background).toBe(resting);
	});
});
