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
	fetchOmdbData,
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
	testOpenSubtitlesApiKey,
} from "@/lib/tauri";
import type { LayoutMode, OmdbData, Platform } from "@/lib/types";
import { fakeUpdate, makeUpdateState } from "@/test/app-fixtures";
import { makeOmdb } from "@/test/detail-fixtures";
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
	fetchOmdbData: vi.fn(),
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

/** Queries inside the block that a title such as "OMDB API" starts. */
const block = (title: string) => within(screen.getByText(title).parentElement as HTMLElement);

const keyInput = (title: string) => block(title).getByPlaceholderText(/API key…$/);

const folderInput = () => screen.getByPlaceholderText("/path/to/downloads");

const advance = (ms: number) => {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
};

/** A promise the test settles by hand, to look at the page while work is under way. */
const deferred = <T,>() => {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
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

		expect(keyInput("OMDB API")).toHaveValue("omdb-test-key");
		expect(keyInput("OpenSubtitles API")).toHaveValue("subs-test-key");
		expect(keyInput("Gemini API Key")).toHaveValue("gemini-test-key");
		expect(folderInput()).toHaveValue("/Users/test/Movies");
		expect(screen.getByRole("spinbutton")).toHaveValue(4);
		expect(screen.getByText("Max Video Player v1.2.3")).toBeInTheDocument();
		expect(screen.queryByText(/No API key configured/)).toBeNull();
		expect(rememberHasOmdbKey).not.toHaveBeenCalled();
	});

	it("asks for an OMDb key and leaves out the services that need one while none is saved", async () => {
		await renderSettings();

		expect(screen.getByText(/No API key configured/)).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "Get a free key at omdbapi.com" })).toHaveAttribute(
			"href",
			"https://www.omdbapi.com/apikey.aspx"
		);
		expect(screen.queryByText("OpenSubtitles API")).toBeNull();
		expect(block("OMDB API").getByRole("button", { name: "Save" })).toBeDisabled();
		expect(block("OMDB API").getByRole("button", { name: "Test" })).toBeDisabled();
	});

	it("still opens when the version, Gemini key, folder and download count can't be read", async () => {
		vi.mocked(getVersion).mockRejectedValue(new Error("no app"));
		vi.mocked(getGeminiApiKey).mockRejectedValue(new Error("store"));
		vi.mocked(getDownloadFolder).mockRejectedValue(new Error("store"));
		vi.mocked(getDownloadConcurrency).mockRejectedValue(new Error("store"));
		await renderSettings();

		expect(screen.getByText("Max Video Player")).toBeInTheDocument();
		expect(keyInput("Gemini API Key")).toHaveValue("");
		expect(folderInput()).toHaveValue("");
		expect(screen.getByRole("spinbutton")).toHaveValue(3);
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

		const input = keyInput("OMDB API");
		expect(input).toHaveFocus();
		expect(scrollIntoView).toHaveBeenCalledOnce();
		expect(scrollIntoView.mock.contexts[0]).toBe(input);
	});
});

