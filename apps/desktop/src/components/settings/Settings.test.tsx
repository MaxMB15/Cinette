// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getVersion } from "@tauri-apps/api/app";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { rememberHasOmdbKey } from "@/hooks/useHasOmdbKey";
import { OMDB_KEY_FOCUS } from "@/hooks/useScrollToOmdbKey";
import type { UpdateState } from "@/hooks/useUpdateChecker";
import { openUrl } from "@/lib/openUrl";
import { DONATION_LAST_SHOWN_KEY } from "@/lib/storage";
import {
	clearAllCaches,
	clearWatchHistory,
	countDownloadsDue,
	getDownloadConcurrency,
	getDownloadFolder,
	getGeminiApiKey,
	getOmdbApiKey,
	getOpenSubtitlesApiKey,
	setDownloadConcurrency,
	setDownloadFolder,
	setGeminiApiKey,
	setOmdbApiKey,
	setOpenSubtitlesApiKey,
	testGeminiApiKey,
	testOmdbApiKey,
	testOpenSubtitlesApiKey,
} from "@/lib/tauri";
import type { LayoutMode, Platform } from "@/lib/types";
import { fakeUpdate, makeUpdateState } from "@/test/app-fixtures";
import { REPO_URL } from "./LegalNotices";
import { Settings } from "./Settings";

const device = vi.hoisted(() => ({
	platform: "macos" as Platform,
	layoutMode: "desktop" as LayoutMode,
}));

const downloads = vi.hoisted(() => ({
	retentionDays: null as number | null,
	setRetentionDays: vi.fn(),
}));

vi.mock("@/lib/tauri", () => ({
	getOmdbApiKey: vi.fn(),
	setOmdbApiKey: vi.fn(),
	testOmdbApiKey: vi.fn(),
	clearWatchHistory: vi.fn(),
	getOpenSubtitlesApiKey: vi.fn(),
	setOpenSubtitlesApiKey: vi.fn(),
	testOpenSubtitlesApiKey: vi.fn(),
	getGeminiApiKey: vi.fn(),
	setGeminiApiKey: vi.fn(),
	testGeminiApiKey: vi.fn(),
	clearAllCaches: vi.fn(),
	getDownloadFolder: vi.fn(),
	setDownloadFolder: vi.fn(),
	getDownloadConcurrency: vi.fn(),
	setDownloadConcurrency: vi.fn(),
	countDownloadsDue: vi.fn(),
}));

vi.mock("@tauri-apps/api/app", () => ({ getVersion: vi.fn() }));

vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), open: vi.fn() }));

vi.mock("@/lib/openUrl", () => ({ openUrl: vi.fn() }));

vi.mock("@/hooks/useHasOmdbKey", () => ({ rememberHasOmdbKey: vi.fn() }));

vi.mock("@/hooks/usePlatform", () => ({
	usePlatform: () => ({ platform: device.platform, layoutMode: device.layoutMode }),
}));

vi.mock("@/hooks/useDownloads", () => ({
	useDownloads: () => ({
		downloads: [],
		retentionDays: downloads.retentionDays,
		setRetentionDays: downloads.setRetentionDays,
	}),
}));

interface RenderOptions {
	update?: UpdateState;
	routeState?: unknown;
}

/** Renders Settings and lets the saved settings load. */
const renderSettings = async ({
	update = makeUpdateState(),
	routeState = null,
}: RenderOptions = {}) => {
	const view = render(
		<MemoryRouter initialEntries={[{ pathname: "/settings", state: routeState }]}>
			<Settings updateState={update} />
		</MemoryRouter>
	);
	await act(async () => {});
	return view;
};

/** Clicks and lets the work the click starts finish. */
const click = async (element: HTMLElement) => {
	await act(async () => {
		fireEvent.click(element);
	});
};

const typeInto = (input: HTMLElement, value: string) => {
	fireEvent.change(input, { target: { value } });
};

/** Opens the dropdown called `name` and picks `option`. */
const choose = async (name: string, option: string) => {
	fireEvent.click(screen.getByRole("button", { name }));
	const list = screen.getByRole("listbox", { name });
	await click(within(list).getByRole("option", { name: option }));
};

/** Queries inside the block that a title such as "Download folder" starts. */
const block = (title: string) => within(screen.getByText(title).parentElement as HTMLElement);

/** Queries inside the card headed `title`. */
const card = (title: string) =>
	within(
		screen.getByRole("heading", { name: title }).parentElement?.parentElement as HTMLElement
	);

type KeyName = "Gemini" | "OMDb" | "OpenSubtitles";

const keyInput = (name: KeyName) => screen.getByLabelText(`${name} API key`);

/** Queries inside the key field for `name`, for the parts that don't say whose they are. */
const keyField = (name: KeyName) => within(keyInput(name).closest("form") as HTMLElement);

/** A key field's Save, Remove or Test button, while it says which key it's for. */
const keyButton = (name: KeyName, action: "Save" | "Remove" | "Test") =>
	screen.getByRole("button", { name: `${action} ${name} API key` });

const folderInput = () => screen.getByPlaceholderText("/path/to/downloads");

const concurrencyInput = () => screen.getByLabelText("Simultaneous downloads");

const advance = (ms: number) => {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
};

