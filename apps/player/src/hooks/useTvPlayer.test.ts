// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { KeyboardEvent } from "react";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setZapList } from "@/lib/tv-zap";
import { makeChannel } from "@/test/channel-fixtures";
import type { Channel } from "@/lib/types";
import { useTvPlayer, ZAP_DELAY_MS } from "./useTvPlayer";

const news = makeChannel({ id: "news" });
const sport = makeChannel({ id: "sport" });
const music = makeChannel({ id: "music" });
const cinema = makeChannel({ id: "cinema" });
const movie = makeChannel({ id: "movie", contentType: "movie" });
const live = [news, sport, music, cinema];

const setup = (channel: Channel | null, channels: readonly Channel[] = live) => {
	const handlers = {
		play: vi.fn<(channel: Channel) => void>(),
		onChannels: vi.fn(),
		onEpisode: vi.fn<(step: 1 | -1) => void>(),
		onInfo: vi.fn(),
		onStop: vi.fn(),
		onSeek: vi.fn<(step: 1 | -1) => void>(),
		onActivity: vi.fn(),
	};
	const view = renderHook(() => useTvPlayer({ channel, channels, ...handlers }));
	/** Presses `key`. Returns whether the hook took it and stopped the browser's own use of it. */
	const press = (key: string) => {
		const preventDefault = vi.fn();
		let taken = false;
		act(() => {
			taken = view.result.current.handleKey({
				key,
				preventDefault,
			} as unknown as KeyboardEvent);
		});
		expect(preventDefault).toHaveBeenCalledTimes(taken ? 1 : 0);
		return taken;
	};
	return { ...handlers, ...view, press };
};

const wait = (ms: number) => {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
};

