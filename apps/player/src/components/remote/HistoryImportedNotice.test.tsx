// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import type { Channel } from "@/lib/types";
import type { RemoteHistoryImported } from "@/lib/tauri";

const events = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
vi.mock("@/hooks/useRemoteTarget", () => ({
	useTauriEvent: (event: string, handler: (payload: unknown) => void) => {
		events.set(event, handler);
	},
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/lib/tauri", () => ({ mpvStop: vi.fn(() => Promise.resolve()) }));
const target = vi.hoisted(() => ({ load: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/remote-target", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/remote-target")>()),
	getMountedPlayer: () => null,
	waitForMountedPlayer: () => Promise.resolve({ load: target.load }),
}));

import { createTestQueryClient, wrapperFor } from "@/test/query";
import { HistoryImportedNotice } from "./HistoryImportedNotice";

const heat: Channel = {
	id: "xt-tv-movie-8",
	name: "Heat",
	url: "http://panel.example/movie/8.mkv",
	groupTitle: "Films",
	isFavorite: false,
	contentType: "movie",
	sources: [],
} as unknown as Channel;

const tally = { added: 1, updated: 0, unchanged: 0 };
const imported = (extra: Partial<RemoteHistoryImported> = {}): RemoteHistoryImported => ({
	from: "Mac",
	report: {
		history: tally,
		positions: tally,
		favorites: tally,
		pins: tally,
		unmatched: [],
		unmatchedTotal: 0,
		resume: { channelId: heat.id, name: "Heat", position: 1234 },
	},
	channel: heat,
	...extra,
});

const show = (event: RemoteHistoryImported) =>
	act(() => events.get("remote://history-imported")!(event));

beforeEach(() => {
	navigate.mockClear();
	target.load.mockClear();
});

describe("HistoryImportedNotice", () => {
	it("says where the history came from and loads the lists again", () => {
		const client = createTestQueryClient();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		render(<HistoryImportedNotice />, { wrapper: wrapperFor(client) });
		expect(screen.queryByRole("status")).toBeNull();
		show(imported());
		expect(screen.getByRole("status")).toHaveTextContent("Added history from Mac.");
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["local", "history"] });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["local", "channels"] });
		expect(invalidate).toHaveBeenCalledWith({ queryKey: ["local", "pinnedGroups"] });
		expect(target.load, "nothing plays by itself").not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("continues the other device's item here at its place", async () => {
		render(<HistoryImportedNotice />, { wrapper: wrapperFor() });
		show(imported());
		fireEvent.click(screen.getByRole("button", { name: "Continue watching Heat" }));
		await waitFor(() =>
			expect(target.load).toHaveBeenCalledWith(
				{ kind: "local", channel: heat },
				{ startAt: 1234 }
			)
		);
		expect(navigate).toHaveBeenCalledWith("/player");
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("offers nothing to continue without a match, and names an unnamed device", () => {
		render(<HistoryImportedNotice />, { wrapper: wrapperFor() });
		show(imported({ from: "", channel: undefined }));
		expect(screen.getByRole("status")).toHaveTextContent("Added history from another device.");
		expect(screen.queryByRole("button", { name: /Continue watching/ })).toBeNull();
	});
});
