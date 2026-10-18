// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./tauri", () => ({
	getProviders: vi.fn(async () => [{ id: "p1" }]),
	getAllChannels: vi.fn(async () => [{ id: "c1" }]),
	getGroupHierarchy: vi.fn(async () => [{ groupName: "News" }]),
	getPinnedGroups: vi.fn(async () => [{ groupName: "Sport" }]),
}));

import { getAllChannels, getGroupHierarchy, getPinnedGroups, getProviders } from "./tauri";
import {
	channelsQuery,
	groupHierarchyQuery,
	LOCAL,
	pinnedGroupsQuery,
	providersQuery,
} from "./queries";
import { createTestQueryClient } from "@/test/query";

beforeEach(() => vi.clearAllMocks());

describe("queries", () => {
	it("start each key with where the data comes from", () => {
		expect(LOCAL).toBe("local");
		expect(providersQuery().queryKey).toEqual(["local", "providers"]);
		expect(channelsQuery().queryKey).toEqual(["local", "channels"]);
		expect(providersQuery(LOCAL).queryKey).toEqual(providersQuery().queryKey);
		expect(groupHierarchyQuery("p1", "movie").queryKey).toEqual([
			"local",
			"groupHierarchy",
			"p1",
			"movie",
		]);
		expect(pinnedGroupsQuery("p1", "live").queryKey).toEqual([
			"local",
			"pinnedGroups",
			"p1",
			"live",
		]);
		expect(groupHierarchyQuery("p1", "movie", LOCAL).queryKey).toEqual(
			groupHierarchyQuery("p1", "movie").queryKey
		);
		expect(pinnedGroupsQuery("p1", "live", LOCAL).queryKey).toEqual(
			pinnedGroupsQuery("p1", "live").queryKey
		);
	});

	it("ask the backend for one provider's groups of one type", async () => {
		const client = createTestQueryClient();
		await expect(client.fetchQuery(groupHierarchyQuery("p1", "movie"))).resolves.toEqual([
			{ groupName: "News" },
		]);
		expect(getGroupHierarchy).toHaveBeenCalledExactlyOnceWith("p1", "movie");
		await expect(client.fetchQuery(pinnedGroupsQuery("p2", "live"))).resolves.toEqual([
			{ groupName: "Sport" },
		]);
		expect(getPinnedGroups).toHaveBeenCalledExactlyOnceWith("p2", "live");
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
