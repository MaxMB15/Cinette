// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { getVersion } from "@tauri-apps/api/app";
import { LEGAL_COPYRIGHT, LEGAL_CREDIT, LEGAL_LICENSE } from "@/components/settings/LegalNotices";
import {
	ALWAYS_WARNING,
	MODE_TEXT,
	NOT_STARTED,
	RESET_DONE,
	RESET_FAILED,
	SAVE_FAILED,
} from "@/hooks/useRemoteControlSettings";
import { openUrl } from "@/lib/openUrl";
import {
	readDefaultVolume,
	readHwdecEnabled,
	readLiveRewind,
	readSkipIntervals,
	readSkipSegmentModes,
} from "@/lib/player-prefs";
import {
	clearAllCaches,
	clearWatchHistory,
	getOmdbApiKey,
	getOpenSubtitlesApiKey,
	remoteDisconnect,
	remoteGetSettings,
	remoteOpen,
	remoteResetIdentity,
	remoteSetSettings,
	remoteUnblock,
	setOmdbApiKey,
	setOpenSubtitlesApiKey,
	testOmdbApiKey,
	testOpenSubtitlesApiKey,
	type RemoteSettings,
} from "@/lib/tauri";
import { makeProvider } from "@/test/app-fixtures";
import { deferred } from "@/test/deferred";
import { wrapperFor } from "@/test/query";
import { activeRow, column, cursorTo, enterText, pressOk } from "@/test/tv-columns";
import { TvSettings } from "./TvSettings";
import { TvSettingsColumns } from "./TvSettingsColumns";
import { TvNavContext } from "./tv-nav";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));
vi.mock("@/lib/openUrl", () => ({ openUrl: vi.fn() }));
vi.mock("@/lib/tauri", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/tauri")>()),
	clearAllCaches: vi.fn(),
	clearWatchHistory: vi.fn(),
	getOmdbApiKey: vi.fn(),
	getOpenSubtitlesApiKey: vi.fn(),
	remoteDisconnect: vi.fn(),
	remoteGetSettings: vi.fn(),
	remoteLocalNetworkDenied: vi.fn(() => Promise.resolve(false)),
	remoteOpen: vi.fn(),
	remoteResetIdentity: vi.fn(),
	remoteSetSettings: vi.fn(),
	remoteUnblock: vi.fn(),
	setOmdbApiKey: vi.fn(),
	setOpenSubtitlesApiKey: vi.fn(),
	testOmdbApiKey: vi.fn(),
	testOpenSubtitlesApiKey: vi.fn(),
}));

const devices = vi.hoisted(() => ({ sessions: [] as unknown[], blocked: [] as unknown[] }));
vi.mock("@/hooks/useRemoteTarget", () => ({
	useRemoteSessions: () => devices.sessions,
	useRemoteBlocked: () => devices.blocked,
}));

const limit = vi.hoisted(() => ({ text: null as string | null }));
vi.mock("@/lib/remote-devices", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/remote-devices")>()),
	discoveryLimit: () => limit.text,
}));

// The real screen, with a look at the rows it's given, whose ids show nowhere.
vi.mock("./TvSettingsColumns", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./TvSettingsColumns")>();
	return { ...actual, TvSettingsColumns: vi.fn(actual.TvSettingsColumns) };
});

const channels = vi.hoisted(() => ({ providers: [] as unknown[] }));
vi.mock("@/hooks/useChannels", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks/useChannels")>()),
	useChannels: () => channels,
}));

const REMOTE: RemoteSettings = {
	discoverable: true,
	remoteControl: "ask",
	deviceName: null,
	defaultName: "Android TV",
	deviceId: "own-id",
};

const UNAVAILABLE = "Remote control isn't available on this device yet.";

/** Lets every promise the screen is waiting on finish. */
const settle = () =>
	act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

const show = async () => {
	render(
		<TvNavContext.Provider
			value={{ section: "live", openSection: () => {}, memory: new Map() }}
		>
			<TvSettings />
		</TvNavContext.Provider>,
		{ wrapper: wrapperFor() }
	);
	await settle();
};

