// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./tauri", () => ({
	getProviders: vi.fn(async () => [{ id: "p1" }]),
	getAllChannels: vi.fn(async () => [{ id: "c1" }]),
}));

import { getAllChannels, getProviders } from "./tauri";
import { channelsQuery, LOCAL, providersQuery } from "./queries";
import { createTestQueryClient } from "@/test/query";

beforeEach(() => vi.clearAllMocks());

describe("queries", () => {
	it("start each key with where the data comes from", () => {
		expect(LOCAL).toBe("local");
		expect(providersQuery().queryKey).toEqual(["local", "providers"]);
		expect(channelsQuery().queryKey).toEqual(["local", "channels"]);
		expect(providersQuery(LOCAL).queryKey).toEqual(providersQuery().queryKey);
	});

	it("ask the backend for the providers", async () => {
		const client = createTestQueryClient();
		await expect(client.fetchQuery(providersQuery())).resolves.toEqual([{ id: "p1" }]);
		expect(getProviders).toHaveBeenCalledTimes(1);
		expect(getProviders).toHaveBeenCalledWith();
		expect(getAllChannels).not.toHaveBeenCalled();
	});

	it("ask the backend for the channels", async () => {
		const client = createTestQueryClient();
		await expect(client.fetchQuery(channelsQuery())).resolves.toEqual([{ id: "c1" }]);
		expect(getAllChannels).toHaveBeenCalledTimes(1);
		expect(getAllChannels).toHaveBeenCalledWith();
		expect(getProviders).not.toHaveBeenCalled();
	});
});