beforeEach(() => {
	vi.resetAllMocks();
	localStorage.clear();
	sessionStorage.clear();
	device.platform = "macos";
	device.layoutMode = "desktop";
	downloads.retentionDays = null;
	downloads.setRetentionDays.mockResolvedValue(0);

	vi.mocked(getVersion).mockResolvedValue("1.2.3");
	vi.mocked(getOmdbApiKey).mockResolvedValue(null);
	vi.mocked(getOpenSubtitlesApiKey).mockResolvedValue(null);
	vi.mocked(getGeminiApiKey).mockResolvedValue(null);
	vi.mocked(getDownloadFolder).mockResolvedValue("/Users/test/Movies");
	vi.mocked(getDownloadConcurrency).mockResolvedValue(4);
	vi.mocked(setOmdbApiKey).mockResolvedValue(undefined);
	vi.mocked(setOpenSubtitlesApiKey).mockResolvedValue(undefined);
	vi.mocked(setGeminiApiKey).mockResolvedValue(undefined);
	vi.mocked(testOmdbApiKey).mockResolvedValue(true);
	vi.mocked(testOpenSubtitlesApiKey).mockResolvedValue(true);
	vi.mocked(testGeminiApiKey).mockResolvedValue(true);
	vi.mocked(setDownloadFolder).mockResolvedValue(undefined);
	vi.mocked(setDownloadConcurrency).mockResolvedValue(undefined);
	vi.mocked(clearWatchHistory).mockResolvedValue(undefined);
	vi.mocked(clearAllCaches).mockResolvedValue(undefined);
	vi.mocked(countDownloadsDue).mockResolvedValue(0);
});

afterEach(() => {
	vi.useRealTimers();
	delete (Element.prototype as Partial<Element>).scrollIntoView;
});

describe("Settings when it opens", () => {
	it("fills in the saved keys, download folder, download count and version", async () => {
		vi.mocked(getOmdbApiKey).mockResolvedValue("omdb-test-key");
		vi.mocked(getOpenSubtitlesApiKey).mockResolvedValue("subs-test-key");
		vi.mocked(getGeminiApiKey).mockResolvedValue("gemini-test-key");
		await renderSettings();

		expect(keyInput("OMDb")).toHaveValue("omdb-test-key");
		expect(keyInput("OpenSubtitles")).toHaveValue("subs-test-key");
		expect(keyInput("Gemini")).toHaveValue("gemini-test-key");
		expect(folderInput()).toHaveValue("/Users/test/Movies");
		expect(concurrencyInput()).toHaveValue(4);
		expect(screen.getByText("Max Video Player v1.2.3")).toBeInTheDocument();
		expect(screen.queryByRole("link", { name: /^Get a/ })).toBeNull();
		expect(rememberHasOmdbKey).not.toHaveBeenCalled();
	});

	it("says where to get each key and leaves out the services that need OMDb while no key is saved", async () => {
		await renderSettings();

		expect(screen.getByRole("link", { name: "Get a free key at omdbapi.com" })).toHaveAttribute(
			"href",
			"https://www.omdbapi.com/apikey.aspx"
		);
		expect(
			screen.getByRole("link", { name: "Get a key at aistudio.google.com" })
		).toHaveAttribute("href", "https://aistudio.google.com/apikey");
		expect(screen.queryByLabelText("OpenSubtitles API key")).toBeNull();
		expect(screen.queryByText("Uses your OMDb key")).toBeNull();
		expect(keyButton("OMDb", "Save")).toBeDisabled();
		expect(keyButton("OMDb", "Test")).toBeDisabled();
	});

	it("still opens when the version, Gemini key, folder and download count can't be read", async () => {
		vi.mocked(getVersion).mockRejectedValue(new Error("no app"));
		vi.mocked(getGeminiApiKey).mockRejectedValue(new Error("store"));
		vi.mocked(getDownloadFolder).mockRejectedValue(new Error("store"));
		vi.mocked(getDownloadConcurrency).mockRejectedValue(new Error("store"));
		await renderSettings();

		expect(screen.getByText("Max Video Player")).toBeInTheDocument();
		expect(keyInput("Gemini")).toHaveValue("");
		expect(keyField("Gemini").getByRole("status")).toHaveTextContent(
			"Couldn't read the saved key"
		);
		expect(folderInput()).toHaveValue("");
		expect(concurrencyInput()).toHaveValue(3);
	});

	it("links the legal notices to the running version", async () => {
		await renderSettings();
		fireEvent.click(screen.getByRole("button", { name: "Source code" }));
		expect(openUrl).toHaveBeenCalledExactlyOnceWith(`${REPO_URL}/tree/v1.2.3`);
	});

	it("links the legal notices to main while the version is unknown", async () => {
		vi.mocked(getVersion).mockRejectedValue(new Error("no app"));
		await renderSettings();
		fireEvent.click(screen.getByRole("button", { name: "License" }));
		expect(openUrl).toHaveBeenCalledExactlyOnceWith(`${REPO_URL}/blob/main/LICENSE`);
	});

	it("scrolls to the OMDb key field and focuses it when an info sheet asks for it", async () => {
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		await renderSettings({ routeState: OMDB_KEY_FOCUS });

		const input = keyInput("OMDb");
		expect(input).toHaveFocus();
		expect(scrollIntoView).toHaveBeenCalledOnce();
		expect(scrollIntoView.mock.contexts[0]).toBe(input);
	});
});

