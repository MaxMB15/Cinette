// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/lib/types";
import { makeProvider } from "@/test/app-fixtures";
import { PlaylistManager } from "./PlaylistManager";

const state = vi.hoisted(() => ({
	providers: [] as Provider[],
	loadM3u: vi.fn(),
	loadM3uFile: vi.fn(),
	loadXtream: vi.fn(),
	removeProvider: vi.fn(),
	refreshProvider: vi.fn(),
	updateProvider: vi.fn(),
	/** What PlaylistManager last gave the settings dialog. */
	settings: null as { onRefreshNow: (id: string) => Promise<void> } | null,
}));

vi.mock("@/hooks/useChannels", () => ({
	useChannels: () => state,
}));

// The form and the settings dialog have tests of their own. These stand-ins
// only pass along what PlaylistManager gives them.
vi.mock("./AddProvider", () => ({
	AddProvider: (props: {
		onAddM3u: (name: string, url: string) => Promise<void>;
		onAddM3uFile: (name: string, path: string) => Promise<void>;
		onAddXtream: (name: string, url: string, user: string, pass: string) => Promise<void>;
	}) => (
		<div>
			<button onClick={() => props.onAddM3u("Home", "http://example.test/list.m3u")}>
				Add M3U
			</button>
			<button onClick={() => props.onAddM3uFile("Local", "/music/local.m3u")}>
				Add file
			</button>
			<button
				onClick={() =>
					props.onAddXtream("Panel", "http://panel.example.test", "user", "pass")
				}
			>
				Add Xtream
			</button>
		</div>
	),
}));

vi.mock("./ProviderSettingsModal", () => ({
	ProviderSettingsModal: (props: {
		provider: Provider;
		onClose: () => void;
		onRefreshNow: (id: string) => Promise<void>;
	}) => {
		state.settings = props;
		return (
			<div role="dialog" aria-label={`${props.provider.name} settings`}>
				<button onClick={() => props.onRefreshNow(props.provider.id)}>Refresh now</button>
				<button onClick={props.onClose}>Done</button>
			</div>
		);
	},
}));

const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

/** The card for one provider. */
const card = (name: string) => screen.getByRole("group", { name });

const cardButton = (provider: string, title: string) =>
	within(card(provider)).getByRole("button", { name: title });

beforeEach(() => {
	vi.clearAllMocks();
	state.providers = [];
	state.settings = null;
	for (const fn of [
		state.loadM3u,
		state.loadM3uFile,
		state.loadXtream,
		state.removeProvider,
		state.refreshProvider,
	]) {
		fn.mockResolvedValue(undefined);
	}
});

describe("PlaylistManager list", () => {
	it("has no provider list before one is added", () => {
		render(<PlaylistManager />);
		expect(screen.getByRole("heading", { name: "Playlists" })).toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "Your Providers" })).toBeNull();
	});

	it("shows each provider's address, type and channel count", () => {
		state.providers = [
			makeProvider({ channelCount: 1 }),
			makeProvider({
				id: "p2",
				name: "Panel",
				type: "xtream",
				url: "http://panel.example.test",
				channelCount: 2400,
			}),
		];
		render(<PlaylistManager />);

		const home = within(card("Home"));
		expect(home.getByText("m3u")).toBeInTheDocument();
		expect(home.getByText("http://example.com/list.m3u")).toBeInTheDocument();
		expect(home.getByText("1 channel")).toBeInTheDocument();
		expect(within(card("Panel")).getByText("xtream")).toBeInTheDocument();
		expect(
			within(card("Panel")).getByText(`${(2400).toLocaleString()} channels`)
		).toBeInTheDocument();
	});

	it("says when a provider was last updated", () => {
		const lastUpdated = "2026-10-01T12:00:00Z";
		state.providers = [makeProvider({ channelCount: 3, lastUpdated })];
		render(<PlaylistManager />);
		expect(
			within(card("Home")).getByText(
				`3 channels · Updated ${new Date(lastUpdated).toLocaleString()}`
			)
		).toBeInTheDocument();
	});

	it("shows only the file name of a local playlist, with nothing to refresh", () => {
		state.providers = [makeProvider({ name: "Local", url: "file:///music/lists/local.m3u" })];
		render(<PlaylistManager />);
		expect(within(card("Local")).getByText("local.m3u")).toBeInTheDocument();
		expect(within(card("Local")).queryByRole("button", { name: "Refresh" })).toBeNull();
	});
});

