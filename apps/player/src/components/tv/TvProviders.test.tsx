// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { EMPTY_GUIDE_MESSAGE } from "@/components/playlist/ProviderSettingsModal";
import { DISCLAIMER_TEXT } from "@/components/playlist/ContentDisclaimer";
import { getEpgLastRefresh, loadProviderSettings } from "@/hooks/useChannels";
import { detectEpgUrl, getContentCounts, refreshEpg, setEpgUrl } from "@/lib/tauri";
import type { Provider } from "@/lib/types";
import { makeProvider } from "@/test/app-fixtures";
import { deferred } from "@/test/deferred";
import { wrapperFor } from "@/test/query";
import { activeRow, beside, column, cursorTo, enterText, pressOk } from "@/test/tv-columns";
import { useTvProviderSections } from "./TvProviders";
import { TvSettingsColumns } from "./TvSettingsColumns";
import { TvNavContext } from "./tv-nav";

const channels = vi.hoisted(() => ({
	providers: [] as unknown[],
	loadM3u: vi.fn(),
	loadXtream: vi.fn(),
	refreshProvider: vi.fn(),
	refreshProviders: vi.fn(),
	removeProvider: vi.fn(),
	updateProvider: vi.fn(),
}));
vi.mock("@/hooks/useChannels", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks/useChannels")>()),
	useChannels: () => channels,
}));
vi.mock("@/lib/tauri", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/tauri")>()),
	detectEpgUrl: vi.fn(),
	getContentCounts: vi.fn(),
	refreshEpg: vi.fn(),
	setEpgUrl: vi.fn(),
}));
// The real screen, with a look at the rows it's given, whose ids show nowhere.
vi.mock("./TvSettingsColumns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./TvSettingsColumns")>();
	return { ...actual, TvSettingsColumns: vi.fn(actual.TvSettingsColumns) };
});

const ADD = "Add a provider";
const M3U = makeProvider({ id: "m3u", name: "Home", url: "http://example.test/list.m3u" });
const XTREAM = makeProvider({
	id: "xt",
	name: "Live",
	type: "xtream",
	url: "http://xtream.test",
	username: "max",
	password: "secret",
});
const FILE = makeProvider({ id: "file", name: "Local", url: "file:///home/max/list.m3u" });
const OTHER = makeProvider({ id: "other", name: "Other" });

/** Lets every promise the screen is waiting on finish. */
const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

/** The sections on a screen of their own. Settings puts them in a group over its other sections. */
const TvProviders = () => (
	<TvSettingsColumns
		title="Providers"
		memoryKey="providers"
		groups={[{ label: "Sections", sections: useTvProviderSections() }]}
	/>
);

const providersScreen = () => (
	<TvNavContext.Provider value={{ section: "live", openSection: () => {}, memory: new Map() }}>
		<TvProviders />
	</TvNavContext.Provider>
);

const show = (...providers: Provider[]) => {
	channels.providers = providers;
	return render(providersScreen(), { wrapper: wrapperFor() });
};

const button = (name: string) => screen.getByRole("button", { name });
const dialog = () => screen.queryByRole("dialog");
const field = (name: string) => screen.getByRole("textbox", { name });
const spinner = (name: string) => within(activeRow(name)).queryByLabelText("Working");
const firstLabels = (name: string) =>
	within(column(name))
		.getAllByRole("option")
		.map((row) => row.textContent);
/** Every row of a section, including those a long list hasn't mounted yet. */
const sectionRows = (label: string) =>
	vi
		.mocked(TvSettingsColumns)
		.mock.lastCall![0].groups[0].sections.find((section) => section.label === label)!
		.settings.map((row) => row.id);