describe("Settings OMDb key", () => {
	it("saves the OMDb key, says so for two seconds and remembers that a key exists", async () => {
		vi.useFakeTimers();
		await renderSettings();
		typeInto(keyInput("OMDB API"), "test-key");
		await click(block("OMDB API").getByRole("button", { name: "Save" }));

		expect(setOmdbApiKey).toHaveBeenCalledExactlyOnceWith("test-key");
		expect(rememberHasOmdbKey).toHaveBeenCalledExactlyOnceWith(true);
		expect(block("OMDB API").getByRole("button", { name: "Saved" })).toBeInTheDocument();

		advance(1999);
		expect(block("OMDB API").getByRole("button", { name: "Saved" })).toBeInTheDocument();
		advance(1);
		expect(block("OMDB API").getByRole("button", { name: "Save" })).toBeInTheDocument();
	});

	it("says when the OMDb key can't be saved and drops the message after a good save", async () => {
		vi.mocked(setOmdbApiKey).mockRejectedValueOnce(new Error("disk full"));
		await renderSettings();
		typeInto(keyInput("OMDB API"), "test-key");
		await click(block("OMDB API").getByRole("button", { name: "Save" }));

		expect(
			block("OMDB API").getByText("Failed to save. Please try again.")
		).toBeInTheDocument();
		expect(rememberHasOmdbKey).not.toHaveBeenCalled();

		await click(block("OMDB API").getByRole("button", { name: "Save" }));
		expect(block("OMDB API").queryByText("Failed to save. Please try again.")).toBeNull();
		expect(block("OMDB API").getByRole("button", { name: "Saved" })).toBeInTheDocument();
	});

	it("calls the OMDb key valid when the lookup finds a movie", async () => {
		vi.mocked(fetchOmdbData).mockResolvedValue(makeOmdb());
		await renderSettings();
		typeInto(keyInput("OMDB API"), "test-key");
		await click(block("OMDB API").getByRole("button", { name: "Test" }));

		expect(fetchOmdbData).toHaveBeenCalledOnce();
		expect(block("OMDB API").getByText("Valid key · 1000 calls/day limit")).toBeInTheDocument();
		expect(block("OMDB API").queryByText("Invalid key")).toBeNull();
	});

	it.each([
		["finds nothing", () => vi.mocked(fetchOmdbData).mockResolvedValue(null)],
		["fails", () => vi.mocked(fetchOmdbData).mockRejectedValue(new Error("401"))],
	])("calls the OMDb key invalid when the lookup %s", async (_, arrange) => {
		arrange();
		await renderSettings();
		typeInto(keyInput("OMDB API"), "test-key");
		await click(block("OMDB API").getByRole("button", { name: "Test" }));

		expect(block("OMDB API").getByText("Invalid key")).toBeInTheDocument();
		expect(block("OMDB API").getByRole("button", { name: "Test" })).toBeEnabled();
	});

	it("shows Testing while the OMDb check runs and drops the result when the key changes", async () => {
		const lookup = deferred<OmdbData | null>();
		vi.mocked(fetchOmdbData).mockReturnValue(lookup.promise);
		await renderSettings();
		typeInto(keyInput("OMDB API"), "test-key");
		await click(block("OMDB API").getByRole("button", { name: "Test" }));

		expect(block("OMDB API").getByRole("button", { name: "Testing…" })).toBeDisabled();

		await act(async () => lookup.resolve(makeOmdb()));
		expect(block("OMDB API").getByRole("button", { name: "Test" })).toBeEnabled();
		expect(block("OMDB API").getByText(/^Valid key/)).toBeInTheDocument();

		typeInto(keyInput("OMDB API"), "other-test-key");
		expect(block("OMDB API").queryByText(/^Valid key/)).toBeNull();
	});

	it("drops the last check result once the OMDb key is saved", async () => {
		vi.mocked(fetchOmdbData).mockResolvedValue(null);
		await renderSettings();
		typeInto(keyInput("OMDB API"), "test-key");
		await click(block("OMDB API").getByRole("button", { name: "Test" }));
		expect(block("OMDB API").getByText("Invalid key")).toBeInTheDocument();

		await click(block("OMDB API").getByRole("button", { name: "Save" }));
		expect(block("OMDB API").queryByText("Invalid key")).toBeNull();
	});
});