describe("PlaylistManager actions", () => {
	it("passes a new provider on to the channel state", async () => {
		render(<PlaylistManager />);
		fireEvent.click(screen.getByRole("button", { name: "Add M3U" }));
		fireEvent.click(screen.getByRole("button", { name: "Add file" }));
		fireEvent.click(screen.getByRole("button", { name: "Add Xtream" }));
		await flush();

		expect(state.loadM3u).toHaveBeenCalledExactlyOnceWith(
			"Home",
			"http://example.test/list.m3u"
		);
		expect(state.loadM3uFile).toHaveBeenCalledExactlyOnceWith("Local", "/music/local.m3u");
		expect(state.loadXtream).toHaveBeenCalledExactlyOnceWith(
			"Panel",
			"http://panel.example.test",
			"user",
			"pass"
		);
	});

	it("turns the refresh button off until that provider's refresh ends", async () => {
		let finish = () => {};
		state.refreshProvider.mockReturnValue(
			new Promise<void>((resolve) => {
				finish = resolve;
			})
		);
		state.providers = [makeProvider(), makeProvider({ id: "p2", name: "Panel" })];
		render(<PlaylistManager />);

		fireEvent.click(cardButton("Home", "Refresh"));
		expect(state.refreshProvider).toHaveBeenCalledExactlyOnceWith("p1");
		expect(cardButton("Home", "Refresh")).toBeDisabled();
		expect(cardButton("Panel", "Refresh")).toBeEnabled();

		await act(async () => finish());
		expect(cardButton("Home", "Refresh")).toBeEnabled();
	});

	it("shows a failed refresh on the card and turns the button back on", async () => {
		state.refreshProvider.mockRejectedValue("Server returned 503");
		state.providers = [makeProvider()];
		render(<PlaylistManager />);

		fireEvent.click(cardButton("Home", "Refresh"));
		await flush();
		expect(within(card("Home")).getByRole("alert")).toHaveTextContent("Server returned 503");
		expect(cardButton("Home", "Refresh")).toBeEnabled();
	});

	it("hides a refresh error once a later refresh updates the provider", async () => {
		state.refreshProvider.mockRejectedValue("Server returned 503");
		state.providers = [makeProvider()];
		const { rerender } = render(<PlaylistManager />);
		fireEvent.click(cardButton("Home", "Refresh"));
		await flush();
		expect(screen.getByRole("alert")).toBeInTheDocument();

		// The automatic refresh succeeded and moved the update time.
		state.providers = [makeProvider({ lastUpdated: "2026-10-12T08:00:00Z" })];
		rerender(<PlaylistManager />);
		expect(screen.queryByRole("alert")).toBeNull();
	});

	it("passes a failed refresh on to the settings dialog as well", async () => {
		state.refreshProvider.mockRejectedValue("Server returned 503");
		state.providers = [makeProvider()];
		render(<PlaylistManager />);
		fireEvent.click(cardButton("Home", "Settings"));

		let failure: unknown;
		await act(() => state.settings!.onRefreshNow("p1").catch((e: unknown) => (failure = e)));
		expect(failure).toBe("Server returned 503");
		expect(within(card("Home")).getByRole("alert")).toHaveTextContent("Server returned 503");
	});

	it("asks before removing a provider", () => {
		state.providers = [makeProvider()];
		render(<PlaylistManager />);
		fireEvent.click(cardButton("Home", "Remove"));
		expect(state.removeProvider).not.toHaveBeenCalled();

		const prompt = screen.getByRole("dialog", { name: "Remove provider?" });
		expect(prompt).toHaveTextContent('Remove "Home"?');
		fireEvent.click(within(prompt).getByRole("button", { name: "Remove" }));
		expect(state.removeProvider).toHaveBeenCalledExactlyOnceWith("p1");
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("keeps the provider when removing is cancelled", () => {
		state.providers = [makeProvider()];
		render(<PlaylistManager />);
		fireEvent.click(cardButton("Home", "Remove"));
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(state.removeProvider).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("opens the settings of the provider that was picked", async () => {
		state.providers = [makeProvider(), makeProvider({ id: "p2", name: "Panel" })];
		render(<PlaylistManager />);

		fireEvent.click(cardButton("Panel", "Settings"));
		const dialog = screen.getByRole("dialog", { name: "Panel settings" });
		fireEvent.click(within(dialog).getByRole("button", { name: "Refresh now" }));
		await flush();
		expect(state.refreshProvider).toHaveBeenCalledExactlyOnceWith("p2");

		fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
		expect(screen.queryByRole("dialog")).toBeNull();
	});
});