// The field itself is tested in ApiKeyField.test.tsx and the saving and
// checking in useApiKey.test.ts. These check that each field talks to its
// own service.
const services = [
	{ name: "Gemini", load: getGeminiApiKey, save: setGeminiApiKey, test: testGeminiApiKey },
	{ name: "OMDb", load: getOmdbApiKey, save: setOmdbApiKey, test: testOmdbApiKey },
	{
		name: "OpenSubtitles",
		load: getOpenSubtitlesApiKey,
		save: setOpenSubtitlesApiKey,
		test: testOpenSubtitlesApiKey,
	},
] as const;

describe.each(services)("Settings $name key", ({ name, load, save, test }) => {
	const others = services.filter((s) => s.name !== name);

	it("loads, checks and saves the key with its own service", async () => {
		vi.mocked(load).mockResolvedValue("saved-key");
		await renderSettings();
		expect(keyInput(name)).toHaveValue("saved-key");

		typeInto(keyInput(name), "new-key");
		await click(keyButton(name, "Test"));
		expect(test).toHaveBeenCalledExactlyOnceWith("new-key");
		expect(keyField(name).getByRole("status")).toHaveTextContent(/^Valid key/);

		await click(keyButton(name, "Save"));
		expect(save).toHaveBeenCalledExactlyOnceWith("new-key");
		expect(keyField(name).getByRole("button", { name: "Saved" })).toBeInTheDocument();

		for (const other of others) {
			expect(other.test).not.toHaveBeenCalled();
			expect(other.save).not.toHaveBeenCalled();
		}
	});

	it("removes the key when the field is cleared and saved", async () => {
		vi.mocked(load).mockResolvedValue("saved-key");
		await renderSettings();
		typeInto(keyInput(name), "");
		await click(keyButton(name, "Remove"));

		expect(save).toHaveBeenCalledExactlyOnceWith("");
		expect(keyField(name).getByRole("button", { name: "Removed" })).toBeInTheDocument();
	});

	it("shows and hides the key without touching the others", async () => {
		vi.mocked(getOmdbApiKey).mockResolvedValue("omdb-test-key");
		await renderSettings();

		fireEvent.click(screen.getByRole("button", { name: `Show ${name} API key` }));
		expect(keyInput(name)).toHaveAttribute("type", "text");
		for (const other of others) {
			expect(keyInput(other.name)).toHaveAttribute("type", "password");
		}
	});
});

describe("Settings OMDb key", () => {
	it("tells the info sheets when a key is saved or removed", async () => {
		await renderSettings();
		typeInto(keyInput("OMDb"), "omdb-test-key");
		await click(keyButton("OMDb", "Save"));
		expect(rememberHasOmdbKey).toHaveBeenLastCalledWith(true);

		typeInto(keyInput("OMDb"), "");
		await click(keyButton("OMDb", "Remove"));
		expect(rememberHasOmdbKey).toHaveBeenLastCalledWith(false);
		expect(rememberHasOmdbKey).toHaveBeenCalledTimes(2);
	});

	it("says when the key can't be saved and leaves the info sheets alone", async () => {
		vi.mocked(setOmdbApiKey).mockRejectedValue(new Error("disk full"));
		await renderSettings();
		typeInto(keyInput("OMDb"), "omdb-test-key");
		await click(keyButton("OMDb", "Save"));

		expect(keyField("OMDb").getByRole("status")).toHaveTextContent(
			"Couldn't save the key. Try again."
		);
		expect(rememberHasOmdbKey).not.toHaveBeenCalled();
	});

	it("mentions the free plan's daily limit next to a valid key", async () => {
		await renderSettings();
		typeInto(keyInput("OMDb"), "omdb-test-key");
		await click(keyButton("OMDb", "Test"));

		expect(keyField("OMDb").getByRole("status")).toHaveTextContent(
			"Valid key. Free keys allow 1,000 calls a day."
		);
	});
});

describe("Settings OpenSubtitles key", () => {
	it("appears once an OMDb key is saved, not while one is typed", async () => {
		await renderSettings();
		typeInto(keyInput("OMDb"), "omdb-test-key");
		expect(screen.queryByLabelText("OpenSubtitles API key")).toBeNull();

		await click(keyButton("OMDb", "Save"));
		expect(keyInput("OpenSubtitles")).toHaveValue("");
		expect(screen.getByText("Uses your OMDb key")).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Get a key at opensubtitles.com" })
		).toHaveAttribute("href", "https://www.opensubtitles.com/consumers");
	});

	it("shows a saved key while no OMDb key is saved, so it can be removed", async () => {
		vi.mocked(getOpenSubtitlesApiKey).mockResolvedValue("subs-test-key");
		await renderSettings();
		expect(keyInput("OpenSubtitles")).toHaveValue("subs-test-key");
	});

	it("stays, with focus on its button, when its own key is removed", async () => {
		vi.mocked(getOpenSubtitlesApiKey).mockResolvedValue("subs-test-key");
		await renderSettings();
		typeInto(keyInput("OpenSubtitles"), "");
		const remove = keyButton("OpenSubtitles", "Remove");
		remove.focus();
		await click(remove);

		expect(keyField("OpenSubtitles").getByRole("button", { name: "Removed" })).toHaveFocus();
	});

	it("stays when the OMDb key is removed", async () => {
		vi.mocked(getOmdbApiKey).mockResolvedValue("omdb-test-key");
		await renderSettings();
		typeInto(keyInput("OMDb"), "");
		await click(keyButton("OMDb", "Remove"));

		expect(keyInput("OpenSubtitles")).toBeInTheDocument();
	});
});

