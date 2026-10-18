// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { OmdbData, WhatsonData } from "@/lib/types";

vi.mock("@/lib/tauri", () => ({
	fetchOmdbData: vi.fn(),
	fetchWhatsonData: vi.fn(),
	getOmdbApiKey: vi.fn(),
}));

import { fetchOmdbData, fetchWhatsonData, getOmdbApiKey } from "@/lib/tauri";
import { rememberHasOmdbKey } from "./useHasOmdbKey";
import {
	useCachedMediaDetails,
	useMediaDetails,
	useSheetDetails,
	type MediaDetailsRequest,
} from "./useMediaDetails";
import { wrapperFor } from "@/test/query";

const mockOmdb = vi.mocked(fetchOmdbData);
const mockWhatson = vi.mocked(fetchWhatsonData);

const sintel: MediaDetailsRequest = { id: "mv1", title: "Sintel", kind: "movie" };
const tears: MediaDetailsRequest = { id: "mv2", title: "Tears of Steel", kind: "movie" };
const sintelOmdb = { title: "Sintel", imdbId: "tt1727587" } as OmdbData;
const tearsOmdb = { title: "Tears of Steel" } as OmdbData;
const certified = { certification: "12A" } as WhatsonData;

/** A promise the test settles by hand. */
const deferred = <T>() => {
	let resolve: (value: T) => void = () => {};
	let reject: (reason: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
};

// The player loads with useMediaDetails, and the sheets through the cache.
// Both answer the same way.
describe.each([
	{ name: "useMediaDetails", useDetails: useMediaDetails, cached: false },
	{ name: "useCachedMediaDetails", useDetails: useCachedMediaDetails, cached: true },
])("$name", ({ useDetails, cached }) => {
	const renderDetails: typeof renderHook = (hook, options) =>
		renderHook(hook, { ...options, wrapper: cached ? wrapperFor() : undefined });

	beforeEach(() => {
		vi.clearAllMocks();
		mockWhatson.mockResolvedValue(null);
	});

	it("loads nothing for a null request", () => {
		const { result } = renderDetails(() => useDetails(null));
		expect(result.current).toEqual({ omdbData: null, whatsonData: null, loading: false });
		expect(mockOmdb).not.toHaveBeenCalled();
	});

	it("gives OMDb's details, then Whatson's for the IMDb id", async () => {
		const whatson = deferred<WhatsonData | null>();
		mockOmdb.mockResolvedValue(sintelOmdb);
		mockWhatson.mockReturnValue(whatson.promise);
		const { result } = renderDetails(() => useDetails(sintel));
		expect(result.current.loading).toBe(true);

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.omdbData).toBe(sintelOmdb);
		expect(result.current.whatsonData).toBeNull();
		expect(mockOmdb).toHaveBeenCalledExactlyOnceWith("mv1", "Sintel", "movie");
		expect(mockWhatson).toHaveBeenCalledExactlyOnceWith("tt1727587", "movie");

		await act(async () => whatson.resolve(certified));
		expect(result.current.whatsonData).toBe(certified);
	});

	it("looks a series up on Whatson as a show", async () => {
		mockOmdb.mockResolvedValue(sintelOmdb);
		renderDetails(() => useDetails({ ...sintel, kind: "series" }));
		await waitFor(() => expect(mockWhatson).toHaveBeenCalledWith("tt1727587", "show"));
		expect(mockOmdb).toHaveBeenCalledWith("mv1", "Sintel", "series");
	});

	it("skips Whatson when OMDb has no IMDb id", async () => {
		mockOmdb.mockResolvedValue(tearsOmdb);
		const { result } = renderDetails(() => useDetails(tears));
		await waitFor(() => expect(result.current.omdbData).toBe(tearsOmdb));
		expect(mockWhatson).not.toHaveBeenCalled();
	});

	it("stops loading with no details when OMDb fails", async () => {
		mockOmdb.mockRejectedValue(new Error("offline"));
		const { result } = renderDetails(() => useDetails(sintel));
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.omdbData).toBeNull();
	});

	it("starts a new request empty and drops a late answer for the old one", async () => {
		const first = deferred<OmdbData | null>();
		const second = deferred<OmdbData | null>();
		mockOmdb.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		const { result, rerender } = renderDetails(({ request }) => useDetails(request), {
			initialProps: { request: sintel },
		});

		rerender({ request: tears });
		expect(result.current).toEqual({ omdbData: null, whatsonData: null, loading: true });

		await act(async () => first.resolve(sintelOmdb));
		expect(result.current.loading).toBe(true);
		expect(mockWhatson).not.toHaveBeenCalled();

		await act(async () => second.resolve(tearsOmdb));
		expect(result.current).toEqual({ omdbData: tearsOmdb, whatsonData: null, loading: false });
	});

	it("doesn't show the last item's details on the render that switches", async () => {
		mockOmdb.mockResolvedValueOnce(sintelOmdb).mockReturnValueOnce(new Promise(() => {}));
		const seen: (OmdbData | null)[] = [];
		const { result, rerender } = renderDetails(
			({ request }) => {
				const details = useDetails(request);
				seen.push(details.omdbData);
				return details;
			},
			{ initialProps: { request: sintel } }
		);
		await waitFor(() => expect(result.current.omdbData).toBe(sintelOmdb));

		seen.length = 0;
		rerender({ request: tears });
		expect(seen).not.toContain(sintelOmdb);
	});

	it("doesn't load again for an equal request in a new object", async () => {
		mockOmdb.mockResolvedValue(sintelOmdb);
		const { result, rerender } = renderDetails(({ request }) => useDetails(request), {
			initialProps: { request: { ...sintel } },
		});
		await waitFor(() => expect(result.current.loading).toBe(false));
		rerender({ request: { ...sintel } });
		expect(result.current.omdbData).toBe(sintelOmdb);
		expect(mockOmdb).toHaveBeenCalledOnce();
	});
});

