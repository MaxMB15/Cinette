// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import type { EventCallback } from "@tauri-apps/api/event";

const handlers = vi.hoisted(() => new Map<string, EventCallback<unknown>>());
const stops = vi.hoisted(() => [] as ReturnType<typeof vi.fn>[]);
vi.mock("@tauri-apps/api/event", () => ({
	listen: vi.fn((event: string, handler: EventCallback<unknown>) => {
		handlers.set(event, handler);
		const stop = vi.fn();
		stops.push(stop);
		return Promise.resolve(stop);
	}),
}));

vi.mock("@/lib/tauri", () => ({
	remoteDevices: vi.fn(() => Promise.resolve([])),
	remoteConnect: vi.fn(() => Promise.resolve()),
	remoteLeave: vi.fn(() => Promise.resolve()),
	remoteCommand: vi.fn(() => Promise.resolve(4)),
}));

import { listen } from "@tauri-apps/api/event";
import { remoteCommand, remoteConnect, remoteLeave } from "@/lib/tauri";
import { remoteControl, useRemoteControl } from "./useRemoteControl";

const tv = {
	deviceId: "tv1",
	name: "Living Room",
	deviceType: "fire-tv",
	controlAllowed: true,
	available: true,
};

beforeEach(() => {
	handlers.clear();
	stops.length = 0;
	vi.clearAllMocks();
});

describe("useRemoteControl", () => {
	it("shares one store and follows events while used", async () => {
		expect(remoteControl()).toBe(remoteControl());
		const a = renderHook(() => useRemoteControl());
		const b = renderHook(() => useRemoteControl());
		await waitFor(() => expect(handlers.has("remote://devices")).toBe(true));
		expect(vi.mocked(listen)).toHaveBeenCalledTimes(3);
		act(() => handlers.get("remote://devices")!({ event: "", id: 0, payload: [tv] }));
		expect(a.result.current.devices).toStrictEqual([tv]);
		expect(b.result.current.devices).toStrictEqual([tv]);
		a.unmount();
		await act(async () => {});
		expect(stops.every((s) => s.mock.calls.length === 0)).toBe(true);
		b.unmount();
		await waitFor(() => expect(stops.every((s) => s.mock.calls.length === 1)).toBe(true));
	});

	it("connects and leaves through the backend", async () => {
		const { result, unmount } = renderHook(() => useRemoteControl());
		await act(() => result.current.connect(tv));
		expect(remoteConnect).toHaveBeenCalledWith("tv1");
		expect(result.current.link?.deviceId).toBe("tv1");
		act(() =>
			handlers.get("remote://state")!({
				event: "",
				id: 0,
				payload: {
					deviceId: "tv1",
					state: {
						epoch: "e",
						version: 1,
						state: {
							status: "paused",
							item: { id: "live-1", name: "News", contentType: "live", group: "" },
							position: 0,
							duration: 0,
							volume: 10,
							subtitles: [],
							subtitleId: null,
							audio: [],
							audioId: null,
							capabilities: {
								pause: true,
								seek: false,
								volume: true,
								subtitles: false,
								audioTracks: false,
								resumeAt: false,
							},
							error: null,
						},
					},
				},
			})
		);
		// When it arrived, by this page's clock.
		const at = result.current.link!.destination.getState().positionAt;
		expect(at).toBeGreaterThan(0);
		expect(at).toBeLessThanOrEqual(performance.now());
		await act(() => result.current.link!.destination.play());
		expect(remoteCommand).toHaveBeenCalledWith({ action: "play", itemId: "live-1" });
		await act(() => result.current.leave());
		expect(remoteLeave).toHaveBeenCalledTimes(1);
		expect(result.current.link).toBeNull();
		unmount();
	});

	it("keeps working when listening fails", async () => {
		vi.mocked(listen).mockRejectedValueOnce(new Error("no Tauri"));
		const { unmount } = renderHook(() => useRemoteControl());
		await act(async () => {});
		unmount();
		await act(async () => {});
	});
});
