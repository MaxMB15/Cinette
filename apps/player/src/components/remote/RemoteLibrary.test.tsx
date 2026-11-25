// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ContextType, ReactNode } from "react";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

vi.mock("@/lib/tauri", () => ({ remoteLibrary: vi.fn() }));
const navigate = vi.hoisted(() => vi.fn());
vi.mock("react-router", () => ({ useNavigate: () => navigate }));

// The channel screens, reduced to what this page hands them.
vi.mock("@/components/channels/ChannelList", async () => {
	const { useChannels } = await import("@/hooks/useChannels");
	const { useLibrarySource, usePlay } = await import("@/hooks/useLibrary");
	const { useDownloads } = await import("@/hooks/useDownloads");
	return {
		ChannelList: () => {
			const { channels, categories, providers, loading, toggleFavorite, guideVersion } =
				useChannels();
			const play = usePlay();
			const { downloads } = useDownloads();
			return (
				<div>
					<p>
						{useLibrarySource()} {loading ? "loading" : "loaded"} guide {guideVersion}
					</p>
					<p>
						{providers.length} providers, {downloads.length} downloads, categories{" "}
						{categories.map((c) => c.name).join(",")}
					</p>
					{channels.map((ch) => (
						<div key={ch.id}>
							<button
								type="button"
								onClick={() =>
									play({ url: ch.url, channelName: ch.name, channel: ch })
								}
							>
								{ch.name}
							</button>
							<button type="button" onClick={() => void toggleFavorite(ch.id)}>
								{ch.isFavorite ? "Unstar" : "Star"} {ch.name}
							</button>
						</div>
					))}
				</div>
			);
		},
	};
});

import { remoteLibrary, type LibraryCall } from "@/lib/tauri";
import { RemoteLibrary } from "./RemoteLibrary";
import { ChannelsContext } from "@/hooks/useChannels";
import { channelsQuery } from "@/lib/queries";
import { remoteSource } from "@/lib/library";
import type { Link } from "@/lib/remote-control";
import type { Channel } from "@/lib/types";
import { deferred } from "@/test/deferred";
import { createTestQueryClient, wrapperFor } from "@/test/query";

const channel = (id: string, name: string, extra: Partial<Channel> = {}): Channel => ({
	id,
	name,
	url: `cinette-remote:${id}`,
	groupTitle: "UK",
	isFavorite: false,
	contentType: "live",
	sources: [],
	...extra,
});

const news = channel("live-1", "News");
const sport = channel("live-2", "Sport", { groupTitle: "Sports" });

const load = vi.fn<(item: unknown) => Promise<void>>();

const link = { id: 9, name: "Living Room", destination: { load } } as unknown as Link;

/** This device's own channels, which the page keeps everything else of. */
const own = {
	channels: [channel("mine", "Mine")],
	categories: [],
	providers: [],
	loading: false,
	toggleFavorite: vi.fn(),
	guideVersion: 5,
} as unknown as NonNullable<ContextType<typeof ChannelsContext>>;

/** Answers each call by its name, as the other device would. */
const answer = (answers: Partial<Record<LibraryCall["name"], () => Promise<unknown>>>) =>
	vi.mocked(remoteLibrary).mockImplementation((linkId, call) => {
		if (linkId !== 9) throw new Error(`asked link ${linkId}`);
		const reply = answers[call.name];
		if (!reply) throw new Error(`unexpected ${call.name}`);
		return reply() as Promise<never>;
	});

const show = (client = createTestQueryClient()) => {
	const Cache = wrapperFor(client);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<Cache>
			<ChannelsContext.Provider value={own}>{children}</ChannelsContext.Provider>
		</Cache>
	);
	return render(<RemoteLibrary link={link} />, { wrapper });
};