/** Shows the screen with the cursor on a section. */
const showSection = async (name: string) => {
	await show();
	cursorTo("App", name);
};

const button = (name: string) => screen.getByRole("button", { name });
const dialog = () => screen.queryByRole("dialog");
const back = () => fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
const rowLabels = (name: string) =>
	within(column(name))
		.getAllByRole("option")
		.map((row) => row.textContent);
const spinner = (name: string) => within(activeRow(name)).queryByLabelText("Working");

/** Presses OK on a row, then on one of the answers it offers. */
const answer = (name: string, label: string, choice: string) => {
	pressOk(name, label);
	pressOk("Choices", choice);
};

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	Element.prototype.scrollIntoView = () => {};
	channels.providers = [];
	devices.sessions = [];
	devices.blocked = [];
	limit.text = "Other devices can only find this one while you're using Cinette.";
	vi.mocked(getVersion).mockResolvedValue("1.2.3");
	vi.mocked(getOmdbApiKey).mockResolvedValue(null);
	vi.mocked(getOpenSubtitlesApiKey).mockResolvedValue(null);
	vi.mocked(setOmdbApiKey).mockResolvedValue(undefined);
	vi.mocked(setOpenSubtitlesApiKey).mockResolvedValue(undefined);
	vi.mocked(testOmdbApiKey).mockResolvedValue(true);
	vi.mocked(testOpenSubtitlesApiKey).mockResolvedValue(true);
	vi.mocked(remoteOpen).mockResolvedValue(undefined as never);
	vi.mocked(remoteGetSettings).mockResolvedValue(REMOTE);
	vi.mocked(remoteSetSettings).mockImplementation(async (change) => ({ ...REMOTE, ...change }));
	vi.mocked(remoteDisconnect).mockResolvedValue(undefined as never);
	vi.mocked(remoteUnblock).mockResolvedValue(undefined as never);
	vi.mocked(remoteResetIdentity).mockResolvedValue({
		deviceId: "new-id",
		defaultName: "Android TV",
	} as never);
	vi.mocked(clearWatchHistory).mockResolvedValue(undefined);
	vi.mocked(clearAllCaches).mockResolvedValue(undefined);
});

