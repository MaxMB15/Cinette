// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi } from "vitest";
import { createQueryClient } from "./query-client";

describe("createQueryClient", () => {
	it("keeps answers until the app loads them again, and never retries", () => {
		const { queries, mutations } = createQueryClient().getDefaultOptions();
		expect(queries).toEqual({
			staleTime: Infinity,
			retry: false,
			refetchOnWindowFocus: false,
			refetchOnReconnect: false,
		});
		expect(mutations).toEqual({ retry: false });
	});

	it("tries a failed call only once", async () => {
		const client = createQueryClient();
		const queryFn = vi.fn(async () => {
			throw new Error("locked");
		});
		await expect(client.fetchQuery({ queryKey: ["x"], queryFn })).rejects.toThrow("locked");
		expect(queryFn).toHaveBeenCalledTimes(1);
	});

	it("answers again from the cache without calling the backend", async () => {
		const client = createQueryClient();
		const queryFn = vi.fn(async () => 1);
		await client.fetchQuery({ queryKey: ["x"], queryFn });
		await client.fetchQuery({ queryKey: ["x"], queryFn });
		expect(queryFn).toHaveBeenCalledTimes(1);
	});

	it("gives each app its own cache", () => {
		expect(createQueryClient()).not.toBe(createQueryClient());
	});
});