beforeEach(() => {
	vi.mocked(remoteLibrary).mockReset();
	navigate.mockClear();
	load.mockReset().mockResolvedValue(undefined);
	answer({
		channels: async () => [news, sport],
		providers: async () => [{ id: "p1" }],
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("RemoteLibrary", () => {
	it("shows the other device's channels in this device's screens", async () => {
		show();
		expect(screen.getByText("remote:9 loading guide 0")).toBeInTheDocument();
		expect(screen.getByText("0 providers, 0 downloads, categories")).toBeInTheDocument();
		expect(screen.queryAllByRole("button")).toEqual([]);
		expect(await screen.findByText("remote:9 loaded guide 0")).toBeInTheDocument();
		expect(
			screen.getByText("1 providers, 0 downloads, categories UK,Sports")
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "News" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "Mine" })).not.toBeInTheDocument();
	});

	it("keeps the channels loaded for an hour once nothing shows them", async () => {
		const client = createTestQueryClient();
		const view = show(client);
		await screen.findByRole("button", { name: "News" });
		vi.useFakeTimers();
		view.unmount();
		const { queryKey } = channelsQuery(remoteSource(9));
		act(() => vi.advanceTimersByTime(59 * 60 * 1000));
		expect(client.getQueryData(queryKey)).toEqual([news, sport]);
		act(() => vi.advanceTimersByTime(2 * 60 * 1000));
		expect(client.getQueryData(queryKey)).toBeUndefined();
	});

	it("says when the channels didn't load, and tries again", async () => {
		const channels = vi.fn().mockRejectedValueOnce(new Error("gone")).mockResolvedValue([news]);
		answer({ channels, providers: async () => [] });
		show();
		expect(
			await screen.findByText("Couldn't load the channels on Living Room.")
		).toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(await screen.findByRole("button", { name: "News" })).toBeInTheDocument();
		expect(channels).toHaveBeenCalledTimes(2);
	});

	it("says there are no channels when the other device has none", async () => {
		answer({ channels: async () => [], providers: async () => [] });
		show();
		expect(await screen.findByText("No channels on Living Room")).toBeInTheDocument();
		expect(screen.getByText("Add a playlist there to watch it from here.")).toBeInTheDocument();
	});

	it("plays a pick on the other device, then opens the player page", async () => {
		show();
		fireEvent.click(await screen.findByRole("button", { name: "News" }));
		expect(load).toHaveBeenCalledExactlyOnceWith({
			kind: "remote",
			itemId: "live-1",
			title: "News",
		});
		await waitFor(() => expect(navigate).toHaveBeenCalledExactlyOnceWith("/player"));
	});

	it("says when the other device couldn't play a pick, until the next one", async () => {
		load.mockRejectedValueOnce(new Error("notFound"));
		show();
		fireEvent.click(await screen.findByRole("button", { name: "News" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Living Room couldn't play News."
		);
		expect(navigate).not.toHaveBeenCalled();
		fireEvent.click(screen.getByRole("button", { name: "Sport" }));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("opens nothing for a pick a newer one replaced", async () => {
		const first = deferred();
		const second = deferred();
		load.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
		show();
		fireEvent.click(await screen.findByRole("button", { name: "News" }));
		fireEvent.click(screen.getByRole("button", { name: "Sport" }));
		await act(async () => first.reject(new Error("replaced")));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		await act(async () => second.resolve());
		expect(navigate).toHaveBeenCalledExactlyOnceWith("/player");
	});

	it("opens nothing for a pick that answers after the screens closed", async () => {
		const pick = deferred();
		load.mockReturnValueOnce(pick.promise);
		const view = show();
		fireEvent.click(await screen.findByRole("button", { name: "News" }));
		view.unmount();
		await act(async () => pick.resolve());
		expect(navigate).not.toHaveBeenCalled();
	});

	it("stars a channel on the other device and shows it here", async () => {
		const toggleFavorite = vi.fn(async () => true);
		answer({ channels: async () => [news, sport], providers: async () => [], toggleFavorite });
		show();
		fireEvent.click(await screen.findByRole("button", { name: "Star News" }));
		expect(await screen.findByRole("button", { name: "Unstar News" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Star Sport" })).toBeInTheDocument();
		expect(vi.mocked(remoteLibrary)).toHaveBeenCalledWith(9, {
			name: "toggleFavorite",
			id: "live-1",
		});
		expect(own.toggleFavorite).not.toHaveBeenCalled();
	});

	it("says when the favorites didn't change", async () => {
		answer({
			channels: async () => [news],
			providers: async () => [],
			toggleFavorite: async () => {
				throw new Error("gone");
			},
		});
		show();
		fireEvent.click(await screen.findByRole("button", { name: "Star News" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Couldn't change the favorites on Living Room."
		);
		expect(screen.getByRole("button", { name: "Star News" })).toBeInTheDocument();
	});
});
