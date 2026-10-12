// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { ChannelCard } from "./ChannelCard";
import type { Channel, EpgProgram } from "@/lib/types";
import { nowSeconds } from "@/lib/date";

vi.mock("@/hooks/useDownloads", () => ({
	useDownloads: () => ({ byChannel: new Map(), bySeries: new Map() }),
	aggregateForSeries: () => "none",
}));

const channel: Channel = {
	id: "ch1",
	name: "News 24",
	url: "http://example.test/news.ts",
	groupTitle: "News",
	isFavorite: false,
	contentType: "live",
	sources: [],
};

const now = nowSeconds();
const programme = (title: string, start: number, end: number): EpgProgram => ({
	channelId: "news24",
	title,
	startTime: now + start,
	endTime: now + end,
});

describe("ChannelCard compact variant", () => {
	afterEach(cleanup);

	it("shows the programme on now and not the ones around it", () => {
		render(
			<ChannelCard
				channel={channel}
				onPlay={vi.fn()}
				variant="compact"
				epgPrograms={[
					programme("Morning Show", -7200, -1800),
					programme("Midday Report", -1800, 1800),
					programme("Evening News", 1800, 5400),
				]}
			/>
		);
		expect(screen.getByText("Midday Report")).toBeDefined();
		expect(screen.queryByText("Morning Show")).toBeNull();
		expect(screen.queryByText("Evening News")).toBeNull();
	});

	it("shows the group when there's no guide data", () => {
		render(<ChannelCard channel={channel} onPlay={vi.fn()} variant="compact" />);
		expect(screen.getByText("News")).toBeDefined();
	});

	it("toggles the favorite without starting playback", () => {
		const onPlay = vi.fn();
		const onToggleFavorite = vi.fn();
		render(
			<ChannelCard
				channel={channel}
				onPlay={onPlay}
				variant="compact"
				onToggleFavorite={onToggleFavorite}
			/>
		);
		fireEvent.click(screen.getByLabelText("Add to favorites"));
		expect(onToggleFavorite).toHaveBeenCalledWith(channel);
		expect(onPlay).not.toHaveBeenCalled();

		fireEvent.click(screen.getByText("News 24"));
		expect(onPlay).toHaveBeenCalledWith(channel);
	});

	it("keeps the play and favorite buttons apart for VoiceOver", () => {
		render(
			<ChannelCard
				channel={channel}
				onPlay={vi.fn()}
				variant="compact"
				onToggleFavorite={vi.fn()}
			/>
		);
		const play = screen.getByRole("button", { name: /News 24/ });
		const favorite = screen.getByRole("button", { name: "Add to favorites" });
		expect(play.contains(favorite)).toBe(false);
		expect(favorite.contains(play)).toBe(false);
	});
});

describe("ChannelCard poster variant", () => {
	afterEach(cleanup);

	const movie: Channel = { ...channel, id: "mv1", name: "The Film", contentType: "movie" };

	it("keeps the favorite button out of the play button", () => {
		render(
			<ChannelCard
				channel={movie}
				onPlay={vi.fn()}
				variant="poster"
				onToggleFavorite={vi.fn()}
			/>
		);
		const play = screen.getByRole("button", { name: /The Film/ });
		const favorite = screen.getByRole("button", { name: "Add to favorites" });
		expect(favorite.tagName).toBe("BUTTON");
		expect(play.contains(favorite)).toBe(false);
	});

	it("toggles the favorite without starting playback", () => {
		const onPlay = vi.fn();
		const onToggleFavorite = vi.fn();
		render(
			<ChannelCard
				channel={movie}
				onPlay={onPlay}
				variant="poster"
				onToggleFavorite={onToggleFavorite}
			/>
		);
		fireEvent.click(screen.getByRole("button", { name: "Add to favorites" }));
		expect(onToggleFavorite).toHaveBeenCalledWith(movie);
		expect(onPlay).not.toHaveBeenCalled();
	});
});

describe("ChannelCard row variant", () => {
	afterEach(cleanup);

	it("toggles the favorite without starting playback", () => {
		const onPlay = vi.fn();
		const onToggleFavorite = vi.fn();
		render(
			<ChannelCard channel={channel} onPlay={onPlay} onToggleFavorite={onToggleFavorite} />
		);
		fireEvent.click(screen.getByRole("button", { name: "Add to favorites" }));
		expect(onToggleFavorite).toHaveBeenCalledWith(channel);
		expect(onPlay).not.toHaveBeenCalled();
	});

	it("plays the channel once from its button", () => {
		const onPlay = vi.fn();
		render(<ChannelCard channel={channel} onPlay={onPlay} onToggleFavorite={vi.fn()} />);
		fireEvent.click(screen.getByRole("button", { name: /News 24/ }));
		expect(onPlay).toHaveBeenCalledExactlyOnceWith(channel);
	});

	it("plays the channel from a click on the timeline", () => {
		const onPlay = vi.fn();
		render(<ChannelCard channel={channel} onPlay={onPlay} onToggleFavorite={vi.fn()} />);
		fireEvent.click(screen.getByText("no epg"));
		expect(onPlay).toHaveBeenCalledWith(channel);
	});

	it("keeps the play and favorite buttons apart for screen readers", () => {
		render(<ChannelCard channel={channel} onPlay={vi.fn()} onToggleFavorite={vi.fn()} />);
		const play = screen.getByRole("button", { name: /News 24/ });
		const favorite = screen.getByRole("button", { name: "Add to favorites" });
		expect(play.tagName).toBe("BUTTON");
		expect(play.contains(favorite)).toBe(false);
		expect(favorite.contains(play)).toBe(false);
		expect(screen.getAllByRole("button")).toHaveLength(2);
	});
});