describe("TvSettings", () => {
	it("shows its title and sections, in order", async () => {
		await show();

		expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
		expect(rowLabels("Providers")).toEqual(["Add a provider"]);
		expect(rowLabels("App")).toEqual([
			"Playback",
			"Services",
			"Remote control",
			"History and cache",
			"About",
		]);
	});

	it("lists the providers first, with their channels, and the app's sections in a group under them", async () => {
		channels.providers = [
			makeProvider({ id: "a", name: "Home", channelCount: 1200 }),
			makeProvider({ id: "b", name: "Away", channelCount: 3 }),
		];
		await show();

		expect(rowLabels("Providers")).toEqual([
			`Home${(1200).toLocaleString()} channels`,
			"Away3 channels",
			"Add a provider",
		]);
		expect(rowLabels("App")[0]).toBe("Playback");
		const { groups } = vi.mocked(TvSettingsColumns).mock.lastCall![0];
		expect(groups.map((g) => g.label)).toEqual(["Providers", "App"]);
	});

	it("gives each of the app's sections an icon", async () => {
		await show();

		const { groups } = vi.mocked(TvSettingsColumns).mock.lastCall![0];
		expect(groups[1].sections.every((s) => s.icon)).toBe(true);
	});

	it("gives each section and row an id of its own, which keeps its place in the list", async () => {
		devices.sessions = [
			{ sessionId: "s1", name: "Phone", deviceType: "ios", deviceId: "d1", connected: true },
		];
		devices.blocked = [{ deviceId: "d2", name: "Tablet" }];
		vi.mocked(getOmdbApiKey).mockResolvedValue("key");
		await show();

		const sections = vi
			.mocked(TvSettingsColumns)
			.mock.lastCall![0].groups.flatMap((g) => g.sections);
		expect(sections.map((s) => [s.id, s.settings.map((row) => row.id)])).toEqual([
			["add", ["send", "type", "name", "url", "add"]],
			[
				"playback",
				[
					"hwdec",
					"volume",
					"skip-back",
					"skip-forward",
					"live-rewind",
					"openings",
					"endings",
				],
			],
			["services", ["omdb", "opensubtitles"]],
			["remote", ["discoverable", "mode", "name", "session/s1", "blocked/d2", "reset"]],
			["data", ["history", "caches"]],
			[
				"about",
				[
					"version",
					"License",
					"Additional terms",
					"Source code",
					"Third-party notices",
					"Privacy policy",
				],
			],
		]);
	});

	it("gives the rows that stand for no device ids of their own too", async () => {
		await show();

		const sections = vi
			.mocked(TvSettingsColumns)
			.mock.lastCall![0].groups.flatMap((g) => g.sections);
		expect(sections.find((s) => s.id === "remote")!.settings.map((row) => row.id)).toEqual([
			"discoverable",
			"mode",
			"name",
			"sessions",
			"blocked",
			"reset",
		]);
	});

	describe("Playback", () => {
		it("turns hardware decoding off and back on, and keeps the choice", async () => {
			await showSection("Playback");
			expect(cursorTo("Playback", "Hardware decoding")).toHaveTextContent("On");
			expect(screen.getByText(/green frames/)).toBeInTheDocument();

			pressOk("Playback", "Hardware decoding");

			expect(activeRow("Playback")).toHaveTextContent("Off");
			expect(readHwdecEnabled()).toBe(false);

			pressOk("Playback", "Hardware decoding");

			expect(activeRow("Playback")).toHaveTextContent("On");
			expect(readHwdecEnabled()).toBe(true);
		});

		it("offers the default volumes up to the most the player allows", async () => {
			await showSection("Playback");

			cursorTo("Playback", "Default volume");

			expect(rowLabels("Choices")).toEqual(["25%", "50%", "75%", "100%", "150%"]);
			expect(screen.getByText("Playback starts at this volume.")).toBeInTheDocument();
		});

		it("saves the default volume and shows it", async () => {
			await showSection("Playback");

			answer("Playback", "Default volume", "50%");

			expect(readDefaultVolume()).toBe(50);
			expect(cursorTo("Playback", "Default volume")).toHaveTextContent("50%");
			expect(activeRow("Choices")).toHaveTextContent("50%");
		});

		it.each([
			["Skip back", "back", /How far Left goes back/],
			["Skip forward", "forward", /How far Right goes forward/],
		] as const)("saves %s and shows it", async (label, direction, hint) => {
			await showSection("Playback");

			cursorTo("Playback", label);
			expect(screen.getByText(hint)).toBeInTheDocument();
			expect(rowLabels("Choices")).toEqual([
				"5 seconds",
				"10 seconds",
				"15 seconds",
				"30 seconds",
				"60 seconds",
			]);

			answer("Playback", label, "30 seconds");

			expect(readSkipIntervals()[direction]).toBe(30);
			expect(cursorTo("Playback", label)).toHaveTextContent("30 seconds");
		});

		it("saves how far back a live channel can go, five minutes unless changed", async () => {
			await showSection("Playback");

			expect(cursorTo("Playback", "Live rewind")).toHaveTextContent("5 min");
			expect(
				screen.getByText(/How far back you can go on a live channel/)
			).toBeInTheDocument();
			expect(rowLabels("Choices")).toEqual(["1 min", "2 min", "5 min", "10 min"]);

			answer("Playback", "Live rewind", "10 min");

			expect(readLiveRewind().minutes).toBe(10);
			expect(cursorTo("Playback", "Live rewind")).toHaveTextContent("10 min");
		});

		it.each([
			["Intros and recaps", "opening", "ending"],
			["Credits and previews", "ending", "opening"],
		] as const)("saves %s by itself and shows it", async (label, group, other) => {
			await showSection("Playback");

			cursorTo("Playback", label);
			expect(screen.getByText(/Skip times need an OMDb key/)).toBeInTheDocument();
			expect(rowLabels("Choices")).toEqual(["Skip button", "Automatic", "Off"]);

			answer("Playback", label, "Automatic");

			expect(readSkipSegmentModes()[group]).toBe("auto");
			expect(readSkipSegmentModes()[other]).toBe("button");
			expect(cursorTo("Playback", label)).toHaveTextContent("Automatic");
		});
	});

	describe("Services", () => {
		const row = () => activeRow("Services");

		it("says the OMDb key isn't set, what it's for and where to get one", async () => {
			await showSection("Services");

			expect(rowLabels("Services")).toEqual(["OMDb keyNot set"]);
			expect(screen.getByText(/Adds details and ratings/)).toBeInTheDocument();
			expect(screen.getByText("Get a free key at omdbapi.com")).toBeInTheDocument();
		});

		it("says a key is saved, and stops saying where to get one", async () => {
			vi.mocked(getOmdbApiKey).mockResolvedValue("saved-key");
			await showSection("Services");

			expect(row()).toHaveTextContent("OMDb keySaved");
			expect(screen.queryByText("Get a free key at omdbapi.com")).not.toBeInTheDocument();
		});

		it("offers OpenSubtitles once an OMDb key is saved", async () => {
			vi.mocked(getOmdbApiKey).mockResolvedValue("saved-key");
			await showSection("Services");

			expect(cursorTo("Services", "OpenSubtitles key")).toHaveTextContent("Not set");
			expect(screen.getByText(/Finds subtitles for movies/)).toBeInTheDocument();
			expect(screen.getByText("Get a key at opensubtitles.com")).toBeInTheDocument();
		});

		it("keeps OpenSubtitles when only its own key is saved", async () => {
			vi.mocked(getOpenSubtitlesApiKey).mockResolvedValue("saved-key");
			await showSection("Services");

			expect(cursorTo("Services", "OpenSubtitles key")).toHaveTextContent("Saved");
		});

		it("opens the keyboard on the saved key, named for the service", async () => {
			vi.mocked(getOmdbApiKey).mockResolvedValue("saved-key");
			await showSection("Services");

			pressOk("Services", "OMDb key");

			expect(screen.getByRole("textbox", { name: "OMDb API key" })).toHaveValue("saved-key");
		});

		it("saves the typed key and then checks it, saying what the check found", async () => {
			const saving = deferred<void>();
			vi.mocked(setOmdbApiKey).mockReturnValue(saving.promise);
			await showSection("Services");

			pressOk("Services", "OMDb key");
			enterText("OMDb API key", "new-key");

			expect(setOmdbApiKey).toHaveBeenCalledExactlyOnceWith("new-key");
			expect(testOmdbApiKey).not.toHaveBeenCalled();

			saving.resolve();
			await settle();

			expect(testOmdbApiKey).toHaveBeenCalledExactlyOnceWith("new-key");
			expect(row()).toHaveTextContent("OMDb keySaved");
			expect(screen.getByRole("status")).toHaveTextContent(
				"Valid key. Free keys allow 1,000 calls a day."
			);
		});

		it("says when the service turns the key down", async () => {
			vi.mocked(testOmdbApiKey).mockResolvedValue(false);
			await showSection("Services");

			pressOk("Services", "OMDb key");
			enterText("OMDb API key", "bad-key");
			await settle();

			expect(screen.getByRole("status")).toHaveTextContent("Invalid key");
		});

		it("saves and checks an OpenSubtitles key with its own calls, and no free plan note", async () => {
			vi.mocked(getOmdbApiKey).mockResolvedValue("saved-key");
			await showSection("Services");

			pressOk("Services", "OpenSubtitles key");
			enterText("OpenSubtitles API key", "subs-key");
			await settle();

			expect(setOpenSubtitlesApiKey).toHaveBeenCalledExactlyOnceWith("subs-key");
			expect(testOpenSubtitlesApiKey).toHaveBeenCalledExactlyOnceWith("subs-key");
			expect(setOmdbApiKey).not.toHaveBeenCalled();
			expect(screen.getByRole("status").textContent?.trim()).toBe("Valid key");
		});

		it.each([
			["cleared", ""],
			["left blank", "   "],
		])("removes a key that was %s, and doesn't check it", async (_name, typed) => {
			vi.mocked(getOmdbApiKey).mockResolvedValue("saved-key");
			await showSection("Services");

			pressOk("Services", "OMDb key");
			enterText("OMDb API key", typed);
			await settle();

			expect(setOmdbApiKey).toHaveBeenCalledExactlyOnceWith("");
			expect(testOmdbApiKey).not.toHaveBeenCalled();
			expect(cursorTo("Services", "OMDb key")).toHaveTextContent("Not set");
		});

		it("shows a spinner while the key saves and while it's checked, and not after", async () => {
			const saving = deferred<void>();
			const testing = deferred<boolean>();
			vi.mocked(setOmdbApiKey).mockReturnValue(saving.promise);
			vi.mocked(testOmdbApiKey).mockReturnValue(testing.promise);
			await showSection("Services");
			expect(spinner("Services")).not.toBeInTheDocument();

			pressOk("Services", "OMDb key");
			enterText("OMDb API key", "new-key");
			expect(spinner("Services")).toBeInTheDocument();

			saving.resolve();
			await settle();
			expect(spinner("Services")).toBeInTheDocument();

			testing.resolve(true);
			await settle();
			expect(spinner("Services")).not.toBeInTheDocument();
		});
	});

	describe("Remote control", () => {
		const SECTION = "Remote control";
		const hintOf = (text: RegExp) => screen.getByText(text);

		it("leaves the section out where remote control doesn't run", async () => {
			vi.mocked(remoteGetSettings).mockRejectedValue(UNAVAILABLE);
			await show();

			expect(rowLabels("App")).toEqual([
				"Playback",
				"Services",
				"History and cache",
				"About",
			]);
		});

		it("says so, with no rows, when remote control didn't start", async () => {
			vi.mocked(remoteGetSettings).mockRejectedValue("broken");
			await showSection(SECTION);

			expect(screen.getByRole("status")).toHaveTextContent(NOT_STARTED);
			expect(within(column(SECTION)).queryAllByRole("option")).toEqual([]);
		});

		it("has no status line while there's nothing to say", async () => {
			await showSection(SECTION);

			expect(screen.queryByRole("status")).not.toBeInTheDocument();
		});

		it("says what discoverable means and when others can find the TV", async () => {
			await showSection(SECTION);

			expect(activeRow(SECTION)).toHaveTextContent("Discoverable on this networkOn");
			expect(hintOf(/Lets other Cinette devices/).textContent).toMatch(
				/disconnect them\. Other devices can only find this one while you're using Cinette\.$/
			);
		});

		it("adds nothing to what discoverable means when there's no limit", async () => {
			limit.text = null;
			await showSection(SECTION);

			expect(hintOf(/Lets other Cinette devices/).textContent).toMatch(/disconnect them\.$/);
		});

		it("saves turning discoverable off and shows it", async () => {
			await showSection(SECTION);

			pressOk(SECTION, "Discoverable on this network");
			await settle();

			expect(remoteSetSettings).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ discoverable: false })
			);
			expect(activeRow(SECTION)).toHaveTextContent("Off");
		});

		it("says so when a change couldn't be saved", async () => {
			vi.mocked(remoteSetSettings).mockRejectedValue("no");
			await showSection(SECTION);

			pressOk(SECTION, "Discoverable on this network");
			await settle();

			expect(screen.getByRole("status")).toHaveTextContent(SAVE_FAILED);
		});

		it("offers who may control the TV, starting on the current answer", async () => {
			await showSection(SECTION);

			expect(cursorTo(SECTION, "Remote control")).toHaveTextContent("Only when allowed");

			expect(rowLabels("Choices")).toEqual([
				"Always allow",
				"Only when allowed",
				"Never allow",
			]);
			expect(activeRow("Choices")).toHaveTextContent("Only when allowed");
			expect(within(column("Choices")).getAllByLabelText("Chosen")).toHaveLength(1);
			expect(within(activeRow("Choices")).getByLabelText("Chosen")).toBeInTheDocument();
		});

		it("says what each answer means as the cursor reaches it", async () => {
			await showSection(SECTION);
			cursorTo(SECTION, "Remote control");

			expect(screen.getByText(MODE_TEXT.ask)).toBeInTheDocument();

			cursorTo("Choices", "Always allow");
			expect(screen.getByText(MODE_TEXT.always)).toBeInTheDocument();

			cursorTo("Choices", "Never allow");
			expect(screen.getByText(MODE_TEXT.never)).toBeInTheDocument();
		});

		it("saves Never allow straight away", async () => {
			await showSection(SECTION);

			answer(SECTION, "Remote control", "Never allow");
			await settle();

			expect(remoteSetSettings).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ remoteControl: "never" })
			);
			expect(dialog()).not.toBeInTheDocument();
			expect(cursorTo(SECTION, "Remote control")).toHaveTextContent("Never allow");
		});

		it("warns before Always allow, with Cancel under the cursor", async () => {
			await showSection(SECTION);

			answer(SECTION, "Remote control", "Always allow");

			expect(
				screen.getByRole("dialog", { name: "Always allow remote control?" })
			).toBeInTheDocument();
			expect(screen.getByText(ALWAYS_WARNING)).toBeInTheDocument();
			expect(button("Cancel")).toHaveFocus();
			expect(remoteSetSettings).not.toHaveBeenCalled();
		});

		it("saves nothing when the warning is cancelled", async () => {
			await showSection(SECTION);

			answer(SECTION, "Remote control", "Always allow");
			fireEvent.click(button("Cancel"));

			expect(dialog()).not.toBeInTheDocument();
			expect(remoteSetSettings).not.toHaveBeenCalled();
		});

		it("saves nothing when Back leaves the warning", async () => {
			await showSection(SECTION);

			answer(SECTION, "Remote control", "Always allow");
			back();

			expect(dialog()).not.toBeInTheDocument();
			expect(remoteSetSettings).not.toHaveBeenCalled();
		});

		it("saves Always allow once the warning is accepted", async () => {
			await showSection(SECTION);

			answer(SECTION, "Remote control", "Always allow");
			fireEvent.click(button("Always allow"));
			await settle();

			expect(dialog()).not.toBeInTheDocument();
			expect(remoteSetSettings).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ remoteControl: "always" })
			);
		});

		it("names the TV by its default until it's given a name", async () => {
			await showSection(SECTION);

			expect(cursorTo(SECTION, "Device name")).toHaveTextContent("Android TV");
			expect(hintOf(/What other devices call this one\./)).toBeInTheDocument();

			pressOk(SECTION, "Device name");

			expect(screen.getByRole("textbox", { name: "Device name" })).toHaveValue("Android TV");
		});

		it("shows the name it was given, and types from it", async () => {
			vi.mocked(remoteGetSettings).mockResolvedValue({ ...REMOTE, deviceName: "Den" });
			await showSection(SECTION);

			expect(cursorTo(SECTION, "Device name")).toHaveTextContent("Den");

			pressOk(SECTION, "Device name");

			expect(screen.getByRole("textbox", { name: "Device name" })).toHaveValue("Den");
		});

		it("saves the typed name", async () => {
			await showSection(SECTION);

			pressOk(SECTION, "Device name");
			enterText("Device name", "Lounge");
			await settle();

			expect(remoteSetSettings).toHaveBeenCalledExactlyOnceWith(
				expect.objectContaining({ deviceName: "Lounge" })
			);
			expect(cursorTo(SECTION, "Device name")).toHaveTextContent("Lounge");
		});

		it("says when no device is connected or blocked", async () => {
			await showSection(SECTION);

			expect(cursorTo(SECTION, "Connected devices")).toHaveTextContent("None");
			expect(hintOf(/No device is controlling this one\./)).toBeInTheDocument();

			expect(cursorTo(SECTION, "Blocked devices")).toHaveTextContent("None");
			expect(hintOf(/No device is blocked\./)).toBeInTheDocument();
		});

		it("lists a connected device in place of that, and OK disconnects it", async () => {
			devices.sessions = [
				{
					sessionId: "s1",
					name: "Phone",
					deviceType: "ios",
					deviceId: "d1abcdefgh",
					connected: true,
				},
			];
			await showSection(SECTION);

			expect(rowLabels(SECTION)).not.toContain("Connected devicesNone");
			expect(cursorTo(SECTION, "Phone")).toHaveTextContent("Disconnect");
			expect(hintOf(/^Connected: Phone · /)).toBeInTheDocument();

			pressOk(SECTION, "Phone");

			expect(remoteDisconnect).toHaveBeenCalledExactlyOnceWith("s1");
		});

		it("lists a blocked device in place of that, and OK unblocks it", async () => {
			devices.blocked = [{ deviceId: "d2abcdefgh", name: "Tablet" }];
			await showSection(SECTION);

			expect(rowLabels(SECTION)).not.toContain("Blocked devicesNone");
			expect(cursorTo(SECTION, "Tablet")).toHaveTextContent("Unblock");
			expect(hintOf(/^Blocked: Tablet · ID d2abcd$/)).toBeInTheDocument();

			pressOk(SECTION, "Tablet");

			expect(remoteUnblock).toHaveBeenCalledExactlyOnceWith("d2abcdefgh");
		});

		it("asks before resetting the device identity", async () => {
			await showSection(SECTION);

			cursorTo(SECTION, "Reset device identity");
			expect(hintOf(/Other devices see this one as new, and every/)).toBeInTheDocument();

			pressOk(SECTION, "Reset device identity");

			expect(
				screen.getByRole("dialog", { name: "Reset device identity?" })
			).toBeInTheDocument();
			expect(screen.getByText(/Every device controlling this one/)).toBeInTheDocument();
			expect(button("Cancel")).toHaveFocus();
			expect(remoteResetIdentity).not.toHaveBeenCalled();
		});

		it("resets the identity once it's confirmed, and says so", async () => {
			await showSection(SECTION);

			pressOk(SECTION, "Reset device identity");
			fireEvent.click(button("Reset"));
			await settle();

			expect(remoteResetIdentity).toHaveBeenCalledOnce();
			expect(screen.getByRole("status")).toHaveTextContent(RESET_DONE);
		});

		it("says when the identity couldn't be reset", async () => {
			vi.mocked(remoteResetIdentity).mockRejectedValue("no");
			await showSection(SECTION);

			pressOk(SECTION, "Reset device identity");
			fireEvent.click(button("Reset"));
			await settle();

			expect(screen.getByRole("status")).toHaveTextContent(RESET_FAILED);
		});
	});

	describe("History and cache", () => {
		const SECTION = "History and cache";

		it.each([
			["Clear watch history", /This can't be undone\./, clearWatchHistory, clearAllCaches],
			["Clear caches", /cached movie and series details/, clearAllCaches, clearWatchHistory],
		])("asks before %s, and clears nothing on Cancel", async (label, message, clear, other) => {
			await showSection(SECTION);

			pressOk(SECTION, label);

			expect(screen.getByRole("dialog", { name: `${label}?` })).toBeInTheDocument();
			expect(screen.getByText(message)).toBeInTheDocument();
			expect(button("Cancel")).toHaveFocus();

			fireEvent.click(button("Cancel"));

			expect(clear).not.toHaveBeenCalled();
			expect(other).not.toHaveBeenCalled();
		});

		it.each([
			["Clear watch history", "Watch history cleared.", clearWatchHistory, clearAllCaches],
			["Clear caches", "Caches cleared.", clearAllCaches, clearWatchHistory],
		])("runs %s once confirmed, and says it's done", async (label, done, clear, other) => {
			await showSection(SECTION);

			pressOk(SECTION, label);
			fireEvent.click(button("Clear"));
			await settle();

			expect(clear).toHaveBeenCalledOnce();
			expect(other).not.toHaveBeenCalled();
			expect(cursorTo(SECTION, label)).toBeInTheDocument();
			expect(screen.getByText(done)).toBeInTheDocument();
		});

		it.each([
			[
				"Clear watch history",
				"Couldn't clear the watch history. Try again.",
				clearWatchHistory,
			],
			["Clear caches", "Couldn't clear the caches. Try again.", clearAllCaches],
		])("says when %s fails", async (label, failed, clear) => {
			vi.mocked(clear).mockRejectedValue("no");
			await showSection(SECTION);

			pressOk(SECTION, label);
			fireEvent.click(button("Clear"));
			await settle();

			expect(screen.getByText(failed)).toBeInTheDocument();
		});

		it("shows a spinner while it clears", async () => {
			const clearing = deferred<void>();
			vi.mocked(clearWatchHistory).mockReturnValue(clearing.promise);
			await showSection(SECTION);
			expect(spinner(SECTION)).not.toBeInTheDocument();

			pressOk(SECTION, "Clear watch history");
			fireEvent.click(button("Clear"));

			expect(spinner(SECTION)).toBeInTheDocument();

			clearing.resolve();
			await settle();

			expect(spinner(SECTION)).not.toBeInTheDocument();
		});
	});

	describe("About", () => {
		const hrefs = () =>
			[
				"License",
				"Additional terms",
				"Source code",
				"Third-party notices",
				"Privacy policy",
			].map((label) => {
				cursorTo("About", label);
				return screen.getByText(/^https:/).textContent;
			});

		it("shows the credit NOTICE requires, the copyright and the license", async () => {
			await showSection("About");

			expect(screen.getByText(LEGAL_CREDIT)).toBeInTheDocument();
			expect(screen.getByText(LEGAL_COPYRIGHT)).toBeInTheDocument();
			expect(screen.getByText(LEGAL_LICENSE)).toBeInTheDocument();
		});

		it("keeps the credit in view on every row", async () => {
			await showSection("About");

			cursorTo("About", "Privacy policy");

			expect(screen.getByText(LEGAL_CREDIT)).toBeInTheDocument();
		});

		it("shows the app's version", async () => {
			await showSection("About");

			expect(activeRow("About")).toHaveTextContent("Version1.2.3");
		});

		it("shows no version when it can't be read, and links to main", async () => {
			vi.mocked(getVersion).mockRejectedValue("no");
			await showSection("About");

			expect(activeRow("About").textContent).toBe("Version");
			expect(hrefs()[0]).toBe("https://github.com/MaxMB15/Cinette/blob/main/LICENSE");
		});

		it("shows each link's address, at this version's tag", async () => {
			await showSection("About");

			expect(hrefs()).toEqual([
				"https://github.com/MaxMB15/Cinette/blob/v1.2.3/LICENSE",
				"https://github.com/MaxMB15/Cinette/blob/v1.2.3/NOTICE",
				"https://github.com/MaxMB15/Cinette/tree/v1.2.3",
				"https://github.com/MaxMB15/Cinette/blob/v1.2.3/THIRD_PARTY_NOTICES.md",
				"https://github.com/MaxMB15/Cinette/blob/main/docs/privacy.md",
			]);
		});

		it("opens nothing with OK on a link, which could leave the TV's page with no way back", async () => {
			await showSection("About");

			pressOk("About", "License");
			pressOk("About", "Privacy policy");

			expect(openUrl).not.toHaveBeenCalled();
			expect(dialog()).not.toBeInTheDocument();
		});
	});
});