describe("Settings playback", () => {
	it("turns hardware decoding off and on and keeps the choice", async () => {
		await renderSettings();
		const toggle = screen.getByRole("button", { name: "Hardware decoding" });
		expect(toggle).toHaveAttribute("aria-pressed", "true");
		expect(toggle).toHaveTextContent("On");

		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-pressed", "false");
		expect(toggle).toHaveTextContent("Off");
		expect(localStorage.getItem("mvp_hwdec")).toBe("off");

		fireEvent.click(toggle);
		expect(toggle).toHaveTextContent("On");
		expect(localStorage.getItem("mvp_hwdec")).toBe("on");
	});

	it("starts with hardware decoding off when it was turned off before", async () => {
		localStorage.setItem("mvp_hwdec", "off");
		await renderSettings();
		expect(screen.getByRole("button", { name: "Hardware decoding" })).toHaveAttribute(
			"aria-pressed",
			"false"
		);
	});

	it("shows the saved default volume and saves a new one for the next stream", async () => {
		localStorage.setItem("mvp_default_volume", "80");
		sessionStorage.setItem("mvp_volume", JSON.stringify({ volume: 40, preMute: 40 }));
		await renderSettings();
		const slider = screen.getByRole("slider", { name: "Default volume" });
		expect(slider).toHaveAttribute("aria-valuenow", "80");
		expect(slider).toHaveAttribute("aria-valuetext", "80%");
		expect(screen.getByText("80%")).toBeInTheDocument();

		fireEvent.keyDown(slider, { key: "ArrowRight" });
		expect(slider).toHaveAttribute("aria-valuenow", "85");
		expect(screen.getByText("85%")).toBeInTheDocument();
		expect(localStorage.getItem("mvp_default_volume")).toBe("85");
		expect(sessionStorage.getItem("mvp_volume")).toBeNull();
	});

	it("lets the default volume go up to 150 percent", async () => {
		await renderSettings();
		const slider = screen.getByRole("slider", { name: "Default volume" });
		expect(slider).toHaveAttribute("aria-valuenow", "100");

		fireEvent.keyDown(slider, { key: "End" });
		expect(slider).toHaveAttribute("aria-valuenow", "150");
		expect(localStorage.getItem("mvp_default_volume")).toBe("150");
	});

	it("shows the skip lengths and skip modes saved before", async () => {
		localStorage.setItem("mvp_skip_back", "5");
		localStorage.setItem("mvp_skip_forward", "60");
		localStorage.setItem("mvp_skip_opening", "auto");
		localStorage.setItem("mvp_skip_ending", "off");
		await renderSettings();

		expect(screen.getByRole("button", { name: "Skip back" })).toHaveTextContent("5 seconds");
		expect(screen.getByRole("button", { name: "Skip forward" })).toHaveTextContent(
			"60 seconds"
		);
		expect(screen.getByRole("button", { name: "Intros and recaps" })).toHaveTextContent(
			"Automatic"
		);
		expect(screen.getByRole("button", { name: "Credits and previews" })).toHaveTextContent(
			"Off"
		);
	});

	it("saves each skip length on its own and shows the new one", async () => {
		await renderSettings();
		expect(screen.getByRole("button", { name: "Skip back" })).toHaveTextContent("10 seconds");
		expect(screen.getByRole("button", { name: "Skip forward" })).toHaveTextContent(
			"10 seconds"
		);

		await choose("Skip back", "30 seconds");
		expect(localStorage.getItem("mvp_skip_back")).toBe("30");
		expect(localStorage.getItem("mvp_skip_forward")).toBeNull();
		expect(screen.getByRole("button", { name: "Skip back" })).toHaveTextContent("30 seconds");
		expect(screen.queryByRole("listbox")).toBeNull();

		await choose("Skip forward", "5 seconds");
		expect(localStorage.getItem("mvp_skip_forward")).toBe("5");
		expect(screen.getByRole("button", { name: "Skip forward" })).toHaveTextContent("5 seconds");
		expect(screen.getByRole("button", { name: "Skip back" })).toHaveTextContent("30 seconds");
	});

	it("saves how intros and credits are skipped", async () => {
		await renderSettings();
		expect(screen.getByRole("button", { name: "Intros and recaps" })).toHaveTextContent(
			"Skip button"
		);
		expect(screen.getByRole("button", { name: "Credits and previews" })).toHaveTextContent(
			"Skip button"
		);

		await choose("Intros and recaps", "Automatic");
		expect(localStorage.getItem("mvp_skip_opening")).toBe("auto");
		expect(localStorage.getItem("mvp_skip_ending")).toBeNull();
		expect(screen.getByRole("button", { name: "Intros and recaps" })).toHaveTextContent(
			"Automatic"
		);

		await choose("Credits and previews", "Off");
		expect(localStorage.getItem("mvp_skip_ending")).toBe("off");
		expect(screen.getByRole("button", { name: "Credits and previews" })).toHaveTextContent(
			"Off"
		);
		expect(screen.getByRole("button", { name: "Intros and recaps" })).toHaveTextContent(
			"Automatic"
		);
	});

	it("opens SkipDB and IntroDB in the browser", async () => {
		await renderSettings();
		fireEvent.click(screen.getByRole("button", { name: "SkipDB" }));
		expect(openUrl).toHaveBeenLastCalledWith("https://skipdb.tv");
		fireEvent.click(screen.getByRole("button", { name: "IntroDB" }));
		expect(openUrl).toHaveBeenLastCalledWith("https://introdb.app");
		expect(openUrl).toHaveBeenCalledTimes(2);
	});
});