/** Presses OK on a row, then on one of the answers it offers. */
const answer = (name: string, label: string, choice: string) => {
	pressOk(name, label);
	pressOk("Choices", choice);
};
/** Opens a text row, types, and presses Done. */
const typeInto = (name: string, label: string, text: string) => {
	pressOk(name, label);
	enterText(label, text);
};

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	Element.prototype.scrollIntoView = () => {};
	channels.loadM3u.mockResolvedValue(undefined);
	channels.loadXtream.mockResolvedValue(undefined);
	channels.refreshProvider.mockResolvedValue(undefined);
	channels.refreshProviders.mockResolvedValue(undefined);
	channels.removeProvider.mockResolvedValue(undefined);
	channels.updateProvider.mockResolvedValue(undefined);
	vi.mocked(setEpgUrl).mockResolvedValue(undefined);
	vi.mocked(refreshEpg).mockResolvedValue(10);
	vi.mocked(detectEpgUrl).mockResolvedValue(null);
	vi.mocked(getContentCounts).mockResolvedValue({ live: 1200, movies: 30, series: 4 });
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("useTvProviderSections", () => {
	it("lists each provider with its channel count, then the section to add one", () => {
		show(makeProvider({ id: "a", name: "A", channelCount: 1200 }), XTREAM);

		expect(screen.getByRole("heading", { name: "Providers" })).toBeInTheDocument();
		expect(firstLabels("Sections")).toEqual([
			`A${(1200).toLocaleString()} channels`,
			"Live0 channels",
			"Add a provider",
		]);
	});

	describe("a provider's summary", () => {
		const HOUR = 3_600_000;
		/** A time `ms` ago, and half a minute more, since the screen's clock counts whole seconds. */
		const ago = (ms: number) => Date.now() - ms - 30_000;
		/** Each count's name and number, in order. */
		const counts = () =>
			screen
				.getAllByRole("term")
				.map((term) => [term.textContent, term.nextSibling!.textContent]);
		/** The frame over a provider's rows. */
		const summary = (name: string) => column(name).previousElementSibling as HTMLElement;
		const statusLine = (name: string) => within(summary(name)).getByRole("img").nextSibling!;

		it("shows its kind, its counts and when it and its guide last updated", async () => {
			localStorage.setItem("epg-last-refresh-xt", String(ago(3 * 24 * HOUR)));
			show(
				makeProvider({
					...XTREAM,
					lastUpdated: new Date(ago(2 * HOUR)).toISOString(),
				})
			);
			await settle();

			expect(getContentCounts).toHaveBeenCalledExactlyOnceWith("xt");
			expect(screen.getByText("Xtream Codes")).toBeInTheDocument();
			expect(counts()).toEqual([
				["Live TV", (1200).toLocaleString()],
				["Movies", "30"],
				["Series", "4"],
			]);
			expect(statusLine("Live")).toHaveTextContent(
				/^Updated 2 h ago · Guide updated 3 days ago$/
			);
			expect(screen.getAllByRole("img", { name: "OK" })).toHaveLength(2);
		});

		it("names an M3U playlist's kind, and leaves out the times it doesn't have", async () => {
			show(M3U);
			await settle();

			expect(screen.getByText("M3U playlist")).toBeInTheDocument();
			expect(statusLine("Home")).toBeEmptyDOMElement();
		});

		it("shows no counts until they load", async () => {
			const loading = deferred<{ live: number; movies: number; series: number }>();
			vi.mocked(getContentCounts).mockReturnValue(loading.promise);
			show(M3U);

			expect(screen.queryAllByRole("term")).toEqual([]);

			loading.resolve({ live: 5, movies: 0, series: 0 });
			await settle();

			expect(counts()[0]).toEqual(["Live TV", "5"]);
		});

		it("counts again after the provider updates", async () => {
			const { rerender } = show(
				makeProvider({ ...XTREAM, lastUpdated: "2026-11-20T10:00:00Z" })
			);
			await settle();
			vi.mocked(getContentCounts).mockResolvedValue({ live: 1300, movies: 30, series: 4 });

			channels.providers = [makeProvider({ ...XTREAM, lastUpdated: "2026-11-21T10:00:00Z" })];
			rerender(providersScreen());
			await settle();

			expect(getContentCounts).toHaveBeenCalledTimes(2);
			expect(counts()[0]).toEqual(["Live TV", (1300).toLocaleString()]);
		});

		it("says the last refresh failed, with an amber dot on the provider", async () => {
			channels.refreshProvider.mockRejectedValue("Server down");
			show(
				makeProvider({
					...M3U,
					lastUpdated: new Date(ago(5 * 60_000)).toISOString(),
				})
			);

			pressOk("Home", "Refresh now");
			await settle();

			expect(screen.getAllByRole("img", { name: "Refresh failed" })).toHaveLength(2);
			expect(statusLine("Home")).toHaveTextContent(/^Refresh failed · Updated 5 min ago$/);
		});

		it("gives each provider its first letter on a color of its own, in turn", () => {
			const names = ["home", "b", "c", "d", "e", "f"];
			show(...names.map((name) => makeProvider({ id: name, name })));

			const tiles = [...column("Sections").querySelectorAll<HTMLElement>("[data-letter]")];
			expect(tiles.map((tile) => tile.dataset.letter)).toEqual([
				"H",
				"B",
				"C",
				"D",
				"E",
				"F",
			]);
			const colors = tiles.map((tile) =>
				[...tile.classList].find((c) => c.startsWith("bg-"))
			);
			expect(new Set(colors.slice(0, 5)).size).toBe(5);
			expect(colors[5]).toBe(colors[0]);
			expect(colors).not.toContain(undefined);
			const large = summary("home").querySelector<HTMLElement>("[data-letter]")!;
			expect(large.dataset.letter).toBe("H");
			expect(large).toHaveClass(colors[0]!);
		});
	});

	it("gives the rows that do something an icon, and marks Remove as one that removes", () => {
		show(M3U);

		const icon = (label: string) => cursorTo("Home", label).querySelector("svg");
		expect(icon("Refresh now")).toBeInTheDocument();
		expect(icon("Refresh guide now")).toBeInTheDocument();
		expect(icon("Remove provider")).toBeInTheDocument();
		expect(icon("Name")).toBeNull();
		const { sections } = vi.mocked(TvSettingsColumns).mock.lastCall![0].groups[0];
		const danger = sections[0].settings.filter((row) => row.danger).map((row) => row.id);
		expect(danger).toEqual(["remove"]);
	});

	it("gives each section an id of its own, which keeps its place in the list", () => {
		show(M3U, XTREAM);

		const { sections } = vi.mocked(TvSettingsColumns).mock.lastCall![0].groups[0];
		expect(sections.map((section) => section.id)).toEqual(["m3u", "xt", "add"]);
	});

	it("has rows for what an M3U playlist can change, in order", () => {
		show(M3U);

		expect(sectionRows("Home")).toEqual([
			"refresh",
			"guide-refresh",
			"name",
			"url",
			"auto",
			"guide-url",
			"guide-find",
			"guide-auto",
			"guide-every",
			"remove",
		]);
		expect(firstLabels("Home")).toEqual([
			"Refresh now",
			"Refresh guide now",
			`Name${M3U.name}`,
			`Playlist URL${M3U.url}`,
			"Refresh automaticallyOff",
			"Guide URLNot set",
			"Find the guide URL",
			"Refresh guide automaticallyOn",
			"Refresh guide everyEvery day",
			"Remove provider",
		]);
	});

	it("adds the login rows for an Xtream provider, and calls its URL a server", () => {
		show(XTREAM);

		expect(sectionRows("Live")).toEqual([
			"refresh",
			"guide-refresh",
			"name",
			"url",
			"username",
			"password",
			"auto",
			"guide-url",
			"guide-find",
			"guide-auto",
			"guide-every",
			"remove",
		]);
		expect(cursorTo("Live", "Server URL")).toHaveTextContent(XTREAM.url);
		expect(cursorTo("Live", "Username")).toHaveTextContent("max");
		expect(cursorTo("Live", "Password")).toHaveTextContent("PasswordSet");
	});

	it("doesn't show a saved password, in the row or until the keyboard opens", () => {
		show(XTREAM);

		expect(cursorTo("Live", "Password")).not.toHaveTextContent("secret");

		pressOk("Live", "Password");

		expect(field("Password")).toHaveValue("secret");
	});

	it("says a login that's missing isn't set", () => {
		show(makeProvider({ id: "xt", name: "Live", type: "xtream" }));

		expect(cursorTo("Live", "Username")).toHaveTextContent("UsernameNot set");
		expect(cursorTo("Live", "Password")).toHaveTextContent("PasswordNot set");
	});

	it("shows a file's name, with nothing to refresh or retype", () => {
		show(FILE);

		expect(sectionRows("Local")).toEqual([
			"guide-refresh",
			"name",
			"file",
			"guide-url",
			"guide-find",
			"guide-auto",
			"guide-every",
			"remove",
		]);
		expect(cursorTo("Local", "File")).toHaveTextContent("Filelist.m3u");

		pressOk("Local", "File");

		expect(dialog()).not.toBeInTheDocument();
	});

	it("keeps a row's work and its answer to that row, leaving the others free", async () => {
		const refreshing = deferred<void>();
		channels.refreshProvider.mockReturnValueOnce(refreshing.promise);
		show(M3U, OTHER);

		pressOk("Home", "Refresh now");
		expect(spinner("Home")).toBeInTheDocument();

		cursorTo("Home", "Refresh guide now");
		expect(spinner("Home")).not.toBeInTheDocument();

		cursorTo("Sections", "Other");
		cursorTo("Other", "Refresh now");
		expect(spinner("Other")).not.toBeInTheDocument();

		pressOk("Other", "Refresh now");
		expect(channels.refreshProvider).toHaveBeenLastCalledWith("other");

		pressOk("Other", "Refresh guide now");
		await settle();
		expect(screen.getByText("The guide is up to date.")).toBeInTheDocument();

		cursorTo("Other", "Find the guide URL");
		expect(screen.queryByText("The guide is up to date.")).not.toBeInTheDocument();

		cursorTo("Sections", "Home");
		cursorTo("Home", "Refresh guide now");
		expect(screen.queryByText("The guide is up to date.")).not.toBeInTheDocument();

		refreshing.resolve();
		await settle();
	});

	describe("Refresh now", () => {
		it("says when the provider last updated", () => {
			const lastUpdated = "2026-01-02T03:04:05Z";
			show(makeProvider({ ...M3U, lastUpdated }));

			cursorTo("Home", "Refresh now");

			expect(
				screen.getByText(
					`Updated ${new Date(lastUpdated).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
				)
			).toBeInTheDocument();
		});

		it("refreshes that provider, with a spinner until it's done", async () => {
			const refreshing = deferred<void>();
			channels.refreshProvider.mockReturnValue(refreshing.promise);
			show(XTREAM, M3U);
			cursorTo("Sections", "Home");
			cursorTo("Home", "Refresh now");
			expect(spinner("Home")).not.toBeInTheDocument();

			pressOk("Home", "Refresh now");

			expect(channels.refreshProvider).toHaveBeenCalledExactlyOnceWith("m3u");
			expect(spinner("Home")).toBeInTheDocument();

			refreshing.resolve();
			await settle();

			expect(spinner("Home")).not.toBeInTheDocument();
		});

		it("shows why a refresh failed, over when it last updated", async () => {
			channels.refreshProvider.mockRejectedValue("Server down");
			show(makeProvider({ ...M3U, lastUpdated: "2026-01-02T03:04:05Z" }));

			pressOk("Home", "Refresh now");
			await settle();

			expect(screen.getByText("Server down")).toBeInTheDocument();
			expect(screen.queryByText(/^Updated /)).not.toBeInTheDocument();
		});
	});

	describe("Refresh guide now", () => {
		it("refreshes the guide with a spinner, and says it's up to date", async () => {
			const refreshing = deferred<number>();
			vi.mocked(refreshEpg).mockReturnValue(refreshing.promise);
			show(M3U);
			cursorTo("Home", "Refresh guide now");
			expect(spinner("Home")).not.toBeInTheDocument();

			pressOk("Home", "Refresh guide now");

			expect(refreshEpg).toHaveBeenCalledExactlyOnceWith("m3u");
			expect(spinner("Home")).toBeInTheDocument();

			refreshing.resolve(12);
			await settle();

			expect(spinner("Home")).not.toBeInTheDocument();
			expect(screen.getByText("The guide is up to date.")).toBeInTheDocument();
		});

		it("says so when the guide came back empty", async () => {
			vi.mocked(refreshEpg).mockResolvedValue(0);
			show(M3U);

			pressOk("Home", "Refresh guide now");
			await settle();

			expect(screen.getByText(EMPTY_GUIDE_MESSAGE)).toBeInTheDocument();
		});

		it("starts the wait for the automatic refresh from now", async () => {
			const before = Date.now();
			show(makeProvider({ ...M3U, id: "timed" }));
			expect(getEpgLastRefresh("timed")).toBe(0);

			pressOk("Home", "Refresh guide now");
			await settle();

			expect(getEpgLastRefresh("timed")).toBeGreaterThanOrEqual(before);
		});
	});

	describe("Name", () => {
		it("opens on the name, with nothing added in front", () => {
			show(M3U);

			pressOk("Home", "Name");

			expect(field("Name")).toHaveValue("Home");
		});

		it("saves a new name without the spaces around it", async () => {
			show(M3U);

			typeInto("Home", "Name", "  Den  ");
			await settle();

			expect(channels.updateProvider).toHaveBeenCalledExactlyOnceWith(
				"m3u",
				"Den",
				M3U.url,
				undefined,
				undefined
			);
		});

		it("keeps the name when it's left blank", async () => {
			show(M3U);

			typeInto("Home", "Name", "   ");
			await settle();

			expect(channels.updateProvider).not.toHaveBeenCalled();
		});

		it("keeps an Xtream provider's login when its name changes", async () => {
			show(XTREAM);

			typeInto("Live", "Name", "Den");
			await settle();

			expect(channels.updateProvider).toHaveBeenCalledExactlyOnceWith(
				"xt",
				"Den",
				XTREAM.url,
				"max",
				"secret"
			);
		});

		it("sends an empty login for an Xtream provider that has none", async () => {
			show(makeProvider({ id: "xt", name: "Live", type: "xtream" }));

			typeInto("Live", "Name", "Den");
			await settle();

			expect(channels.updateProvider.mock.lastCall!.slice(3)).toEqual(["", ""]);
		});

		it("shows why a save failed, on each row it could have come from", async () => {
			channels.updateProvider.mockRejectedValue("Save failed");
			show(XTREAM);

			typeInto("Live", "Name", "Den");
			await settle();

			for (const label of ["Name", "Server URL", "Username", "Password"]) {
				cursorTo("Live", label);
				expect(screen.getByText("Save failed")).toBeInTheDocument();
			}
		});
	});

	describe("URL", () => {
		it("shows the whole address beside the row", () => {
			show(M3U);

			cursorTo("Home", "Playlist URL");

			expect(screen.getAllByText(M3U.url).map((el) => el.tagName)).toContain("P");
		});

		it("opens on the saved address", () => {
			show(M3U);

			pressOk("Home", "Playlist URL");

			expect(field("Playlist URL")).toHaveValue(M3U.url);
		});

		it("saves a new address without the spaces around it", async () => {
			show(M3U);

			typeInto("Home", "Playlist URL", " http://new.test ");
			await settle();

			expect(channels.updateProvider).toHaveBeenCalledExactlyOnceWith(
				"m3u",
				"Home",
				"http://new.test",
				undefined,
				undefined
			);
		});

		it("keeps the address when it's left blank", async () => {
			show(M3U);

			typeInto("Home", "Playlist URL", "  ");
			await settle();

			expect(channels.updateProvider).not.toHaveBeenCalled();
		});
	});

	describe("Login", () => {
		it("saves a new username as typed, keeping the password", async () => {
			show(XTREAM);

			typeInto("Live", "Username", " me ");
			await settle();

			expect(channels.updateProvider).toHaveBeenCalledExactlyOnceWith(
				"xt",
				"Live",
				XTREAM.url,
				" me ",
				"secret"
			);
		});

		it("saves a new password as typed, keeping the username", async () => {
			show(XTREAM);

			typeInto("Live", "Password", " pw ");
			await settle();

			expect(channels.updateProvider).toHaveBeenCalledExactlyOnceWith(
				"xt",
				"Live",
				XTREAM.url,
				"max",
				" pw "
			);
		});

		it("opens a missing login with nothing in it", () => {
			show(makeProvider({ id: "xt", name: "Live", type: "xtream" }));

			pressOk("Live", "Username");
			expect(field("Username")).toHaveValue("");
			fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

			pressOk("Live", "Password");
			expect(field("Password")).toHaveValue("");
		});
	});

	describe("Refresh automatically", () => {
		it("turns on, saves it, and offers how often", () => {
			show(M3U);
			expect(cursorTo("Home", "Refresh automatically")).toHaveTextContent("Off");
			expect(sectionRows("Home")).not.toContain("every");

			pressOk("Home", "Refresh automatically");

			expect(activeRow("Home")).toHaveTextContent("On");
			expect(loadProviderSettings("m3u").autoRefresh).toBe(true);
			expect(sectionRows("Home")).toContain("every");
		});

		it("offers each interval and saves the one picked", () => {
			localStorage.setItem(
				"provider-settings-m3u",
				JSON.stringify({ autoRefresh: true, refreshIntervalHours: 24 })
			);
			show(M3U);

			pressOk("Home", "Refresh every");
			expect(firstLabels("Choices")).toEqual([
				"Every hour",
				"Every 6 hours",
				"Every 12 hours",
				"Every day",
				"Every 2 days",
				"Every week",
			]);
			expect(activeRow("Choices")).toHaveTextContent("Every day");

			pressOk("Choices", "Every 2 days");

			expect(loadProviderSettings("m3u").refreshIntervalHours).toBe(48);
			expect(cursorTo("Home", "Refresh every")).toHaveTextContent("Every 2 days");
		});

		it("keeps what else is saved when one setting changes", () => {
			localStorage.setItem(
				"provider-settings-m3u",
				JSON.stringify({ autoRefresh: false, epgRefreshIntervalHours: 72 })
			);
			show(M3U);

			pressOk("Home", "Refresh automatically");

			expect(loadProviderSettings("m3u").epgRefreshIntervalHours).toBe(72);
		});

		it("keeps each provider's settings to itself", () => {
			show(M3U, OTHER);
			cursorTo("Sections", "Other");

			pressOk("Other", "Refresh automatically");

			expect(loadProviderSettings("other").autoRefresh).toBe(true);
			expect(loadProviderSettings("m3u").autoRefresh).toBe(false);

			cursorTo("Sections", "Home");
			expect(cursorTo("Home", "Refresh automatically")).toHaveTextContent("Off");
		});

		it("still shows each provider's change when storage doesn't keep them", () => {
			vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {});
			show(M3U, OTHER);

			pressOk("Home", "Refresh automatically");
			cursorTo("Sections", "Other");
			pressOk("Other", "Refresh automatically");
			cursorTo("Sections", "Home");

			expect(cursorTo("Home", "Refresh automatically")).toHaveTextContent("On");
		});
	});

	describe("Guide URL", () => {
		it("says when no address is set, and starts one from http://", () => {
			show(M3U);

			expect(cursorTo("Home", "Guide URL")).toHaveTextContent("Not set");

			pressOk("Home", "Guide URL");

			expect(field("Guide URL")).toHaveValue("http://");
		});

		it("saves no address when the start of one is left as it was", () => {
			show(M3U);

			typeInto("Home", "Guide URL", "http://");

			expect(setEpgUrl).toHaveBeenCalledExactlyOnceWith("m3u", null);
		});

		it("shows the saved address and opens on it", () => {
			const epgUrl = "http://guide.test/epg.xml";
			show(makeProvider({ ...M3U, epgUrl }));

			expect(cursorTo("Home", "Guide URL")).toHaveTextContent(epgUrl);
			expect(screen.getAllByText(epgUrl).map((el) => el.tagName)).toContain("P");

			pressOk("Home", "Guide URL");

			expect(field("Guide URL")).toHaveValue(epgUrl);
		});

		it("shows nothing beside the row when there's no address", () => {
			show(M3U);

			cursorTo("Home", "Guide URL");

			expect(beside("Home")).toBeEmptyDOMElement();
		});

		it("saves the address without its spaces, then reloads the providers", async () => {
			const saving = deferred<void>();
			vi.mocked(setEpgUrl).mockReturnValue(saving.promise);
			show(M3U);

			typeInto("Home", "Guide URL", " http://g.test ");

			expect(setEpgUrl).toHaveBeenCalledExactlyOnceWith("m3u", "http://g.test");
			expect(channels.refreshProviders).not.toHaveBeenCalled();
			expect(spinner("Home")).toBeInTheDocument();

			saving.resolve();
			await settle();

			expect(channels.refreshProviders).toHaveBeenCalledOnce();
			expect(spinner("Home")).not.toBeInTheDocument();
		});

		it("removes the address when it's left blank", async () => {
			show(makeProvider({ ...M3U, epgUrl: "http://g.test" }));

			typeInto("Home", "Guide URL", "  ");
			await settle();

			expect(setEpgUrl).toHaveBeenCalledExactlyOnceWith("m3u", null);
		});

		it("shows why a save failed, over the address", async () => {
			vi.mocked(setEpgUrl).mockRejectedValue("Bad address");
			const epgUrl = "http://g.test";
			show(makeProvider({ ...M3U, epgUrl }));

			typeInto("Home", "Guide URL", "http://other.test");
			await settle();

			expect(cursorTo("Home", "Guide URL")).toBeInTheDocument();
			expect(screen.getByText("Bad address")).toBeInTheDocument();
			expect(beside("Home")).not.toHaveTextContent(epgUrl);
		});
	});

	describe("Find the guide URL", () => {
		it("looks for one with a spinner, and says when there's none", async () => {
			const finding = deferred<string | null>();
			vi.mocked(detectEpgUrl).mockReturnValue(finding.promise);
			show(M3U);
			cursorTo("Home", "Find the guide URL");
			expect(spinner("Home")).not.toBeInTheDocument();

			pressOk("Home", "Find the guide URL");

			expect(detectEpgUrl).toHaveBeenCalledExactlyOnceWith("m3u");
			expect(spinner("Home")).toBeInTheDocument();

			finding.resolve(null);
			await settle();

			expect(spinner("Home")).not.toBeInTheDocument();
			expect(screen.getByText("No EPG URL detected")).toBeInTheDocument();
			expect(setEpgUrl).not.toHaveBeenCalled();
		});

		it("saves what it found and says what that is", async () => {
			vi.mocked(detectEpgUrl).mockResolvedValue("http://found.test");
			show(M3U);

			pressOk("Home", "Find the guide URL");
			await settle();

			expect(setEpgUrl).toHaveBeenCalledExactlyOnceWith("m3u", "http://found.test");
			expect(channels.refreshProviders).toHaveBeenCalledOnce();
			expect(screen.getByText("Found http://found.test")).toBeInTheDocument();
		});
	});

	describe("Refresh guide automatically", () => {
		it("starts on, and stops offering how often once it's off", () => {
			show(M3U);
			expect(cursorTo("Home", "Refresh guide automatically")).toHaveTextContent("On");

			pressOk("Home", "Refresh guide automatically");

			expect(activeRow("Home")).toHaveTextContent("Off");
			expect(loadProviderSettings("m3u").epgAutoRefresh).toBe(false);
			expect(sectionRows("Home")).toEqual([
				"refresh",
				"guide-refresh",
				"name",
				"url",
				"auto",
				"guide-url",
				"guide-find",
				"guide-auto",
				"remove",
			]);
		});

		it("offers each interval and saves the one picked", () => {
			show(M3U);

			pressOk("Home", "Refresh guide every");
			expect(firstLabels("Choices")).toEqual([
				"Every 6 hours",
				"Every 12 hours",
				"Every day",
				"Every 2 days",
				"Every 3 days",
			]);
			expect(activeRow("Choices")).toHaveTextContent("Every day");

			pressOk("Choices", "Every 3 days");

			expect(loadProviderSettings("m3u").epgRefreshIntervalHours).toBe(72);
			expect(cursorTo("Home", "Refresh guide every")).toHaveTextContent("Every 3 days");
		});
	});

	describe("Remove provider", () => {
		it("asks first, naming the provider", () => {
			show(M3U);

			pressOk("Home", "Remove provider");

			expect(screen.getByRole("dialog", { name: "Remove provider?" })).toBeInTheDocument();
			expect(
				screen.getByText('Remove "Home"? Its channels and favorites are removed too.')
			).toBeInTheDocument();
			expect(button("Cancel")).toHaveFocus();
			expect(channels.removeProvider).not.toHaveBeenCalled();
		});

		it("removes nothing on Cancel", () => {
			show(M3U);

			pressOk("Home", "Remove provider");
			fireEvent.click(button("Cancel"));

			expect(dialog()).not.toBeInTheDocument();
			expect(channels.removeProvider).not.toHaveBeenCalled();
		});

		it("removes that provider once confirmed", () => {
			show(XTREAM, M3U);
			cursorTo("Sections", "Home");

			pressOk("Home", "Remove provider");
			fireEvent.click(button("Remove"));

			expect(channels.removeProvider).toHaveBeenCalledExactlyOnceWith("m3u");
		});

		it("reaches the last row of an Xtream provider's long list", () => {
			show(XTREAM);

			pressOk("Live", "Remove provider");

			expect(
				screen.getByText('Remove "Live"? Its channels and favorites are removed too.')
			).toBeInTheDocument();
		});
	});

	describe("Add a provider", () => {
		const showAdd = () => {
			show();
			cursorTo("Sections", ADD);
		};
		const addProvider = () => pressOk(ADD, "Add provider");

		it("shows the content disclaimer whichever row the cursor is on", () => {
			showAdd();

			expect(screen.getByText(DISCLAIMER_TEXT)).toBeInTheDocument();

			cursorTo(ADD, "Add provider");

			expect(screen.getByText(DISCLAIMER_TEXT)).toBeInTheDocument();
		});

		it("shows no section for a provider when there are none", () => {
			showAdd();

			expect(firstLabels("Sections")).toEqual([ADD]);
		});

		it("gives each row an id of its own", () => {
			showAdd();

			expect(sectionRows(ADD)).toEqual(["send", "type", "name", "url", "add"]);
		});

		it("points to sending providers from another device", () => {
			showAdd();

			expect(cursorTo(ADD, "From another device").textContent).toBe("From another device");
			expect(screen.getByText(/connect to this TV, and choose Send/)).toBeInTheDocument();

			pressOk(ADD, "From another device");

			expect(dialog()).not.toBeInTheDocument();
		});

		it("starts on an M3U playlist, and offers Xtream Codes", () => {
			showAdd();

			expect(cursorTo(ADD, "Type")).toHaveTextContent("TypeM3U playlist");
			expect(firstLabels("Choices")).toEqual(["M3U playlist", "Xtream Codes"]);
			expect(firstLabels(ADD)).toEqual([
				"From another device",
				"TypeM3U playlist",
				"NameNot set",
				"Playlist URLNot set",
				"Add provider",
			]);
		});

		it("asks for a server and a login for Xtream Codes, keeping what's typed", () => {
			showAdd();
			typeInto(ADD, "Name", "Mine");

			answer(ADD, "Type", "Xtream Codes");

			expect(sectionRows(ADD)).toEqual([
				"send",
				"type",
				"name",
				"url",
				"username",
				"password",
				"add",
			]);
			expect(firstLabels(ADD)).toEqual([
				"From another device",
				"TypeXtream Codes",
				"NameMine",
				"Server URLNot set",
				"UsernameNot set",
				"PasswordNot set",
				"Add provider",
			]);
		});

		it("starts a URL from http://, and a name from nothing", () => {
			showAdd();

			pressOk(ADD, "Playlist URL");
			expect(field("Playlist URL")).toHaveValue("http://");
			fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

			pressOk(ADD, "Name");
			expect(field("Name")).toHaveValue("");
		});

		it("starts a server URL from http://, and a login from nothing", () => {
			showAdd();
			answer(ADD, "Type", "Xtream Codes");

			pressOk(ADD, "Server URL");
			expect(field("Server URL")).toHaveValue("http://");
			fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

			pressOk(ADD, "Username");
			expect(field("Username")).toHaveValue("");
			fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

			pressOk(ADD, "Password");
			expect(field("Password")).toHaveValue("");
		});

		it("asks for the URL first, and adds nothing without one", async () => {
			showAdd();
			typeInto(ADD, "Playlist URL", "   ");

			addProvider();
			await settle();

			expect(screen.getByText("Enter the URL first.")).toBeInTheDocument();
			expect(channels.loadM3u).not.toHaveBeenCalled();
			expect(channels.loadXtream).not.toHaveBeenCalled();
		});

		it("adds a playlist by the typed name and URL, without the spaces around them", async () => {
			showAdd();
			typeInto(ADD, "Name", " Mine ");
			typeInto(ADD, "Playlist URL", " http://list.test ");

			expect(cursorTo(ADD, "Name")).toHaveTextContent("NameMine");
			expect(cursorTo(ADD, "Playlist URL")).toHaveTextContent("http://list.test");

			addProvider();
			await settle();

			expect(channels.loadM3u).toHaveBeenCalledExactlyOnceWith("Mine", "http://list.test");
			expect(channels.loadXtream).not.toHaveBeenCalled();
		});

		it("names a playlist for its type when no name was typed", async () => {
			showAdd();
			typeInto(ADD, "Playlist URL", "http://list.test");

			addProvider();
			await settle();

			expect(channels.loadM3u).toHaveBeenCalledExactlyOnceWith(
				"M3U Playlist",
				"http://list.test"
			);
		});

		it("adds an Xtream provider with its login as typed", async () => {
			showAdd();
			answer(ADD, "Type", "Xtream Codes");
			typeInto(ADD, "Name", "Mine");
			typeInto(ADD, "Server URL", "http://x.test");
			typeInto(ADD, "Username", " me ");
			typeInto(ADD, "Password", " pw ");

			expect(cursorTo(ADD, "Username")).toHaveTextContent("me");
			expect(cursorTo(ADD, "Password")).toHaveTextContent("PasswordSet");

			addProvider();
			await settle();

			expect(channels.loadXtream).toHaveBeenCalledExactlyOnceWith(
				"Mine",
				"http://x.test",
				" me ",
				" pw "
			);
			expect(channels.loadM3u).not.toHaveBeenCalled();
		});

		it("names an Xtream provider for its type when no name was typed", async () => {
			showAdd();
			answer(ADD, "Type", "Xtream Codes");
			typeInto(ADD, "Server URL", "http://x.test");

			addProvider();
			await settle();

			expect(channels.loadXtream).toHaveBeenCalledExactlyOnceWith(
				"Xtream Provider",
				"http://x.test",
				"",
				""
			);
		});

		it("shows a spinner while it adds, then empties the form", async () => {
			const loading = deferred<void>();
			channels.loadM3u.mockReturnValue(loading.promise);
			showAdd();
			answer(ADD, "Type", "Xtream Codes");
			answer(ADD, "Type", "M3U playlist");
			typeInto(ADD, "Name", "Mine");
			typeInto(ADD, "Playlist URL", "http://list.test");
			cursorTo(ADD, "Add provider");
			expect(spinner(ADD)).not.toBeInTheDocument();

			addProvider();

			expect(spinner(ADD)).toBeInTheDocument();

			loading.resolve();
			await settle();

			expect(spinner(ADD)).not.toBeInTheDocument();
			expect(firstLabels(ADD)).toEqual([
				"From another device",
				"TypeM3U playlist",
				"NameNot set",
				"Playlist URLNot set",
				"Add provider",
			]);
		});

		it("goes back to an M3U playlist after adding an Xtream provider", async () => {
			showAdd();
			answer(ADD, "Type", "Xtream Codes");
			typeInto(ADD, "Server URL", "http://x.test");

			addProvider();
			await settle();

			expect(sectionRows(ADD)).toEqual(["send", "type", "name", "url", "add"]);
		});

		it("says why adding failed, and keeps the form for another try", async () => {
			channels.loadM3u.mockRejectedValue("Not a playlist");
			showAdd();
			typeInto(ADD, "Playlist URL", "http://list.test");

			addProvider();
			await settle();

			expect(screen.getByText("Not a playlist")).toBeInTheDocument();
			expect(cursorTo(ADD, "Playlist URL")).toHaveTextContent("http://list.test");
		});
	});
});
