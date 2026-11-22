// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { FONT_FAMILIES, languageName } from "@/lib/subtitle-style";
import type { SubtitleEntry, SubtitleSearchResult } from "@/lib/types";
import { deferred } from "@/test/deferred";
import { TvSubtitlePanel, type TvSubtitleStyle } from "./TvSubtitlePanel";

const tauri = vi.hoisted(() => ({
	searchSubtitles: vi.fn<() => Promise<SubtitleSearchResult | null>>(),
	downloadSubtitle: vi.fn<(fileId: number) => Promise<string>>(),
	readSubtitleFile: vi.fn<(path: string) => Promise<string>>(),
	mpvSubAdd: vi.fn<(path: string, overlay: boolean, url: string) => Promise<void>>(),
	mpvSubRemove: vi.fn<(id: number, url?: string) => Promise<void>>(),
}));

vi.mock("@/lib/tauri", () => tauri);

const STREAM = "http://example.test/sintel.mkv";
const SRT = "1\n00:00:01,000 --> 00:00:02,000\nHello\n";

const entry = (fileId: number, languageCode: string, releaseName?: string): SubtitleEntry => ({
	fileId,
	languageCode,
	format: "srt",
	releaseName,
});

const CLEAR = entry(1, "en", "Sintel.Clear");
const SDH = entry(2, "en", "Sintel.SDH");
const FRENCH = entry(3, "fr");

const FOUND: SubtitleSearchResult = {
	languages: ["en", "fr"],
	entries: [CLEAR, SDH, FRENCH],
};

const makeStyle = (overrides: Partial<TvSubtitleStyle> = {}): TvSubtitleStyle => ({
	fontSize: 26,
	fontFamily: FONT_FAMILIES[0].value,
	delay: 0,
	position: { x: 50, y: 88 },
	onFontSizeChange: vi.fn(),
	onFontFamilyChange: vi.fn(),
	onDelayChange: vi.fn(),
	onPositionChange: vi.fn(),
	...overrides,
});

type PanelProps = ComponentProps<typeof TvSubtitlePanel>;

const renderPanel = (overrides: Partial<PanelProps> = {}) => {
	const props: PanelProps = {
		imdbId: "tt1727587",
		currentSelectedEntry: null,
		style: makeStyle(),
		onClose: vi.fn(),
		startPick: () => ({ latest: () => true, stream: () => STREAM, keep: () => false }),
		onSubtitleSelected: vi.fn(),
		...overrides,
	};
	render(<TvSubtitlePanel {...props} />);
	return props;
};

/** Renders the panel and waits for the search to finish. */
const renderFound = async (overrides: Partial<PanelProps> = {}) => {
	const props = renderPanel(overrides);
	await screen.findByRole("listbox", { name: "Languages" });
	await waitFor(() => expect(screen.queryByText("Searching for subtitles")).toBeNull());
	return props;
};

const languages = () => screen.getByRole("listbox", { name: "Languages" });
const releases = () => screen.queryByRole("listbox", { name: "Releases" });
const languageCursor = () => within(languages()).getByRole("option", { selected: true });
const releaseCursor = () => within(releases()!).getByRole("option", { selected: true });
const choice = (name: string) => within(languages()).getByRole("option", { name: RegExp(name) });

const press = (key: string) => fireEvent.keyDown(document.activeElement!, { key });

/** Gives the two columns boxes side by side, since jsdom lays nothing out. */
const placeColumns = () => {
	const lists = screen.getAllByRole("listbox");
	lists.forEach((list, column) => {
		const box = (el: Element) => {
			el.getBoundingClientRect = () =>
				({
					left: column * 300,
					right: column * 300 + 200,
					top: 0,
					bottom: 400,
					width: 200,
					height: 400,
				}) as DOMRect;
		};
		box(list);
		within(list).getAllByRole("option").forEach(box);
	});
};