describe("Settings download folder", () => {
	it("picks a folder with the folder dialog and saves it", async () => {
		vi.mocked(open).mockResolvedValue("/Volumes/Media");
		await renderSettings();
		await click(screen.getByRole("button", { name: "Browse for folder" }));

		expect(open).toHaveBeenCalledExactlyOnceWith({
			directory: true,
			defaultPath: "/Users/test/Movies",
		});
		expect(setDownloadFolder).toHaveBeenCalledExactlyOnceWith("/Volumes/Media");
		expect(folderInput()).toHaveValue("/Volumes/Media");
		expect(block("Download folder").getByRole("button", { name: "Saved" })).toBeDisabled();
	});

	it("opens the folder dialog without a starting folder when none is set", async () => {
		vi.mocked(getDownloadFolder).mockResolvedValue("");
		vi.mocked(open).mockResolvedValue(null);
		await renderSettings();
		await click(screen.getByRole("button", { name: "Browse for folder" }));
		expect(open).toHaveBeenCalledExactlyOnceWith({ directory: true, defaultPath: undefined });
	});

	it("leaves the folder alone when the dialog is canceled, picks nothing or can't open", async () => {
		vi.mocked(open)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce("  ")
			.mockRejectedValueOnce(new Error("no dialog"));
		await renderSettings();

		await click(screen.getByRole("button", { name: "Browse for folder" }));
		await click(screen.getByRole("button", { name: "Browse for folder" }));
		await click(screen.getByRole("button", { name: "Browse for folder" }));

		expect(open).toHaveBeenCalledTimes(3);
		expect(setDownloadFolder).not.toHaveBeenCalled();
		expect(folderInput()).toHaveValue("/Users/test/Movies");
		expect(block("Download folder").getByRole("button", { name: "Save" })).toBeDisabled();
	});

	it("saves a typed folder without the spaces around it and says so for two seconds", async () => {
		vi.useFakeTimers();
		await renderSettings();
		const save = (name = "Save") => block("Download folder").getByRole("button", { name });
		expect(save()).toBeDisabled();

		typeInto(folderInput(), "   ");
		expect(save()).toBeDisabled();
		typeInto(folderInput(), "/Users/test/Movies ");
		expect(save()).toBeDisabled();

		typeInto(folderInput(), "  /Volumes/Media  ");
		await click(save());
		expect(setDownloadFolder).toHaveBeenCalledExactlyOnceWith("/Volumes/Media");
		expect(folderInput()).toHaveValue("/Volumes/Media");
		expect(save("Saved")).toBeInTheDocument();

		advance(2000);
		expect(save()).toBeDisabled();
	});

	it("says Failed for three seconds when the folder can't be saved", async () => {
		vi.useFakeTimers();
		vi.mocked(setDownloadFolder).mockRejectedValue(new Error("not writable"));
		await renderSettings();
		const save = (name = "Save") => block("Download folder").getByRole("button", { name });
		typeInto(folderInput(), "/Volumes/Media");
		await click(save());

		expect(save("Failed")).toBeEnabled();
		expect(folderInput()).toHaveValue("/Volumes/Media");
		advance(2999);
		expect(save("Failed")).toBeInTheDocument();
		advance(1);
		expect(save()).toBeEnabled();
	});

	it("goes back to Save as soon as the folder is edited after a failure", async () => {
		vi.mocked(setDownloadFolder).mockRejectedValue(new Error("not writable"));
		await renderSettings();
		typeInto(folderInput(), "/Volumes/Media");
		await click(block("Download folder").getByRole("button", { name: "Save" }));
		expect(block("Download folder").getByRole("button", { name: "Failed" })).toBeEnabled();

		typeInto(folderInput(), "/Volumes/Media2");
		expect(block("Download folder").getByRole("button", { name: "Save" })).toBeEnabled();
	});

	it("doesn't let an earlier folder save cut the next Saved or Failed short", async () => {
		vi.useFakeTimers();
		vi.mocked(setDownloadFolder)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("not writable"))
			.mockResolvedValueOnce(undefined);
		await renderSettings();
		const save = (name = "Save") => block("Download folder").getByRole("button", { name });
		typeInto(folderInput(), "/Volumes/Media");
		await click(save());
		advance(1000);
		typeInto(folderInput(), "/Volumes/Other");
		await click(save());

		advance(1000);
		expect(save("Failed")).toBeInTheDocument();
		advance(500);
		await click(save("Failed"));
		expect(save("Saved")).toBeInTheDocument();

		advance(1500);
		expect(save("Saved")).toBeInTheDocument();
		advance(500);
		expect(save()).toBeDisabled();
		expect(folderInput()).toHaveValue("/Volumes/Other");
	});
});