describe("useCachedMediaDetails", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockWhatson.mockResolvedValue(certified);
	});

	it("shows a movie opened again from the cache, without asking again", async () => {
		mockOmdb.mockResolvedValue(sintelOmdb);
		const wrapper = wrapperFor();
		const first = renderHook(() => useCachedMediaDetails(sintel), { wrapper });
		await waitFor(() => expect(first.result.current.whatsonData).toBe(certified));
		first.unmount();

		const again = renderHook(() => useCachedMediaDetails(sintel), { wrapper });
		expect(again.result.current).toEqual({
			omdbData: sintelOmdb,
			whatsonData: certified,
			loading: false,
		});
		expect(mockOmdb).toHaveBeenCalledOnce();
		expect(mockWhatson).toHaveBeenCalledOnce();
	});

	it("keeps no Whatson ratings for a movie OMDb has no IMDb id for", async () => {
		mockOmdb.mockResolvedValue(tearsOmdb);
		const { result } = renderHook(() => useCachedMediaDetails(tears), {
			wrapper: wrapperFor(),
		});
		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.whatsonData).toBeNull();
	});
});

describe("useSheetDetails", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		rememberHasOmdbKey(true);
		vi.mocked(getOmdbApiKey).mockResolvedValue("set");
		mockWhatson.mockResolvedValue(null);
	});

	it("shows what the player loaded without loading it again", () => {
		const { result } = renderHook(() => useSheetDetails(sintel, sintelOmdb, certified), {
			wrapper: wrapperFor(),
		});
		expect(result.current).toMatchObject({
			omdbData: sintelOmdb,
			whatsonData: certified,
			omdbLoading: false,
			infoLoading: false,
		});
		expect(mockOmdb).not.toHaveBeenCalled();
	});

	it("takes the player's details once they arrive, over its own load", async () => {
		mockOmdb.mockReturnValue(new Promise(() => {}));
		const { result, rerender } = renderHook(
			({ prefetched }: { prefetched?: OmdbData | null }) =>
				useSheetDetails(sintel, prefetched, undefined),
			{ initialProps: {}, wrapper: wrapperFor() }
		);
		expect(result.current.omdbLoading).toBe(true);
		expect(mockOmdb).toHaveBeenCalledOnce();

		rerender({ prefetched: sintelOmdb });
		expect(result.current).toMatchObject({
			omdbData: sintelOmdb,
			whatsonData: null,
			omdbLoading: false,
		});
	});

	it("loads nothing without an item to look up", () => {
		const { result } = renderHook(() => useSheetDetails(null, undefined, undefined), {
			wrapper: wrapperFor(),
		});
		expect(result.current.omdbLoading).toBe(false);
		expect(mockOmdb).not.toHaveBeenCalled();
	});
});
