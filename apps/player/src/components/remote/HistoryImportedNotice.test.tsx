// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import type { Channel } from "@/lib/types";
import type { RemoteHistoryImported } from "@/lib/tauri";

const events = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
vi.mock("@/hooks/useRemoteTarget", () => ({
	useTauriEvent: (event: string, handler: (payload: unknown) => void) => {
		events.set(event, handler);
	},
}));
const os = vi.hoisted(() => ({ platform: "macos" }));
vi.mock("@/lib/platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/platform")>()),
	getPlatform: () => os.platform,
}));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router", () => ({ useNavigate: () => navigate }));
vi.mock("@/lib/tauri", () => ({
	mpvStop: vi.fn(() => Promise.resolve()),
	getPlaybackPosition: vi.fn(),
}));
const target = vi.hoisted(() => ({ load: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/remote-target", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/remote-target")>()),
	getMountedPlayer: () => null,
	waitForMountedPlayer: () => Promise.resolve({ load: target.load }),
}));

import { getPlaybackPosition } from "@/lib/tauri";
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

const saved = (positionSeconds: number, finished = false) => ({
	contentKey: "movie:heat",
	positionSeconds,
	durationSeconds: 7000,
	updatedAt: 1,
	finished,
});

beforeEach(() => {
	navigate.mockClear();
	target.load.mockClear();
	vi.mocked(getPlaybackPosition).mockReset().mockResolvedValue(saved(1234));
});

afterEach(() => {
	os.platform = "macos";
});

describe("HistoryImportedNotice", () => {
	it("brings a TV remote to Continue watching, and Back closes it", () => {
		os.platform = "tv";
		render(<HistoryImportedNotice />, { wrapper: wrapperFor() });
		show(imported());
		const resume = screen.getByRole("button", { name: /Continue watching/ });
		expect(resume).toHaveFocus();
		fireEvent.keyDown(resume, { key: "Escape" });
		expect(screen.queryByRole("status")).toBeNull();
		expect(target.load, "Back plays nothing").not.toHaveBeenCalled();
	});

	it("brings a TV remote to Dismiss when there's nothing to continue", () => {
		os.platform = "tv";
		render(<HistoryImportedNotice />, { wrapper: wrapperFor() });
		show(imported({ channel: undefined }));
		expect(screen.getByRole("button", { name: "Dismiss" })).toHaveFocus();
	});

	it("leaves the focus where it is off a TV", () => {
		render(<HistoryImportedNotice />, { wrapper: wrapperFor() });
		show(imported());
		expect(screen.getByRole("button", { name: /Continue watching/ })).not.toHaveFocus();
	});

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
		fireEvent.click(
			await screen.findByRole("button", { name: "Continue watching Heat at 20:34" })
		);
		await waitFor(() =>
			expect(target.load).toHaveBeenCalledWith(
				{ kind: "local", channel: heat },
				{ startAt: 1234 }
			)
		);
		expect(getPlaybackPosition).toHaveBeenCalledWith("movie:heat");
		expect(navigate).toHaveBeenCalledWith("/player");
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("names the place saved here, which may not be the one sent", async () => {
		vi.mocked(getPlaybackPosition).mockResolvedValue(saved(2000));
		render(<HistoryImportedNotice />, { wrapper: wrapperFor() });
		show(imported());
		expect(
			await screen.findByRole("button", { name: "Continue watching Heat at 33:20" })
		).toBeInTheDocument();
	});

	it("names no time when it was finished here, or for an import that was replaced", async () => {
		let answer: (p: ReturnType<typeof saved>) => void = () => {};
		vi.mocked(getPlaybackPosition)
			.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
			.mockResolvedValueOnce(saved(6990, true));
		render(<HistoryImportedNotice />, { wrapper: wrapperFor() });
		show(imported());
		show(imported({ from: "TV" }));
		await waitFor(() => expect(getPlaybackPosition).toHaveBeenCalledTimes(2));
		// The first one's answer comes last and is for an import no longer shown.
		await act(async () => answer(saved(900)));
		expect(screen.getByRole("status")).toHaveTextContent("Added history from TV.");
		expect(screen.getByRole("button", { name: /Continue watching Heat/ })).toHaveTextContent(
			/^Continue watching Heat$/
		);
	});

	it("starts from the place saved here when it's pressed", async () => {
		vi.mocked(getPlaybackPosition).mockResolvedValue(saved(2000));
		render(<HistoryImportedNotice />, { wrapper: wrapperFor() });
		show(imported());
		fireEvent.click(screen.getByRole("button", { name: /Continue watching Heat/ }));
		await waitFor(() =>
			expect(target.load).toHaveBeenCalledWith(
				{ kind: "local", channel: heat },
				{ startAt: 2000 }
			)
		);
	});

	it("starts from the beginning when it was finished here or has no place", async () => {
		vi.mocked(getPlaybackPosition).mockResolvedValue(saved(6990, true));
		render(<HistoryImportedNotice />, { wrapper: wrapperFor() });
		show(imported());
		fireEvent.click(screen.getByRole("button", { name: /Continue watching Heat/ }));
		await waitFor(() => expect(target.load).toHaveBeenCalledTimes(1));
		expect(target.load).toHaveBeenCalledWith(
			{ kind: "local", channel: heat },
			{ startAt: undefined }
		);
		target.load.mockClear();
		vi.mocked(getPlaybackPosition).mockRejectedValue(new Error("no cache"));
		show(imported());
		fireEvent.click(screen.getByRole("button", { name: /Continue watching Heat/ }));
		await waitFor(() => expect(target.load).toHaveBeenCalledTimes(1));
		expect(target.load).toHaveBeenCalledWith(
			{ kind: "local", channel: heat },
			{ startAt: undefined }
		);
	});

	it("leaves the time out when there's no place, and reads nothing for live", async () => {
		const live = { ...heat, id: "xt-live-1", name: "News", contentType: "live" } as Channel;
		render(<HistoryImportedNotice />, { wrapper: wrapperFor() });
		show(
			imported({
				channel: live,
				report: { ...imported().report, resume: undefined },
			})
		);
		fireEvent.click(screen.getByRole("button", { name: "Continue watching News" }));
		await waitFor(() => expect(target.load).toHaveBeenCalledTimes(1));
		expect(getPlaybackPosition).not.toHaveBeenCalled();
	});

	it("offers nothing to continue without a match, and names an unnamed device", () => {
		render(<HistoryImportedNotice />, { wrapper: wrapperFor() });
		show(imported({ from: "", channel: undefined }));
		expect(screen.getByRole("status")).toHaveTextContent("Added history from another device.");
		expect(screen.queryByRole("button", { name: /Continue watching/ })).toBeNull();
	});
});
