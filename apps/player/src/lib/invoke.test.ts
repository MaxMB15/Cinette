// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, afterEach } from "vitest";

const tauriInvoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriInvoke }));

import { invoke, setInvokeListener } from "./invoke";

afterEach(() => {
	setInvokeListener(null);
	vi.unstubAllEnvs();
	tauriInvoke.mockReset();
});

describe("invoke", () => {
	it("sends the call on as it was made and returns the answer", async () => {
		tauriInvoke.mockResolvedValue("answer");
		await expect(invoke("get_providers", { a: 1 }, { headers: {} })).resolves.toBe("answer");
		await invoke("get_all_channels");
		expect(tauriInvoke.mock.calls).toStrictEqual([
			["get_providers", { a: 1 }, { headers: {} }],
			["get_all_channels"],
		]);
	});

	it("tells the listener each command's name before sending it", async () => {
		const seen: string[] = [];
		tauriInvoke.mockImplementation(async () => {
			seen.push("sent");
		});
		setInvokeListener((cmd) => seen.push(cmd));
		await invoke("get_providers", { a: 1 });
		await invoke("plugin:mpv|mpv_stop");
		expect(seen).toEqual(["get_providers", "sent", "plugin:mpv|mpv_stop", "sent"]);
	});

	it("works with no listener, and stops telling one that was cleared", async () => {
		tauriInvoke.mockResolvedValue([]);
		const heard = vi.fn();
		setInvokeListener(heard);
		setInvokeListener(null);
		await expect(invoke("get_providers")).resolves.toEqual([]);
		expect(heard).not.toHaveBeenCalled();
		expect(tauriInvoke).toHaveBeenCalledTimes(1);
	});

	it("never tells the listener outside a dev build", async () => {
		vi.stubEnv("DEV", false);
		tauriInvoke.mockResolvedValue(null);
		const heard = vi.fn();
		setInvokeListener(heard);
		await invoke("get_providers");
		expect(heard).not.toHaveBeenCalled();
		expect(tauriInvoke).toHaveBeenCalledWith("get_providers");
	});
});