describe("Settings simultaneous downloads", () => {
	it("explains the field", async () => {
		await renderSettings();
		expect(concurrencyInput()).toHaveAccessibleDescription(
			"How many downloads run at once, from 1 to 10."
		);
	});

	it("saves a whole number from 1 to 10 as it's typed", async () => {
		await renderSettings();
		await act(async () => {
			typeInto(concurrencyInput(), "5");
		});

		expect(setDownloadConcurrency).toHaveBeenCalledExactlyOnceWith(5);
		expect(concurrencyInput()).toHaveValue(5);
	});

	it.each([
		["25", 10],
		["0", 1],
		["-4", 1],
		["2.6", 3],
	])("waits until the field is left to save %s as %i", async (typed, saved) => {
		await renderSettings();
		typeInto(concurrencyInput(), typed);
		expect(setDownloadConcurrency).not.toHaveBeenCalled();
		expect(concurrencyInput()).toHaveValue(Number(typed));

		await act(async () => {
			fireEvent.blur(concurrencyInput());
		});
		expect(setDownloadConcurrency).toHaveBeenCalledExactlyOnceWith(saved);
		expect(concurrencyInput()).toHaveValue(saved);
	});

	it("saves what was typed on Enter", async () => {
		await renderSettings();
		typeInto(concurrencyInput(), "25");
		await act(async () => {
			fireEvent.keyDown(concurrencyInput(), { key: "Enter" });
		});

		expect(setDownloadConcurrency).toHaveBeenCalledExactlyOnceWith(10);
		expect(concurrencyInput()).toHaveValue(10);
	});

	it("lets the field be cleared to type a new number and puts the old one back when it's left blank", async () => {
		await renderSettings();
		typeInto(concurrencyInput(), "");
		expect(concurrencyInput()).toHaveValue(null);

		fireEvent.blur(concurrencyInput());
		expect(concurrencyInput()).toHaveValue(4);
		expect(setDownloadConcurrency).not.toHaveBeenCalled();
	});

	it("doesn't save the number already saved", async () => {
		await renderSettings();
		typeInto(concurrencyInput(), "4");
		fireEvent.keyDown(concurrencyInput(), { key: "Enter" });
		typeInto(concurrencyInput(), "4.2");
		fireEvent.blur(concurrencyInput());

		expect(setDownloadConcurrency).not.toHaveBeenCalled();
		expect(concurrencyInput()).toHaveValue(4);
	});
});