beforeEach(() => {
	vi.useFakeTimers();
	setZapList([]);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("useTvPlayer zapping", () => {
	it("shows the next channel at once and loads it after a pause", () => {
		const { press, result, play } = setup(news);

		expect(press("ChannelDown")).toBe(true);
		expect(result.current.zapTarget).toBe(sport);
		wait(ZAP_DELAY_MS - 1);
		expect(play).not.toHaveBeenCalled();

		wait(1);
		expect(play).toHaveBeenCalledExactlyOnceWith(sport);
		expect(result.current.zapTarget).toBeNull();
	});

	it("shows the details of the channel it steps to", () => {
		const { press, result, onActivity } = setup(news);
		press("ChannelDown");
		expect(result.current.view).toBe("details");
		expect(onActivity).toHaveBeenCalledOnce();
	});

	it("keeps the view the buttons are in, and steps from them too", () => {
		const { result, onActivity, play } = setup(news);
		act(() => result.current.setView("controls"));
		act(() => result.current.zap(1));
		expect(result.current.view).toBe("controls");
		expect(result.current.zapTarget).toBe(sport);
		expect(onActivity).toHaveBeenCalledTimes(2);
		act(() => result.current.zap(-1));
		expect(result.current.zapTarget).toBe(news);
		wait(ZAP_DELAY_MS);
		expect(play).toHaveBeenCalledExactlyOnceWith(news);
	});

	it("waits about a third of a second", () => {
		expect(ZAP_DELAY_MS).toBe(350);
	});

	it("goes back a channel with Channel Up", () => {
		const { press, result } = setup(sport);
		press("ChannelUp");
		expect(result.current.zapTarget).toBe(news);
	});

	it("keeps stepping from the channel picked, and loads only the last one", () => {
		const { press, result, play } = setup(news);

		press("ChannelDown");
		wait(ZAP_DELAY_MS - 1);
		press("ChannelDown");
		expect(result.current.zapTarget).toBe(music);
		wait(ZAP_DELAY_MS - 1);
		expect(play).not.toHaveBeenCalled();

		wait(1);
		expect(play).toHaveBeenCalledExactlyOnceWith(music);
	});

	it("steps through the list the channel was picked from", () => {
		setZapList([news, cinema]);
		const { press, result } = setup(news);
		press("ChannelDown");
		expect(result.current.zapTarget).toBe(cinema);
	});

	it("takes the key but does nothing with no other channel to go to", () => {
		const { press, result, play } = setup(news, [news]);
		expect(press("ChannelDown")).toBe(true);
		expect(result.current.zapTarget).toBeNull();
		wait(ZAP_DELAY_MS);
		expect(play).not.toHaveBeenCalled();
	});

	it("keeps the wait going when the player renders again", () => {
		const { press, rerender, result, play } = setup(news);
		press("ChannelDown");
		rerender();
		expect(result.current.zapTarget).toBe(sport);
		wait(ZAP_DELAY_MS);
		expect(play).toHaveBeenCalledExactlyOnceWith(sport);
	});

	it("loads nothing once the player has gone", () => {
		const { press, unmount, play } = setup(news);
		press("ChannelDown");
		unmount();
		wait(ZAP_DELAY_MS);
		expect(play).not.toHaveBeenCalled();
	});

	it("plays a channel picked from the list right away, ahead of one waiting to load", () => {
		const { press, result, play } = setup(news);
		press("ChannelDown");

		act(() => result.current.playNow(cinema));
		expect(play).toHaveBeenCalledExactlyOnceWith(cinema);
		expect(result.current.zapTarget).toBeNull();

		wait(ZAP_DELAY_MS);
		expect(play).toHaveBeenCalledOnce();
	});

	it("plays a channel picked from the list with none waiting", () => {
		const { result, play } = setup(news);
		act(() => result.current.playNow(music));
		expect(play).toHaveBeenCalledExactlyOnceWith(music);
	});
});

describe("useTvPlayer keys", () => {
	it("leaves OK to the player's own shortcuts", () => {
		const { press, onChannels } = setup(news);
		expect(press("Enter")).toBe(false);
		expect(onChannels).not.toHaveBeenCalled();
	});

	it("opens the channel list with the Menu and Guide keys on live TV", () => {
		const { press, onChannels } = setup(news);
		expect(press("ContextMenu")).toBe(true);
		expect(press("Guide")).toBe(true);
		expect(onChannels).toHaveBeenCalledTimes(2);
	});

	it("leaves Left and Right to the player's own shortcuts on a movie", () => {
		const { press, onSeek, result } = setup(movie);
		expect(press("ArrowLeft")).toBe(false);
		expect(press("ArrowRight")).toBe(false);
		expect(onSeek).not.toHaveBeenCalled();
		expect(result.current.view).toBe("none");
	});

	it("moves through what's buffered with Left and Right on live TV", () => {
		const { press, onSeek, result } = setup(news);
		expect(press("ArrowLeft")).toBe(true);
		expect(onSeek).toHaveBeenLastCalledWith(-1);
		expect(press("ArrowRight")).toBe(true);
		expect(onSeek).toHaveBeenLastCalledWith(1);
		expect(result.current.view).toBe("none");
		expect(result.current.zapTarget).toBeNull();
	});

	it.each([news, movie, null])(
		"shows the controls with Down and the details with Up",
		(channel) => {
			const { press, result, onActivity, onChannels, onInfo } = setup(channel);
			expect(result.current.view).toBe("none");

			expect(press("ArrowDown")).toBe(true);
			expect(result.current.view).toBe("controls");
			expect(press("ArrowUp")).toBe(true);
			expect(result.current.view).toBe("details");
			expect(onActivity).toHaveBeenCalledTimes(2);
			expect(onChannels).not.toHaveBeenCalled();
			expect(onInfo).not.toHaveBeenCalled();
			expect(result.current.zapTarget).toBeNull();
		}
	);

	it("changes the view, and keeps the bar up for any view but none", () => {
		const { result, onActivity } = setup(movie);
		act(() => result.current.setView("tray"));
		expect(result.current.view).toBe("tray");
		expect(onActivity).toHaveBeenCalledOnce();

		act(() => result.current.setView("none"));
		expect(result.current.view).toBe("none");
		expect(onActivity).toHaveBeenCalledOnce();
	});

	it("changes the episode with the channel keys on a movie or episode", () => {
		const { press, onEpisode, result } = setup(movie);

		expect(press("ChannelUp")).toBe(true);
		expect(onEpisode).toHaveBeenLastCalledWith(-1);
		expect(press("ChannelDown")).toBe(true);
		expect(onEpisode).toHaveBeenLastCalledWith(1);
		expect(onEpisode).toHaveBeenCalledTimes(2);
		expect(result.current.view).toBe("none");
		expect(result.current.zapTarget).toBeNull();
	});

	it("opens the episodes and info with the Menu key on a movie or episode", () => {
		const { press, onInfo, onChannels } = setup(movie);
		expect(press("ContextMenu")).toBe(true);
		expect(onInfo).toHaveBeenCalledOnce();
		expect(onChannels).not.toHaveBeenCalled();
	});

	it("opens the info from the Info key", () => {
		const { press, onInfo, onStop } = setup(news);
		expect(press("Info")).toBe(true);
		expect(onInfo).toHaveBeenCalledOnce();
		expect(onStop).not.toHaveBeenCalled();
	});

	it("stops from the Stop key", () => {
		const { press, onStop, onInfo } = setup(movie);
		expect(press("MediaStop")).toBe(true);
		expect(onStop).toHaveBeenCalledOnce();
		expect(onInfo).not.toHaveBeenCalled();
	});

	it("does only what the key is for", () => {
		const { press, onChannels, onEpisode, onInfo, onStop, onSeek, play, result } = setup(news);
		press("Guide");
		wait(ZAP_DELAY_MS);
		expect(onChannels).toHaveBeenCalledOnce();
		expect(onEpisode).not.toHaveBeenCalled();
		expect(onInfo).not.toHaveBeenCalled();
		expect(onStop).not.toHaveBeenCalled();
		expect(onSeek).not.toHaveBeenCalled();
		expect(play).not.toHaveBeenCalled();
		expect(result.current.view).toBe("none");
	});

	it("leaves a key that isn't the TV's alone", () => {
		const { press } = setup(news);
		expect(press("a")).toBe(false);
	});
});