describe("TvSubtitlePanel", () => {
	let consoleError: MockInstance<typeof console.error>;

	beforeEach(() => {
		consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		tauri.searchSubtitles.mockReset().mockResolvedValue(FOUND);
		tauri.downloadSubtitle.mockReset().mockResolvedValue("/tmp/sub.srt");
		tauri.readSubtitleFile.mockReset().mockResolvedValue(SRT);
		tauri.mpvSubAdd.mockReset().mockResolvedValue();
		tauri.mpvSubRemove.mockReset().mockResolvedValue();
		Element.prototype.scrollIntoView = vi.fn();
	});

	afterEach(() => {
		// React warns once about a list with no keys, so every test looks for it.
		const keyWarnings = consoleError.mock.calls.filter(([message]) =>
			String(message).includes('unique "key"')
		);
		vi.restoreAllMocks();
		expect(keyWarnings).toEqual([]);
	});

	describe("the languages", () => {
		it("names the panel and offers Off and the text settings while it searches", () => {
			tauri.searchSubtitles.mockReturnValue(new Promise(() => {}));
			renderPanel();
			expect(screen.getByRole("dialog", { name: "Subtitles" })).toBeInTheDocument();
			expect(screen.getByRole("heading", { name: "Subtitles" })).toBeInTheDocument();
			expect(
				within(languages())
					.getAllByRole("option")
					.map((row) => row.textContent)
			).toEqual(["Off", "Text and timing"]);
			expect(screen.getByText("Searching for subtitles")).toBeInTheDocument();
			expect(screen.queryByText("No subtitles found")).not.toBeInTheDocument();
		});

		it("says when the search finds nothing", async () => {
			tauri.searchSubtitles.mockResolvedValue({ languages: [], entries: [] });
			await renderFound();
			expect(screen.getByText("No subtitles found")).toBeInTheDocument();
		});

		it("shows what went wrong when the search fails", async () => {
			tauri.searchSubtitles.mockRejectedValue("The service is down");
			await renderFound();
			expect(screen.getByText("The service is down").tagName).toBe("P");
		});

		it("lists each language found with how many subtitles it has", async () => {
			await renderFound();
			expect(
				within(languages())
					.getAllByRole("option")
					.map((row) => row.textContent)
			).toEqual([
				"Off",
				"Text and timing",
				`${languageName("en")}2`,
				`${languageName("fr")}1`,
			]);
		});

		it("says nothing in the right column while the cursor is on Off", async () => {
			await renderFound();
			expect(languageCursor()).toHaveTextContent("Off");
			expect(releases()).toBeNull();
			expect(screen.queryByText("No subtitles found")).not.toBeInTheDocument();
			expect(screen.queryByText("Searching for subtitles")).not.toBeInTheDocument();
		});

		it("marks Off as in use while no subtitle is", async () => {
			await renderFound();
			expect(within(choice("Off")).getByLabelText("In use")).toBeInTheDocument();
			expect(
				within(choice("Text and timing")).queryByLabelText("In use")
			).not.toBeInTheDocument();
		});

		it("sets the text settings apart from the languages with an icon and an arrow", async () => {
			await renderFound();
			const icons = (name: string) => choice(name).querySelectorAll("svg").length;
			expect(icons("Text and timing")).toBe(2);
			expect(icons(languageName("en"))).toBe(0);
		});

		it("takes the focus to the row under the cursor", async () => {
			await renderFound();
			expect(languageCursor()).toHaveFocus();
		});
	});

	describe("the releases", () => {
		it("shows the releases of the language under the cursor", async () => {
			await renderFound();
			press("ArrowDown");
			press("ArrowDown");
			expect(languageCursor()).toHaveTextContent(languageName("en"));
			expect(
				within(releases()!)
					.getAllByRole("option")
					.map((row) => row.textContent)
			).toEqual(["Sintel.Clear", "Sintel.SDH"]);
		});

		it("calls a release with no name by its number", async () => {
			await renderFound();
			fireEvent.click(choice(languageName("fr")));
			expect(within(releases()!).getByRole("option").textContent).toBe("Subtitle 3");
		});

		it("goes to the releases with OK on a language", async () => {
			await renderFound();
			press("ArrowDown");
			press("ArrowDown");
			placeColumns();
			press("Enter");
			expect(releaseCursor()).toHaveFocus();
			expect(releaseCursor()).toHaveTextContent("Sintel.Clear");
			expect(tauri.mpvSubRemove).not.toHaveBeenCalled();
		});

		it("starts at the first release of another language", async () => {
			await renderFound();
			press("ArrowDown");
			press("ArrowDown");
			placeColumns();
			press("Enter");
			press("ArrowDown");
			expect(releaseCursor()).toHaveTextContent("Sintel.SDH");
			fireEvent.click(choice(languageName("fr")));
			expect(releaseCursor()).toHaveTextContent("Subtitle 3");
			fireEvent.click(choice(languageName("en")));
			expect(releaseCursor()).toHaveTextContent("Sintel.Clear");
		});

		it("shows eight releases at a time, with one more ready below", async () => {
			const many = Array.from({ length: 12 }, (_, i) => entry(100 + i, "en", `Release ${i}`));
			tauri.searchSubtitles.mockResolvedValue({ languages: ["en"], entries: many });
			await renderFound();
			fireEvent.click(choice(languageName("en")));
			expect(within(releases()!).getAllByRole("option")).toHaveLength(9);
		});

		it("treats a language with no code as a language, not as Off or the text settings", async () => {
			tauri.searchSubtitles.mockResolvedValue({
				languages: [""],
				entries: [entry(4, "", "Sintel.Unknown")],
			});
			const { onClose } = await renderFound();
			press("ArrowDown");
			press("ArrowDown");
			placeColumns();
			press("Enter");
			expect(releaseCursor()).toHaveTextContent("Sintel.Unknown");
			expect(releaseCursor()).toHaveFocus();
			expect(onClose).not.toHaveBeenCalled();
			expect(tauri.mpvSubRemove).not.toHaveBeenCalled();
		});

		it("adds the release OK picks, shows it loading, and then closes", async () => {
			const download = deferred<string>();
			tauri.downloadSubtitle.mockReturnValue(download.promise);
			const { onClose, onSubtitleSelected } = await renderFound();
			press("ArrowDown");
			press("ArrowDown");
			placeColumns();
			press("Enter");
			press("ArrowDown");
			press("Enter");
			expect(tauri.downloadSubtitle).toHaveBeenCalledWith(SDH.fileId);
			const rows = within(releases()!).getAllByRole("option");
			expect(within(rows[1]).getByLabelText("Loading")).toBeInTheDocument();
			expect(within(rows[0]).queryByLabelText("Loading")).not.toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();
			await act(async () => {
				download.resolve("/tmp/sub.srt");
				await download.promise;
			});
			await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
			expect(tauri.mpvSubAdd).toHaveBeenCalledWith("/tmp/sub.srt", true, STREAM);
			expect(onSubtitleSelected).toHaveBeenCalledWith(SDH.fileId, expect.any(Array), SDH, 1);
		});

		it("says so when a release won't load, and stays open", async () => {
			tauri.downloadSubtitle.mockRejectedValue(new Error("gone"));
			const { onClose } = await renderFound();
			fireEvent.click(choice(languageName("fr")));
			fireEvent.click(within(releases()!).getByRole("option"));
			expect(
				await screen.findByText("Failed to load subtitle. Try another.")
			).toBeInTheDocument();
			expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();
		});
	});

	describe("the subtitle in use", () => {
		it("opens on its language and marks it, not Off", async () => {
			await renderFound({ currentSelectedId: SDH.fileId, currentSelectedEntry: SDH });
			expect(languageCursor()).toHaveTextContent(languageName("en"));
			expect(within(choice("Off")).queryByLabelText("In use")).not.toBeInTheDocument();
			const rows = within(releases()!).getAllByRole("option");
			expect(within(rows[1]).getByLabelText("In use")).toBeInTheDocument();
			expect(within(rows[0]).queryByLabelText("In use")).not.toBeInTheDocument();
		});

		it("opens on Off when no subtitle is in use, whatever entry it was given", async () => {
			await renderFound({ currentSelectedId: null, currentSelectedEntry: SDH });
			expect(languageCursor()).toHaveTextContent("Off");
		});

		it("lets the cursor move away from its language", async () => {
			await renderFound({ currentSelectedId: SDH.fileId, currentSelectedEntry: SDH });
			press("ArrowDown");
			expect(languageCursor()).toHaveTextContent(languageName("fr"));
		});

		it("opens on Off when its language has gone from the list", async () => {
			const german = entry(9, "de", "Sintel.DE");
			await renderFound({ currentSelectedId: german.fileId, currentSelectedEntry: german });
			expect(languageCursor()).toHaveTextContent("Off");
		});
	});

	describe("Off", () => {
		it("takes the subtitles out and closes on OK", async () => {
			const { onClose, onSubtitleSelected } = await renderFound({
				currentSelectedId: SDH.fileId,
				currentSelectedEntry: SDH,
			});
			fireEvent.click(choice("Off"));
			expect(tauri.mpvSubRemove).toHaveBeenCalledWith(-1);
			expect(onSubtitleSelected).toHaveBeenCalledWith(null, [], null, undefined);
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe("Back", () => {
		it("closes the panel from the languages", async () => {
			const { onClose } = await renderFound();
			press("Escape");
			expect(onClose).toHaveBeenCalledTimes(1);
		});
	});

	describe("the text settings", () => {
		const openStyle = async (style: Partial<TvSubtitleStyle> = {}) => {
			const props = await renderFound({ style: makeStyle(style) });
			press("ArrowDown");
			press("Enter");
			return props;
		};

		const settings = () => screen.getByRole("listbox", { name: "Text and timing" });
		const setting = (name: string) =>
			within(settings()).getByRole("option", { name: RegExp(`^${name}`) });

		/** Moves the cursor down to the row at `index`. */
		const goToRow = (index: number) => {
			for (let i = 0; i < index; i++) press("ArrowDown");
		};

		it("opens from its row with the current values, without closing the panel", async () => {
			const { onClose } = await openStyle({ delay: 0.5, position: { x: 50, y: 80 } });
			expect(screen.getByRole("dialog", { name: "Text and timing" })).toBeInTheDocument();
			expect(screen.getByRole("heading", { name: "Text and timing" })).toBeInTheDocument();
			expect(setting("Size")).toHaveTextContent("Size26");
			expect(setting("Font")).toHaveTextContent("FontDefault");
			expect(setting("Delay")).toHaveTextContent("Delay+0.5s");
			expect(setting("Height")).toHaveTextContent("Height20%");
			expect(
				screen.getByText("Left or Right changes a value. Back returns to the subtitles.")
			).toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();
			expect(tauri.mpvSubRemove).not.toHaveBeenCalled();
			expect(setting("Size")).toHaveFocus();
		});

		it("returns to the languages on Back, and leaves the panel open", async () => {
			const { onClose } = await openStyle();
			press("Escape");
			expect(screen.getByRole("dialog", { name: "Subtitles" })).toBeInTheDocument();
			expect(onClose).not.toHaveBeenCalled();
		});

		it("steps the size with Left and Right", async () => {
			const onFontSizeChange = vi.fn();
			await openStyle({ onFontSizeChange });
			expect(press("ArrowRight")).toBe(false);
			expect(onFontSizeChange).toHaveBeenLastCalledWith(28);
			expect(press("ArrowLeft")).toBe(false);
			expect(onFontSizeChange).toHaveBeenLastCalledWith(24);
		});

		it("steps through the fonts, going round at both ends", async () => {
			const onFontFamilyChange = vi.fn();
			await openStyle({ onFontFamilyChange });
			goToRow(1);
			press("ArrowRight");
			expect(onFontFamilyChange).toHaveBeenLastCalledWith(FONT_FAMILIES[1].value);
			press("ArrowLeft");
			expect(onFontFamilyChange).toHaveBeenLastCalledWith(FONT_FAMILIES[3].value);
		});

		it("goes back to the first font after the last", async () => {
			const onFontFamilyChange = vi.fn();
			await openStyle({ fontFamily: FONT_FAMILIES[3].value, onFontFamilyChange });
			expect(setting("Font")).toHaveTextContent("FontMonospace");
			goToRow(1);
			press("ArrowRight");
			expect(onFontFamilyChange).toHaveBeenLastCalledWith(FONT_FAMILIES[0].value);
			press("ArrowLeft");
			expect(onFontFamilyChange).toHaveBeenLastCalledWith(FONT_FAMILIES[2].value);
		});

		it("counts a font it doesn't know as the first one", async () => {
			const onFontFamilyChange = vi.fn();
			await openStyle({ fontFamily: "Comic Sans", onFontFamilyChange });
			expect(setting("Font")).toHaveTextContent("FontDefault");
			goToRow(1);
			press("ArrowRight");
			expect(onFontFamilyChange).toHaveBeenLastCalledWith(FONT_FAMILIES[1].value);
		});

		it("steps the delay by a tenth of a second", async () => {
			const onDelayChange = vi.fn();
			await openStyle({ delay: 0.2, onDelayChange });
			goToRow(2);
			press("ArrowRight");
			expect(onDelayChange).toHaveBeenLastCalledWith(0.3);
			press("ArrowLeft");
			expect(onDelayChange).toHaveBeenLastCalledWith(0.1);
		});

		it("raises the text with Right and lowers it with Left", async () => {
			const onPositionChange = vi.fn();
			await openStyle({ onPositionChange });
			goToRow(3);
			press("ArrowRight");
			expect(onPositionChange).toHaveBeenLastCalledWith({ x: 50, y: 86 });
			press("ArrowLeft");
			expect(onPositionChange).toHaveBeenLastCalledWith({ x: 50, y: 90 });
		});

		it("leaves the other keys alone", async () => {
			const onFontSizeChange = vi.fn();
			await openStyle({ onFontSizeChange });
			expect(press("Enter")).toBe(true);
			press("ArrowDown");
			press("ArrowUp");
			expect(setting("Size")).toHaveFocus();
			expect(onFontSizeChange).not.toHaveBeenCalled();
		});
	});
});
