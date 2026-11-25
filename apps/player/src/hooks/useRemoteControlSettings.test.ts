// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteSettings } from "@/lib/tauri";

vi.mock("@/lib/tauri", () => ({
	remoteGetSettings: vi.fn(),
	remoteSetSettings: vi.fn(),
	remoteResetIdentity: vi.fn(),
	remoteDisconnect: vi.fn(() => Promise.resolve()),
	remoteOpen: vi.fn(() => Promise.resolve()),
	remoteLocalNetworkDenied: vi.fn(() => Promise.resolve(false)),
	remoteUnblock: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/hooks/useRemoteTarget", () => ({
	useRemoteSessions: () => [],
	useRemoteBlocked: () => [],
}));

import { remoteGetSettings, remoteSetSettings } from "@/lib/tauri";
import { useRemoteControlSettings } from "./useRemoteControlSettings";

const settings: RemoteSettings = {
	discoverable: true,
	remoteControl: "ask",
	deviceName: "Living room",
	defaultName: "Android TV",
	deviceId: "abc",
};

/** The hook with the settings loaded, and the name field holding other text. */
const loaded = async () => {
	vi.mocked(remoteGetSettings).mockResolvedValue(settings);
	const { result } = renderHook(() => useRemoteControlSettings());
	await waitFor(() => expect(result.current.form).not.toBeNull());
	act(() => result.current.setName("In the field"));
	return result;
};

/** Says the name from the TV's keyboard, and waits for its save to finish. */
const saveName = async (result: Awaited<ReturnType<typeof loaded>>, text: string) => {
	await act(async () => result.current.saveName(text));
};

describe("useRemoteControlSettings saveName with text from the TV's keyboard", () => {
	beforeEach(() => {
		vi.mocked(remoteSetSettings).mockReset();
		vi.mocked(remoteSetSettings).mockImplementation(async (next) => ({ ...settings, ...next }));
	});

	it("saves that text rather than what's in the field, without the spaces around it", async () => {
		const result = await loaded();
		await saveName(result, "  Bedroom ");
		expect(remoteSetSettings).toHaveBeenCalledExactlyOnceWith({
			discoverable: true,
			remoteControl: "ask",
			deviceName: "Bedroom",
		});
	});

	it("saves nothing when the text is the name already saved", async () => {
		const result = await loaded();
		await saveName(result, "Living room");
		expect(remoteSetSettings).not.toHaveBeenCalled();
	});

	it("goes back to the default name when the text is blank", async () => {
		const result = await loaded();
		await saveName(result, "   ");
		expect(remoteSetSettings).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ deviceName: null })
		);
	});
});
