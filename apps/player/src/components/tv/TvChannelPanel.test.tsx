// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { NowNext } from "@/hooks/useNowNext";
import type { Channel } from "@/lib/types";
import { makeChannel } from "@/test/channel-fixtures";
import { TvChannelPanel } from "./TvChannelPanel";

const guide = vi.hoisted(() => ({
	of: vi.fn<(channel: Channel) => NowNext>(),
}));

vi.mock("@/hooks/useNowNext", () => ({
	useNowNext: () => ({ nowNextOf: guide.of }),
}));

const news = makeChannel({ id: "news", name: "News" });
const sports = makeChannel({ id: "sports", name: "Sports" });
const music = makeChannel({ id: "music", name: "Music" });
const CHANNELS = [news, sports, music];

const renderPanel = (currentId = "sports") => {
	const handlers = { onPlay: vi.fn(), onClose: vi.fn() };
	render(<TvChannelPanel channels={CHANNELS} currentId={currentId} {...handlers} />);
	return handlers;
};

const cursor = () => screen.getByRole("option", { selected: true });

describe("TvChannelPanel", () => {
	beforeEach(() => {
		guide.of.mockReturnValue({ now: null, next: null });
	});

	it("names the panel and its list, and sits on the left", () => {
		renderPanel();
		const panel = screen.getByRole("dialog", { name: "Channels" });
		expect(panel.parentElement).toHaveClass("justify-start");
		expect(screen.getByRole("heading", { name: "Channels" })).toBeInTheDocument();
		expect(screen.getByRole("listbox", { name: "Channels" })).toBeInTheDocument();
	});

	it("opens with the cursor and the focus on the channel on screen", () => {
		renderPanel();
		expect(cursor()).toHaveTextContent("Sports");
		expect(cursor()).toHaveFocus();
	});

	it("starts at the first channel when the one on screen isn't in the list", () => {
		renderPanel("elsewhere");
		expect(cursor()).toHaveTextContent("News");
	});

	it("shows what's on each channel from the guide", () => {
		guide.of.mockImplementation((channel) => ({
			now:
				channel.id === "news"
					? { channelId: "news", title: "Evening Report", startTime: 0, endTime: 1 }
					: null,
			next: null,
		}));
		renderPanel();
		expect(
			within(screen.getByRole("option", { name: /News/ })).getByText("Evening Report")
		).toBeInTheDocument();
		expect(screen.getByRole("option", { name: /Sports/ })).toHaveTextContent(/^SSports$/);
	});

	it("moves the cursor with the D-pad, and OK plays the channel under it", () => {
		const { onPlay } = renderPanel();
		fireEvent.keyDown(cursor(), { key: "ArrowUp" });
		expect(cursor()).toHaveTextContent("News");
		expect(cursor()).toHaveFocus();
		fireEvent.keyDown(cursor(), { key: "Enter" });
		expect(onPlay).toHaveBeenCalledTimes(1);
		expect(onPlay.mock.calls[0][0]).toBe(news);
	});

	it("keeps a row's element when the channels change order", () => {
		const handlers = { onPlay: vi.fn(), onClose: vi.fn() };
		const { rerender } = render(
			<TvChannelPanel channels={[news, sports]} currentId="news" {...handlers} />
		);
		const row = screen.getByRole("option", { name: /News/ });
		rerender(<TvChannelPanel channels={[sports, news]} currentId="news" {...handlers} />);
		expect(screen.getByRole("option", { name: /News/ })).toBe(row);
	});

	it("shows nine channels at a time, with one more ready below", () => {
		const many = Array.from({ length: 15 }, (_, i) =>
			makeChannel({ id: `channel-${i}`, name: `Channel ${i}` })
		);
		render(
			<TvChannelPanel
				channels={many}
				currentId="channel-0"
				onPlay={vi.fn()}
				onClose={vi.fn()}
			/>
		);
		expect(screen.getAllByRole("option")).toHaveLength(10);
	});

	it("closes on Back without playing", () => {
		const { onClose, onPlay } = renderPanel();
		fireEvent.keyDown(cursor(), { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onPlay).not.toHaveBeenCalled();
	});
});
