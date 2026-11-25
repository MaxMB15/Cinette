// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";
import { renderHook } from "@testing-library/react";

// What useNavigate gives, which react-router changes when the route does.
const router = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("react-router", () => ({ useNavigate: () => router.navigate }));

import { LibraryProvider, useLibrarySource, usePlay, useRemoteLibrary } from "./useLibrary";
import { LOCAL, remoteSource } from "@/lib/library";
import type { Channel } from "@/lib/types";

const state = { url: "u", channelName: "News", channel: { id: "c1" } as Channel };

beforeEach(() => {
	router.navigate = vi.fn();
});

describe("useLibrary", () => {
	it("shows this device's library and plays on its player page by default", () => {
		const { result } = renderHook(() => ({
			source: useLibrarySource(),
			remote: useRemoteLibrary(),
			play: usePlay(),
		}));
		expect(result.current.source).toBe(LOCAL);
		expect(result.current.remote).toBe(false);
		result.current.play(state);
		expect(router.navigate).toHaveBeenCalledExactlyOnceWith("/player", { state });
	});

	it("opens the player page with the navigate of the latest render", () => {
		const { result, rerender } = renderHook(() => usePlay());
		const first = router.navigate;
		router.navigate = vi.fn();
		rerender();
		result.current(state);
		expect(router.navigate).toHaveBeenCalledExactlyOnceWith("/player", { state });
		expect(first).not.toHaveBeenCalled();
	});

	it("shows the library and plays the way a provider says", () => {
		const play = vi.fn();
		const wrapper = ({ children }: { children: ReactNode }) => (
			<LibraryProvider value={{ source: remoteSource(2), play }}>{children}</LibraryProvider>
		);
		const { result } = renderHook(
			() => ({ source: useLibrarySource(), remote: useRemoteLibrary(), play: usePlay() }),
			{ wrapper }
		);
		expect(result.current.source).toBe("remote:2");
		expect(result.current.remote).toBe(true);
		result.current.play(state);
		expect(play).toHaveBeenCalledExactlyOnceWith(state);
		expect(router.navigate).not.toHaveBeenCalled();
	});
});