describe("Settings key fields", () => {
	// Each field's name in the test names, and the title its block shows.
	const fields = [
		["Gemini", "Gemini API Key"],
		["OMDb", "OMDB API"],
		["OpenSubtitles", "OpenSubtitles API"],
	] as const;

	it.each(fields)("turns off Save and Test while the %s key is blank", async (_name, title) => {
		vi.mocked(getOmdbApiKey).mockResolvedValue("omdb-test-key");
		await renderSettings();
		typeInto(keyInput(title), "   ");
		expect(block(title).getByRole("button", { name: "Save" })).toBeDisabled();
		expect(block(title).getByRole("button", { name: "Test" })).toBeDisabled();

		typeInto(keyInput(title), "test-key");
		expect(block(title).getByRole("button", { name: "Save" })).toBeEnabled();
		expect(block(title).getByRole("button", { name: "Test" })).toBeEnabled();
	});

	it.each(fields)(
		"goes back to Save as soon as the saved %s key is edited",
		async (_name, title) => {
			vi.mocked(getOmdbApiKey).mockResolvedValue("omdb-test-key");
			await renderSettings();
			typeInto(keyInput(title), "test-key");
			await click(block(title).getByRole("button", { name: "Save" }));
			expect(block(title).getByRole("button", { name: "Saved" })).toBeInTheDocument();

			typeInto(keyInput(title), "test-key-2");
			expect(block(title).getByRole("button", { name: "Save" })).toBeEnabled();
		}
	);

	it.each(fields)(
		"shows and hides the %s key without touching the others",
		async (_name, title) => {
			vi.mocked(getOmdbApiKey).mockResolvedValue("omdb-test-key");
			await renderSettings();
			const others = fields.map(([, t]) => t).filter((t) => t !== title);

			expect(keyInput(title)).toHaveAttribute("type", "password");
			fireEvent.click(block(title).getByRole("button", { name: "Show key" }));
			expect(keyInput(title)).toHaveAttribute("type", "text");
			for (const other of others) {
				expect(keyInput(other)).toHaveAttribute("type", "password");
			}

			fireEvent.click(block(title).getByRole("button", { name: "Hide key" }));
			expect(keyInput(title)).toHaveAttribute("type", "password");
		}
	);

	it.each(fields)(
		"keeps Saved up for two full seconds after the %s key is saved again",
		async (_name, title) => {
			vi.useFakeTimers();
			vi.mocked(getOmdbApiKey).mockResolvedValue("omdb-test-key");
			await renderSettings();
			typeInto(keyInput(title), "test-key");
			await click(block(title).getByRole("button", { name: "Save" }));
			advance(1500);
			await click(block(title).getByRole("button", { name: "Saved" }));

			advance(500);
			expect(block(title).getByRole("button", { name: "Saved" })).toBeInTheDocument();
			advance(1500);
			expect(block(title).getByRole("button", { name: "Save" })).toBeInTheDocument();
		}
	);
});

describe("Settings OpenSubtitles key", () => {
	it("appears once an OMDb key is typed and goes away when that key is cleared", async () => {
		await renderSettings();
		expect(screen.queryByText("OpenSubtitles API")).toBeNull();

		typeInto(keyInput("OMDB API"), "test-key");
		expect(screen.getByText("OpenSubtitles API")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "opensubtitles.com" })).toHaveAttribute(
			"href",
			"https://www.opensubtitles.com/consumers"
		);

		typeInto(keyInput("OMDB API"), " ");
		expect(screen.queryByText("OpenSubtitles API")).toBeNull();
	});

	it("saves the OpenSubtitles key and says so for two seconds", async () => {
		vi.useFakeTimers();
		vi.mocked(getOmdbApiKey).mockResolvedValue("omdb-test-key");
		await renderSettings();
		const subs = () => block("OpenSubtitles API");
		expect(subs().getByRole("button", { name: "Save" })).toBeDisabled();

		typeInto(keyInput("OpenSubtitles API"), "subs-test-key");
		await click(subs().getByRole("button", { name: "Save" }));
		expect(setOpenSubtitlesApiKey).toHaveBeenCalledExactlyOnceWith("subs-test-key");
		expect(setOmdbApiKey).not.toHaveBeenCalled();
		expect(subs().getByRole("button", { name: "Saved" })).toBeInTheDocument();

		advance(2000);
		expect(subs().getByRole("button", { name: "Save" })).toBeInTheDocument();
	});

	it("says when the OpenSubtitles key can't be saved and drops the message after a good save", async () => {
		vi.mocked(getOmdbApiKey).mockResolvedValue("omdb-test-key");
		vi.mocked(setOpenSubtitlesApiKey).mockRejectedValueOnce(new Error("disk full"));
		await renderSettings();
		const subs = () => block("OpenSubtitles API");
		typeInto(keyInput("OpenSubtitles API"), "subs-test-key");
		await click(subs().getByRole("button", { name: "Save" }));

		expect(subs().getByText("Failed to save. Please try again.")).toBeInTheDocument();
		expect(block("OMDB API").queryByText("Failed to save. Please try again.")).toBeNull();

		await click(subs().getByRole("button", { name: "Save" }));
		expect(subs().queryByText("Failed to save. Please try again.")).toBeNull();
		expect(subs().getByRole("button", { name: "Saved" })).toBeInTheDocument();
	});

	it("tests the typed OpenSubtitles key and says whether it works", async () => {
		vi.mocked(getOmdbApiKey).mockResolvedValue("omdb-test-key");
		const check = deferred<boolean>();
		vi.mocked(testOpenSubtitlesApiKey)
			.mockReturnValueOnce(check.promise)
			.mockResolvedValueOnce(false)
			.mockRejectedValueOnce(new Error("offline"));
		await renderSettings();
		const subs = () => block("OpenSubtitles API");
		typeInto(keyInput("OpenSubtitles API"), "subs-test-key");

		await click(subs().getByRole("button", { name: "Test" }));
		expect(testOpenSubtitlesApiKey).toHaveBeenCalledWith("subs-test-key");
		expect(subs().getByRole("button", { name: "Testing…" })).toBeDisabled();
		await act(async () => check.resolve(true));
		expect(subs().getByText("Valid key")).toBeInTheDocument();

		await click(subs().getByRole("button", { name: "Test" }));
		expect(subs().getByText("Invalid key")).toBeInTheDocument();
		expect(subs().queryByText("Valid key")).toBeNull();

		typeInto(keyInput("OpenSubtitles API"), "subs-test-key-2");
		expect(subs().queryByText("Invalid key")).toBeNull();

		await click(subs().getByRole("button", { name: "Test" }));
		expect(testOpenSubtitlesApiKey).toHaveBeenLastCalledWith("subs-test-key-2");
		expect(subs().getByText("Invalid key")).toBeInTheDocument();

		await click(subs().getByRole("button", { name: "Save" }));
		expect(subs().queryByText("Invalid key")).toBeNull();
	});
});