describe("Settings download options", () => {
	it("keeps the page working when saving the download count or retention fails", async () => {
		vi.mocked(setDownloadConcurrency).mockRejectedValue(new Error("store"));
		downloads.setRetentionDays.mockRejectedValue(new Error("store"));
		vi.mocked(countDownloadsDue).mockResolvedValueOnce(0).mockResolvedValueOnce(2);
		await renderSettings();

		await act(async () => {
			typeInto(concurrencyInput(), "6");
		});
		expect(concurrencyInput()).toHaveValue(6);

		await choose("Delete downloads after", "7 days");
		await choose("Delete downloads after", "14 days");
		await click(screen.getByRole("button", { name: "Delete" }));

		expect(downloads.setRetentionDays.mock.calls).toEqual([[7], [14]]);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it.each([
		["no limit", "Never", null],
		["a 14 day limit", "14 days", 14],
	])("shows %s as %s", async (_name, label, days) => {
		downloads.retentionDays = days;
		await renderSettings();
		expect(screen.getByRole("button", { name: "Delete downloads after" })).toHaveTextContent(
			label
		);
	});

	it("changes the retention at once when no download is past the new setting", async () => {
		await renderSettings();
		await choose("Delete downloads after", "30 days");

		expect(countDownloadsDue).toHaveBeenCalledExactlyOnceWith(30);
		expect(downloads.setRetentionDays).toHaveBeenCalledExactlyOnceWith(30);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("asks before a shorter setting deletes downloads and applies it on yes", async () => {
		downloads.retentionDays = 30;
		vi.mocked(countDownloadsDue).mockResolvedValue(3);
		await renderSettings();
		await choose("Delete downloads after", "7 days");

		const dialog = screen.getByRole("dialog", { name: "Delete downloads now?" });
		expect(dialog).toHaveTextContent(
			"3 downloads are already past this setting. They will be deleted now."
		);
		expect(downloads.setRetentionDays).not.toHaveBeenCalled();

		await click(within(dialog).getByRole("button", { name: "Delete" }));
		expect(downloads.setRetentionDays).toHaveBeenCalledExactlyOnceWith(7);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("talks about one download in the singular and changes nothing on cancel", async () => {
		downloads.retentionDays = 30;
		vi.mocked(countDownloadsDue).mockResolvedValue(1);
		await renderSettings();
		await choose("Delete downloads after", "14 days");

		const dialog = screen.getByRole("dialog", { name: "Delete downloads now?" });
		expect(dialog).toHaveTextContent(
			"1 download is already past this setting. It will be deleted now."
		);

		await click(within(dialog).getByRole("button", { name: "Cancel" }));
		expect(downloads.setRetentionDays).not.toHaveBeenCalled();
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("asks anyway when it can't count the downloads past the new setting", async () => {
		downloads.retentionDays = 30;
		vi.mocked(countDownloadsDue).mockRejectedValue(new Error("db locked"));
		await renderSettings();
		await choose("Delete downloads after", "7 days");

		const dialog = screen.getByRole("dialog", { name: "Delete downloads now?" });
		expect(dialog).toHaveTextContent(
			"Downloads already past this setting will be deleted now."
		);
		expect(downloads.setRetentionDays).not.toHaveBeenCalled();

		await click(within(dialog).getByRole("button", { name: "Delete" }));
		expect(downloads.setRetentionDays).toHaveBeenCalledExactlyOnceWith(7);
	});

	it("turns deleting off without counting or asking", async () => {
		downloads.retentionDays = 30;
		await renderSettings();
		await choose("Delete downloads after", "Never");

		expect(countDownloadsDue).not.toHaveBeenCalled();
		expect(downloads.setRetentionDays).toHaveBeenCalledExactlyOnceWith(null);
		expect(screen.queryByRole("dialog")).toBeNull();
	});

	it("does nothing when the current retention is picked again", async () => {
		downloads.retentionDays = 30;
		await renderSettings();
		await choose("Delete downloads after", "30 days");

		expect(countDownloadsDue).not.toHaveBeenCalled();
		expect(downloads.setRetentionDays).not.toHaveBeenCalled();
	});

	it("opens and closes the download history", async () => {
		await renderSettings();
		expect(screen.queryByRole("heading", { name: "Download history" })).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "View download history" }));
		expect(screen.getByRole("heading", { name: "Download history" })).toBeInTheDocument();
		expect(screen.getByText("No downloads yet.")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(screen.queryByRole("heading", { name: "Download history" })).toBeNull();
	});
});

describe.each([
	{
		what: "watch history",
		button: "Clear All History…",
		title: "Clear History",
		clear: clearWatchHistory,
		done: "History cleared",
		failure: "Failed to clear history. Please try again.",
	},
	{
		what: "caches",
		button: "Clear All Caches…",
		title: "Clear Caches",
		clear: clearAllCaches,
		done: "Caches cleared",
		failure: "Failed to clear caches. Please try again.",
	},
])("Settings clearing $what", ({ what, button, title, clear, done, failure }) => {
	it(`clears ${what} after a yes and says so for two seconds`, async () => {
		vi.useFakeTimers();
		vi.mocked(ask).mockResolvedValue(true);
		await renderSettings();
		await click(screen.getByRole("button", { name: button }));

		expect(ask).toHaveBeenCalledExactlyOnceWith(
			expect.stringContaining("This cannot be undone."),
			{ title, kind: "warning" }
		);
		expect(clear).toHaveBeenCalledOnce();
		expect(screen.getByText(done)).toBeInTheDocument();

		advance(2000);
		expect(screen.queryByText(done)).toBeNull();
	});

	it(`keeps the cleared message up for two full seconds after ${what} is cleared again`, async () => {
		vi.useFakeTimers();
		vi.mocked(ask).mockResolvedValue(true);
		await renderSettings();
		await click(screen.getByRole("button", { name: button }));
		advance(1500);
		await click(screen.getByRole("button", { name: button }));

		advance(500);
		expect(screen.getByText(done)).toBeInTheDocument();
		advance(1500);
		expect(screen.queryByText(done)).toBeNull();
		expect(clear).toHaveBeenCalledTimes(2);
	});

	it(`leaves ${what} alone on a no`, async () => {
		vi.mocked(ask).mockResolvedValue(false);
		await renderSettings();
		await click(screen.getByRole("button", { name: button }));

		expect(ask).toHaveBeenCalledOnce();
		expect(clear).not.toHaveBeenCalled();
		expect(screen.queryByText(done)).toBeNull();
	});

	it(`says when ${what} can't be cleared and drops that after a good try`, async () => {
		vi.mocked(ask).mockResolvedValue(true);
		vi.mocked(clear).mockRejectedValueOnce(new Error("db locked"));
		await renderSettings();
		await click(screen.getByRole("button", { name: button }));

		expect(screen.getByText(failure)).toBeInTheDocument();
		expect(screen.queryByText(done)).toBeNull();

		await click(screen.getByRole("button", { name: button }));
		expect(screen.queryByText(failure)).toBeNull();
		expect(screen.getByText(done)).toBeInTheDocument();
	});
});

describe("Settings support", () => {
	it("opens Buy Me a Coffee from the QR code and from the button", async () => {
		await renderSettings();
		fireEvent.click(screen.getByRole("button", { name: "Donate via Buy Me a Coffee" }));
		fireEvent.click(screen.getByRole("button", { name: "Buy me a coffee" }));
		expect(openUrl).toHaveBeenCalledTimes(2);
		expect(openUrl).toHaveBeenNthCalledWith(1, "https://buymeacoffee.com/MaxMB15");
		expect(openUrl).toHaveBeenNthCalledWith(2, "https://buymeacoffee.com/MaxMB15");
	});

	it("resets the donation reminder and says so for two seconds", async () => {
		vi.useFakeTimers();
		localStorage.setItem(DONATION_LAST_SHOWN_KEY, "1767225600000");
		await renderSettings();
		await click(screen.getByRole("button", { name: "Reset donation reminder" }));

		expect(localStorage.getItem(DONATION_LAST_SHOWN_KEY)).toBeNull();
		expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();

		advance(2000);
		expect(screen.getByRole("button", { name: "Reset donation reminder" })).toBeEnabled();
	});
});

describe("Settings on each platform", () => {
	it.each([
		["macos", "desktop", "macOS"],
		["linux", "desktop", "Linux"],
		["windows", "desktop", "Windows"],
		["ios", "desktop", "iOS"],
		["ios", "tablet", "iOS"],
		["ios", "mobile", "iOS"],
		["android", "tv", "Android"],
	] as const)("names %s with the %s layout", async (platform, layoutMode, name) => {
		device.platform = platform;
		device.layoutMode = layoutMode;
		await renderSettings();
		expect(screen.getByText(name)).toBeInTheDocument();
		expect(screen.getByText(`Layout: ${layoutMode}`)).toBeInTheDocument();
	});

	it.each(["macos", "linux", "windows"] as const)(
		"offers downloads and the donation link on %s",
		async (platform) => {
			device.platform = platform;
			await renderSettings();
			expect(screen.getByRole("heading", { name: "Downloads" })).toBeInTheDocument();
			expect(screen.getByRole("heading", { name: "Support" })).toBeInTheDocument();
		}
	);

	// An iPad in landscape gets the desktop layout. It's still an iPad, and
	// App Store rules don't allow the donation link there.
	it.each([
		["ios", "mobile"],
		["ios", "tablet"],
		["ios", "desktop"],
		["android", "tv"],
	] as const)(
		"leaves out downloads and the donation link on %s with the %s layout",
		async (platform, layoutMode) => {
			device.platform = platform;
			device.layoutMode = layoutMode;
			await renderSettings();

			expect(screen.queryByRole("heading", { name: "Downloads" })).toBeNull();
			expect(screen.queryByRole("button", { name: "Browse for folder" })).toBeNull();
			expect(screen.queryByRole("heading", { name: "Support" })).toBeNull();
			expect(screen.queryByRole("button", { name: "Donate via Buy Me a Coffee" })).toBeNull();
			expect(screen.queryByRole("button", { name: "Reset donation reminder" })).toBeNull();
			expect(screen.getByRole("heading", { name: "Watch History" })).toBeInTheDocument();
			expect(screen.getByRole("heading", { name: "About" })).toBeInTheDocument();
		}
	);
});

describe("Settings updates", () => {
	it("leaves out the update check where the app store handles updates", async () => {
		await renderSettings({ update: makeUpdateState({ supported: false }) });
		expect(screen.queryByRole("button", { name: "Check for Updates" })).toBeNull();
		expect(card("About").queryByRole("status")).toBeNull();
	});

	it("checks for updates on request and says when the app is up to date", async () => {
		const update = makeUpdateState();
		await renderSettings({ update });
		expect(card("About").getByRole("status")).toHaveTextContent("You're up to date.");

		await click(screen.getByRole("button", { name: "Check for Updates" }));
		expect(update.checkForUpdates).toHaveBeenCalledOnce();
	});

	it("shows Checking while a check runs and says nothing yet", async () => {
		await renderSettings({ update: makeUpdateState({ checking: true }) });
		expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
		expect(card("About").getByRole("status")).toBeEmptyDOMElement();
	});

	it("says when the check failed and keeps the reason in a tooltip", async () => {
		await renderSettings({ update: makeUpdateState({ checkError: "network down" }) });
		expect(card("About").getByRole("status")).toHaveTextContent("Couldn't check for updates.");
		expect(screen.getByText("Couldn't check for updates.")).toHaveAttribute(
			"title",
			"network down"
		);
		expect(screen.queryByText("You're up to date.")).toBeNull();
	});

	it("shows an available update with its notes and installs it", async () => {
		const update = makeUpdateState({
			update: fakeUpdate({ version: "2.0.0", body: "Faster startup" }),
		});
		await renderSettings({ update });

		expect(screen.getByText("Update available — v2.0.0")).toBeInTheDocument();
		expect(screen.getByText("Faster startup")).toBeInTheDocument();
		expect(card("About").getByRole("status")).toBeEmptyDOMElement();

		await click(screen.getByRole("button", { name: "Install Update" }));
		expect(update.install).toHaveBeenCalledOnce();
	});

	it("falls back to a stock line when an update has no notes", async () => {
		await renderSettings({ update: makeUpdateState({ update: fakeUpdate({ body: null }) }) });
		expect(screen.getByText("A new version is ready to install.")).toBeInTheDocument();
	});

	it("shows download progress while an update installs", async () => {
		const { container } = await renderSettings({
			update: makeUpdateState({ update: fakeUpdate(), installing: true, progress: 42 }),
		});
		expect(screen.getByRole("button", { name: "Downloading… 42%" })).toBeDisabled();
		// The progress bar has no text or role, so it is found by its width.
		expect(container.querySelector('[style="width: 42%;"]')).not.toBeNull();
	});

	it("says Installing with no progress bar when the download size is unknown", async () => {
		await renderSettings({
			update: makeUpdateState({ update: fakeUpdate(), installing: true, progress: null }),
		});
		const installing = screen.getByRole("button", { name: "Installing…" });
		expect(installing).toBeDisabled();
		// The bar has no role or text, and jsdom drops a "null%" width, so the
		// test checks that the button comes straight after the notes instead.
		expect(screen.getByText("Release notes").nextElementSibling).toBe(installing);
	});

	it("shows why an install failed", async () => {
		await renderSettings({
			update: makeUpdateState({ update: fakeUpdate(), error: "Signature check failed" }),
		});
		expect(screen.getByText("Signature check failed")).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Install Update" })).toBeEnabled();
	});
});

describe("Settings when it closes", () => {
	it("stops every pending timer", async () => {
		vi.useFakeTimers();
		vi.mocked(ask).mockResolvedValue(true);
		const { unmount } = await renderSettings();

		typeInto(keyInput("OMDb"), "omdb-test-key");
		await click(keyButton("OMDb", "Save"));
		typeInto(keyInput("OpenSubtitles"), "subs-test-key");
		await click(keyButton("OpenSubtitles", "Save"));
		typeInto(keyInput("Gemini"), "gemini-test-key");
		await click(keyButton("Gemini", "Save"));
		typeInto(folderInput(), "/Volumes/Media");
		await click(block("Download folder").getByRole("button", { name: "Save" }));
		await click(screen.getByRole("button", { name: "Clear All History…" }));
		await click(screen.getByRole("button", { name: "Clear All Caches…" }));
		await click(screen.getByRole("button", { name: "Reset donation reminder" }));
		expect(vi.getTimerCount()).toBeGreaterThan(0);

		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});
});
