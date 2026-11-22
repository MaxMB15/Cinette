// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useChannels } from "@/hooks/useChannels";
import { useNowNext } from "@/hooks/useNowNext";
import type { Channel } from "@/lib/types";
import { makeChannel } from "@/test/channel-fixtures";
import { makeProgramme } from "@/test/detail-fixtures";
import { TvLiveInfo } from "./TvLiveInfo";

vi.mock("@/hooks/useChannels", () => ({ useChannels: vi.fn() }));
vi.mock("@/hooks/useNowNext", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks/useNowNext")>()),
	useNowNext: vi.fn(),
}));

const NOW = 1_800_000_000;
const NEWS = makeChannel({ id: "n", name: "News", tvgId: "news.uk" });
const HEADLINES = makeProgramme("Headlines", NOW - 60, NOW + 60);

const toggleFavorite = vi.fn();
const scheduleOf = vi.fn();

const channelsAre = (channels: Channel[]) =>
	vi
		.mocked(useChannels)
		.mockReturnValue({ channels, toggleFavorite } as unknown as ReturnType<typeof useChannels>);

describe("TvLiveInfo", () => {
	beforeEach(() => {
		channelsAre([NEWS]);
		scheduleOf.mockReturnValue([HEADLINES]);
		vi.mocked(useNowNext).mockReturnValue({
			now: NOW,
			programsOf: () => [],
			nowNextOf: () => ({ now: null, next: null }),
			scheduleOf,
		});
	});

	afterEach(() => {
		cleanup();
		toggleFavorite.mockClear();
		scheduleOf.mockReset();
	});

	it("names the channel being watched and shows what's on it", () => {
		render(<TvLiveInfo channel={NEWS} onClose={() => {}} />);
		expect(screen.getByRole("dialog", { name: "News" })).toBeInTheDocument();
		expect(screen.getByRole("heading", { name: "News" })).toBeInTheDocument();
		expect(screen.getByText("Headlines")).toBeInTheDocument();
		expect(scheduleOf).toHaveBeenCalledWith(NEWS);
	});

	it("fits the info under the panel's title", () => {
		render(<TvLiveInfo channel={NEWS} onClose={() => {}} />);
		expect(screen.getByRole("complementary").style.height).toBe("30rem");
	});

	it("shows the favorite as it is now, not as it was when the channel started", () => {
		channelsAre([makeChannel({ id: "other" }), { ...NEWS, isFavorite: true }]);
		render(<TvLiveInfo channel={NEWS} onClose={() => {}} />);
		expect(screen.getByRole("button", { name: "Remove from favorites" })).toBeInTheDocument();
	});

	it("goes by the channel it was given when the list no longer has it", () => {
		channelsAre([]);
		render(<TvLiveInfo channel={{ ...NEWS, isFavorite: true }} onClose={() => {}} />);
		expect(screen.getByRole("button", { name: "Remove from favorites" })).toBeInTheDocument();
	});

	it("doesn't take the favorite from a different channel", () => {
		channelsAre([makeChannel({ id: "other", isFavorite: true })]);
		render(<TvLiveInfo channel={NEWS} onClose={() => {}} />);
		expect(screen.getByRole("button", { name: "Add to favorites" })).toBeInTheDocument();
	});

	it("favorites the channel being watched", () => {
		render(<TvLiveInfo channel={NEWS} onClose={() => {}} />);
		fireEvent.click(screen.getByRole("button", { name: "Add to favorites" }));
		expect(toggleFavorite).toHaveBeenCalledExactlyOnceWith("n");
	});

	it("takes the focus and closes on Back", () => {
		const onClose = vi.fn();
		render(<TvLiveInfo channel={NEWS} onClose={onClose} />);
		const button = screen.getByRole("button", { name: "Add to favorites" });
		expect(document.activeElement).toBe(button);
		fireEvent.keyDown(button, { key: "Escape" });
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});