describe("Settings Gemini key", () => {
	it("saves the Gemini key and says so for two seconds", async () => {
		vi.useFakeTimers();
		await renderSettings();
		const gemini = () => block("Gemini API Key");
		expect(gemini().getByRole("button", { name: "Save" })).toBeDisabled();
		expect(gemini().getByRole("link", { name: "aistudio.google.com" })).toHaveAttribute(
			"href",
			"https://aistudio.google.com/apikey"
		);

		typeInto(keyInput("Gemini API Key"), "gemini-test-key");
		expect(gemini().queryByRole("link", { name: "aistudio.google.com" })).toBeNull();
		await click(gemini().getByRole("button", { name: "Save" }));

		expect(setGeminiApiKey).toHaveBeenCalledExactlyOnceWith("gemini-test-key");
		expect(gemini().getByRole("button", { name: "Saved" })).toBeInTheDocument();
		advance(2000);
		expect(gemini().getByRole("button", { name: "Save" })).toBeInTheDocument();
	});

	it("says Failed for three seconds when the Gemini key can't be saved", async () => {
		vi.useFakeTimers();
		vi.mocked(setGeminiApiKey).mockRejectedValue(new Error("disk full"));
		await renderSettings();
		const gemini = () => block("Gemini API Key");
		typeInto(keyInput("Gemini API Key"), "gemini-test-key");
		await click(gemini().getByRole("button", { name: "Save" }));

		expect(gemini().getByRole("button", { name: "Failed" })).toBeInTheDocument();
		advance(2999);
		expect(gemini().getByRole("button", { name: "Failed" })).toBeInTheDocument();
		advance(1);
		expect(gemini().getByRole("button", { name: "Save" })).toBeInTheDocument();
	});

	it("doesn't let an earlier Gemini save cut the next Saved or Failed short", async () => {
		vi.useFakeTimers();
		vi.mocked(setGeminiApiKey)
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("disk full"))
			.mockResolvedValueOnce(undefined);
		await renderSettings();
		const gemini = () => block("Gemini API Key");
		typeInto(keyInput("Gemini API Key"), "gemini-test-key");
		await click(gemini().getByRole("button", { name: "Save" }));
		advance(1000);
		await click(gemini().getByRole("button", { name: "Saved" }));

		advance(1000);
		expect(gemini().getByRole("button", { name: "Failed" })).toBeInTheDocument();
		advance(500);
		await click(gemini().getByRole("button", { name: "Failed" }));
		expect(gemini().getByRole("button", { name: "Saved" })).toBeInTheDocument();

		advance(1500);
		expect(gemini().getByRole("button", { name: "Saved" })).toBeInTheDocument();
		advance(500);
		expect(gemini().getByRole("button", { name: "Save" })).toBeInTheDocument();
	});

	it("goes back to Save as soon as a failed Gemini key is edited", async () => {
		vi.mocked(setGeminiApiKey).mockRejectedValue(new Error("disk full"));
		await renderSettings();
		const gemini = () => block("Gemini API Key");
		typeInto(keyInput("Gemini API Key"), "gemini-test-key");
		await click(gemini().getByRole("button", { name: "Save" }));
		expect(gemini().getByRole("button", { name: "Failed" })).toBeInTheDocument();

		typeInto(keyInput("Gemini API Key"), "gemini-test-key-2");
		expect(gemini().getByRole("button", { name: "Save" })).toBeEnabled();
	});

	it("tests the typed Gemini key and says whether it works", async () => {
		const check = deferred<boolean>();
		vi.mocked(testGeminiApiKey)
			.mockReturnValueOnce(check.promise)
			.mockResolvedValueOnce(false)
			.mockRejectedValueOnce(new Error("offline"));
		await renderSettings();
		const gemini = () => block("Gemini API Key");
		expect(gemini().getByRole("button", { name: "Test" })).toBeDisabled();
		typeInto(keyInput("Gemini API Key"), "gemini-test-key");

		await click(gemini().getByRole("button", { name: "Test" }));
		expect(testGeminiApiKey).toHaveBeenCalledWith("gemini-test-key");
		expect(gemini().getByRole("button", { name: "Testing…" })).toBeDisabled();
		await act(async () => check.resolve(true));
		expect(gemini().getByText("Valid key")).toBeInTheDocument();

		await click(gemini().getByRole("button", { name: "Test" }));
		expect(gemini().getByText("Invalid key")).toBeInTheDocument();

		typeInto(keyInput("Gemini API Key"), "gemini-test-key-2");
		expect(gemini().queryByText("Invalid key")).toBeNull();

		await click(gemini().getByRole("button", { name: "Test" }));
		expect(testGeminiApiKey).toHaveBeenLastCalledWith("gemini-test-key-2");
		expect(gemini().getByText("Invalid key")).toBeInTheDocument();

		await click(gemini().getByRole("button", { name: "Save" }));
		expect(gemini().queryByText("Invalid key")).toBeNull();
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

describe("Settings download options", () => {
	it.each([
		["5", 5],
		["25", 10],
		["0", 1],
		["2.6", 3],
	])("saves %s simultaneous downloads as %i", async (typed, saved) => {
		await renderSettings();
		const input = screen.getByRole("spinbutton");
		await act(async () => {
			typeInto(input, typed);
		});

		expect(setDownloadConcurrency).toHaveBeenCalledExactlyOnceWith(saved);
		expect(input).toHaveValue(saved);
		expect(block("Simultaneous downloads").getByText(String(saved))).toBeInTheDocument();
	});

	it("keeps the page working when saving the download count or retention fails", async () => {
		vi.mocked(setDownloadConcurrency).mockRejectedValue(new Error("store"));
		downloads.setRetentionDays.mockRejectedValue(new Error("store"));
		vi.mocked(countDownloadsDue).mockResolvedValueOnce(0).mockResolvedValueOnce(2);
		await renderSettings();

		await act(async () => {
			typeInto(screen.getByRole("spinbutton"), "6");
		});
		expect(screen.getByRole("spinbutton")).toHaveValue(6);

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
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("checks for updates on request and says when the app is up to date", async () => {
		const update = makeUpdateState();
		await renderSettings({ update });
		expect(screen.getByRole("status")).toHaveTextContent("You're up to date.");

		await click(screen.getByRole("button", { name: "Check for Updates" }));
		expect(update.checkForUpdates).toHaveBeenCalledOnce();
	});

	it("shows Checking while a check runs and says nothing yet", async () => {
		await renderSettings({ update: makeUpdateState({ checking: true }) });
		expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
		expect(screen.getByRole("status")).toBeEmptyDOMElement();
	});

	it("says when the check failed and keeps the reason in a tooltip", async () => {
		await renderSettings({ update: makeUpdateState({ checkError: "network down" }) });
		expect(screen.getByRole("status")).toHaveTextContent("Couldn't check for updates.");
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
		expect(screen.getByRole("status")).toBeEmptyDOMElement();

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

		typeInto(keyInput("OMDB API"), "test-key");
		await click(block("OMDB API").getByRole("button", { name: "Save" }));
		typeInto(keyInput("OpenSubtitles API"), "subs-test-key");
		await click(block("OpenSubtitles API").getByRole("button", { name: "Save" }));
		typeInto(keyInput("Gemini API Key"), "gemini-test-key");
		await click(block("Gemini API Key").getByRole("button", { name: "Save" }));
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
