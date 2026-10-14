// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useRef, useState, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import type { SubtitleEntry, SubtitleSearchResult } from "@/lib/types";
import { SubtitlePicker } from "./SubtitlePicker";

/** A search that never answers, so the delay tests see only the loading list. */
const pendingSearch = () => new Promise<SubtitleSearchResult | null>(() => {});

const tauri = vi.hoisted(() => ({
	searchSubtitles:
		vi.fn<
			(
				imdbId: string,
				season?: number,
				episode?: number
			) => Promise<SubtitleSearchResult | null>
		>(),
	downloadSubtitle: vi.fn<(fileId: number) => Promise<string>>(),
	readSubtitleFile: vi.fn<(path: string) => Promise<string>>(),
	mpvSubAdd: vi.fn<(path: string, overlay: boolean) => Promise<void>>(),
	mpvSubRemove: vi.fn<(id: number) => Promise<void>>(),
}));

vi.mock("@/lib/tauri", () => tauri);

tauri.searchSubtitles.mockImplementation(pendingSearch);

// Holds the delay the way VideoPlayer does, so each change comes back as a prop.
const Harness = () => {
	const [delay, setDelay] = useState(0);
	return (
		<SubtitlePicker
			imdbId="tt0000001"
			onClose={() => {}}
			subtitleDelay={delay}
			onDelayChange={setDelay}
		/>
	);
};

/** A confirm, which opens outside the picker. */
const Confirm = () => {
	const ref = useRef<HTMLDivElement>(null);
	useFocusTrap(ref);
	return (
		<div ref={ref} role="dialog">
			<button>OK</button>
		</div>
	);
};

const WithConfirm = ({ confirm }: { confirm: boolean }) => (
	<>
		<Harness />
		{confirm && <Confirm />}
	</>
);

const openSettings = () => {
	fireEvent.click(screen.getByRole("button", { name: "Subtitle settings" }));
};

describe("SubtitlePicker delay buttons", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it("keeps stepping while the button is held", () => {
		render(<Harness />);
		openSettings();
		const plus = screen.getByRole("button", { name: "Increase subtitle delay" });

		fireEvent.mouseDown(plus);
		expect(screen.getByText("+0.1s")).toBeInTheDocument();

		act(() => {
			vi.advanceTimersByTime(400);
		});
		expect(screen.getByText("+0.3s")).toBeInTheDocument();

		fireEvent.mouseUp(plus);
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(screen.getByText("+0.3s")).toBeInTheDocument();
	});

	it("steps backwards while minus is held", () => {
		render(<Harness />);
		openSettings();
		const minus = screen.getByRole("button", { name: "Decrease subtitle delay" });

		fireEvent.mouseDown(minus);
		act(() => {
			vi.advanceTimersByTime(200);
		});
		fireEvent.mouseLeave(minus);
		expect(screen.getByText("-0.2s")).toBeInTheDocument();
	});

	it("steps once for a keyboard click", () => {
		render(<Harness />);
		openSettings();
		const plus = screen.getByRole("button", { name: "Increase subtitle delay" });

		// Enter and Space fire a click with no press count and no mousedown.
		fireEvent.click(plus, { detail: 0 });
		expect(screen.getByText("+0.1s")).toBeInTheDocument();
	});

	it("does not step twice for a mouse click", () => {
		render(<Harness />);
		openSettings();
		const minus = screen.getByRole("button", { name: "Decrease subtitle delay" });

		fireEvent.mouseDown(minus);
		fireEvent.mouseUp(minus);
		fireEvent.click(minus, { detail: 1 });
		expect(screen.getByText("-0.1s")).toBeInTheDocument();
	});

	it("ignores a right click", () => {
		render(<Harness />);
		openSettings();
		const plus = screen.getByRole("button", { name: "Increase subtitle delay" });

		fireEvent.mouseDown(plus, { button: 2 });
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(screen.getByText("0.0s")).toBeInTheDocument();
	});

	it("keeps one hold running when a second press arrives without a release", () => {
		render(<Harness />);
		openSettings();
		const plus = screen.getByRole("button", { name: "Increase subtitle delay" });

		fireEvent.mouseDown(plus);
		fireEvent.mouseDown(plus);
		expect(screen.getByText("+0.2s")).toBeInTheDocument();

		fireEvent.mouseUp(plus);
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(screen.getByText("+0.2s")).toBeInTheDocument();
	});

	it("stops the hold when the window loses focus", () => {
		render(<Harness />);
		openSettings();
		const plus = screen.getByRole("button", { name: "Increase subtitle delay" });

		fireEvent.mouseDown(plus);
		fireEvent.blur(window);
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(screen.getByText("+0.1s")).toBeInTheDocument();
	});
});

describe("SubtitlePicker button names", () => {
	afterEach(() => {
		cleanup();
	});

	it("names the icon and symbol buttons", () => {
		render(<Harness />);
		expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
		openSettings();
		for (const name of [
			"Smaller subtitles",
			"Larger subtitles",
			"Decrease subtitle delay",
			"Increase subtitle delay",
		]) {
			expect(screen.getByRole("button", { name })).toBeInTheDocument();
		}
	});
});

const english: SubtitleEntry = {
	fileId: 11,
	languageCode: "en",
	format: "srt",
	releaseName: "Sintel.2010.720p",
};
const unnamed: SubtitleEntry = { fileId: 12, languageCode: "en", format: "vtt" };
const dutch: SubtitleEntry = {
	fileId: 21,
	languageCode: "nl",
	format: "srt",
	releaseName: "Sintel.NL",
};
const found: SubtitleSearchResult = { entries: [english, unnamed, dutch], languages: ["en", "nl"] };

const SRT =
	"1\n00:00:01,000 --> 00:00:02,500\nHello there\n\n2\n00:00:03,000 --> 00:00:04,000\nGoodbye\n";
const CUES = [
	{ start: 1, end: 2.5, text: "Hello there" },
	{ start: 3, end: 4, text: "Goodbye" },
];

type PickerProps = ComponentProps<typeof SubtitlePicker>;

const renderPicker = (props: Partial<PickerProps> = {}) => {
	const all: PickerProps = {
		imdbId: "tt1727587",
		onClose: vi.fn(),
		onSubtitleSelected: vi.fn(),
		...props,
	};
	return { ...render(<SubtitlePicker {...all} />), ...all };
};

/** The list button for a subtitle, found by the name it shows. */
const entryButton = (name: string) => screen.getByText(name).closest("button") as HTMLButtonElement;

const hasCheck = (el: Element) => el.querySelector(".lucide-check") !== null;

describe("SubtitlePicker search and selection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		tauri.searchSubtitles.mockResolvedValue(found);
		tauri.downloadSubtitle.mockImplementation(async (id) => `/subs/${id}.srt`);
		tauri.readSubtitleFile.mockResolvedValue(SRT);
		tauri.mpvSubAdd.mockResolvedValue();
		tauri.mpvSubRemove.mockResolvedValue();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
		tauri.searchSubtitles.mockImplementation(pendingSearch);
	});

	it("searches for the episode's subtitles and lists them by language", async () => {
		renderPicker({ season: 1, episode: 2 });
		expect(screen.getByText("Searching…")).toBeInTheDocument();
		expect(tauri.searchSubtitles).toHaveBeenCalledExactlyOnceWith("tt1727587", 1, 2);

		expect(await screen.findByText("en (2)")).toBeInTheDocument();
		expect(screen.getByText("nl (1)")).toBeInTheDocument();
		expect(screen.queryByText("Searching…")).toBeNull();
		expect(entryButton("Sintel.2010.720p")).toHaveTextContent(".srt");
		// A subtitle without a release name goes by its file id.
		expect(entryButton("Subtitle 12")).toHaveTextContent(".vtt");
		expect(entryButton("Sintel.NL")).toBeInTheDocument();
		expect(hasCheck(entryButton("None"))).toBe(true);
	});

	it("says nothing was found when the search comes back empty", async () => {
		tauri.searchSubtitles.mockResolvedValue({ entries: [], languages: [] });
		renderPicker();
		expect(await screen.findByText("No subtitles found")).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /None/ })).toBeNull();
	});

	it("says nothing was found when the search has no answer", async () => {
		tauri.searchSubtitles.mockResolvedValue(null);
		renderPicker();
		expect(await screen.findByText("No subtitles found")).toBeInTheDocument();
	});

	it("shows why the search failed", async () => {
		tauri.searchSubtitles.mockRejectedValue("OpenSubtitles quota reached");
		renderPicker();
		expect(await screen.findByText("OpenSubtitles quota reached")).toBeInTheDocument();
		expect(screen.queryByText("Searching…")).toBeNull();
	});

	it("loads a picked subtitle into the player and hands its cues to the caller", async () => {
		const { onSubtitleSelected, onClose } = renderPicker();
		await screen.findByText("en (2)");

		fireEvent.click(entryButton("Subtitle 12"));
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
		expect(tauri.downloadSubtitle).toHaveBeenCalledExactlyOnceWith(12);
		expect(tauri.readSubtitleFile).toHaveBeenCalledExactlyOnceWith("/subs/12.srt");
		// The overlay draws the subtitles, so mpv doesn't. The new track takes
		// the place of the old one once the file is read, so the old one stays
		// until then.
		expect(tauri.mpvSubAdd).toHaveBeenCalledExactlyOnceWith("/subs/12.srt", true);
		expect(tauri.readSubtitleFile.mock.invocationCallOrder[0]).toBeLessThan(
			tauri.mpvSubAdd.mock.invocationCallOrder[0]
		);
		expect(tauri.mpvSubRemove).not.toHaveBeenCalled();
		// Second in its language, which the player uses to pick one for the next episode.
		expect(onSubtitleSelected).toHaveBeenCalledExactlyOnceWith(12, CUES, unnamed, 1);
	});

	it("lets the player draw a subtitle the overlay can't read", async () => {
		tauri.readSubtitleFile.mockResolvedValue("[Script Info]\nTitle: Sintel\n");
		const { onSubtitleSelected } = renderPicker();
		await screen.findByText("en (2)");

		fireEvent.click(entryButton("Sintel.NL"));
		await waitFor(() =>
			expect(onSubtitleSelected).toHaveBeenCalledExactlyOnceWith(21, [], dutch, 0)
		);
		expect(tauri.mpvSubAdd).toHaveBeenCalledExactlyOnceWith("/subs/21.srt", false);
		expect(tauri.mpvSubRemove).not.toHaveBeenCalled();
	});

	it("lets the player draw a subtitle file that isn't UTF-8", async () => {
		tauri.readSubtitleFile.mockRejectedValue(new Error("stream did not contain valid UTF-8"));
		const { onSubtitleSelected, onClose } = renderPicker();
		await screen.findByText("en (2)");

		fireEvent.click(entryButton("Sintel.NL"));
		await waitFor(() =>
			expect(onSubtitleSelected).toHaveBeenCalledExactlyOnceWith(21, [], dutch, 0)
		);
		expect(tauri.mpvSubAdd).toHaveBeenCalledExactlyOnceWith("/subs/21.srt", false);
		expect(onClose).toHaveBeenCalledOnce();
		expect(screen.queryByText("Failed to load subtitle. Try another.")).not.toBeInTheDocument();
	});

	it("asks for another subtitle when neither it nor the player can read the file", async () => {
		const failure = new Error("Can not open external file");
		tauri.readSubtitleFile.mockResolvedValue("[Script Info]\nTitle: Sintel\n");
		tauri.mpvSubAdd.mockRejectedValue(failure);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { onSubtitleSelected, onClose } = renderPicker();
			await screen.findByText("en (2)");

			fireEvent.click(entryButton("Sintel.NL"));
			expect(
				await screen.findByText("Failed to load subtitle. Try another.")
			).toBeInTheDocument();
			expect(consoleError).toHaveBeenCalledWith(
				"[SubtitlePicker] subtitle load error:",
				failure
			);
			expect(onSubtitleSelected).not.toHaveBeenCalled();
			expect(onClose).not.toHaveBeenCalled();
		} finally {
			consoleError.mockRestore();
		}
	});

	it("shows subtitles it can read even when the player can't add them", async () => {
		tauri.mpvSubAdd.mockRejectedValue(new Error("no mpv instance"));
		const { onSubtitleSelected } = renderPicker();
		await screen.findByText("en (2)");

		fireEvent.click(entryButton("Sintel.NL"));
		await waitFor(() =>
			expect(onSubtitleSelected).toHaveBeenCalledExactlyOnceWith(21, CUES, dutch, 0)
		);
		expect(screen.queryByText("Failed to load subtitle. Try another.")).not.toBeInTheDocument();
	});

	it("shows a spinner on the subtitle loading and holds the others until it's done", async () => {
		let finish!: (path: string) => void;
		tauri.downloadSubtitle.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			})
		);
		const { onSubtitleSelected } = renderPicker();
		await screen.findByText("en (2)");

		fireEvent.click(entryButton("Sintel.2010.720p"));
		await act(async () => {});
		expect(entryButton("Sintel.2010.720p").querySelector(".animate-spin")).not.toBeNull();
		expect(entryButton("Sintel.NL")).toBeDisabled();
		fireEvent.click(entryButton("Sintel.NL"));
		expect(tauri.downloadSubtitle).toHaveBeenCalledTimes(1);

		await act(async () => finish("/subs/11.srt"));
		expect(onSubtitleSelected).toHaveBeenCalledExactlyOnceWith(11, CUES, english, 0);
		expect(entryButton("Sintel.NL")).toBeEnabled();
	});

	it("drops a subtitle that finishes loading after the player moves on", async () => {
		let finish!: (path: string) => void;
		tauri.downloadSubtitle.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			})
		);
		let current = true;
		const { onSubtitleSelected, onClose } = renderPicker({ isCurrent: () => current });
		await screen.findByText("en (2)");

		fireEvent.click(entryButton("Sintel.2010.720p"));
		await act(async () => {});
		current = false;
		await act(async () => finish("/subs/11.srt"));
		expect(entryButton("Sintel.NL")).toBeEnabled();
		// The track mpv has now belongs to the item the player moved on to.
		expect(tauri.mpvSubRemove).not.toHaveBeenCalled();
		expect(tauri.mpvSubAdd).not.toHaveBeenCalled();
		expect(onSubtitleSelected).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("drops a subtitle that mpv adds after the player moves on", async () => {
		tauri.readSubtitleFile.mockResolvedValue("[Script Info]\nTitle: Sintel\n");
		let added!: () => void;
		tauri.mpvSubAdd.mockReturnValue(
			new Promise((resolve) => {
				added = resolve;
			})
		);
		let current = true;
		const { onSubtitleSelected, onClose } = renderPicker({ isCurrent: () => current });
		await screen.findByText("en (2)");

		fireEvent.click(entryButton("Sintel.NL"));
		await waitFor(() =>
			expect(tauri.mpvSubAdd).toHaveBeenCalledExactlyOnceWith("/subs/21.srt", false)
		);
		current = false;
		await act(async () => added());
		expect(entryButton("Sintel.NL")).toBeEnabled();
		expect(hasCheck(entryButton("Sintel.NL"))).toBe(false);
		expect(onSubtitleSelected).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("asks for another subtitle when one can't be loaded", async () => {
		const failure = new Error("download failed");
		tauri.downloadSubtitle.mockRejectedValue(failure);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { onSubtitleSelected, onClose } = renderPicker();
			await screen.findByText("en (2)");

			fireEvent.click(entryButton("Sintel.2010.720p"));
			expect(
				await screen.findByText("Failed to load subtitle. Try another.")
			).toBeInTheDocument();
			expect(consoleError).toHaveBeenCalledWith(
				"[SubtitlePicker] subtitle load error:",
				failure
			);
			expect(onSubtitleSelected).not.toHaveBeenCalled();
			expect(onClose).not.toHaveBeenCalled();
			// The subtitle in use stays.
			expect(tauri.mpvSubRemove).not.toHaveBeenCalled();
			expect(entryButton("Sintel.NL")).toBeEnabled();
			expect(hasCheck(entryButton("Sintel.2010.720p"))).toBe(false);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("pins the subtitle in use at the top and turns subtitles off with None", async () => {
		const { onSubtitleSelected, onClose } = renderPicker({
			currentSelectedId: 12,
			currentSelectedEntry: unnamed,
		});
		await screen.findByText("en (2)");
		expect(screen.getByText("Active")).toBeInTheDocument();
		expect(screen.getAllByText("Subtitle 12")).toHaveLength(2);
		expect(hasCheck(entryButton("None"))).toBe(false);
		expect(hasCheck(screen.getAllByText("Subtitle 12")[1].closest("button")!)).toBe(true);

		fireEvent.click(entryButton("None"));
		await waitFor(() =>
			expect(onSubtitleSelected).toHaveBeenCalledExactlyOnceWith(null, [], null, undefined)
		);
		expect(tauri.mpvSubRemove).toHaveBeenCalledExactlyOnceWith(-1);
		expect(screen.queryByText("Active")).toBeNull();
		expect(hasCheck(entryButton("None"))).toBe(true);
		expect(onClose).not.toHaveBeenCalled();
	});

	it("closes on a click outside it but not on one inside it", async () => {
		const { onClose } = renderPicker();
		await screen.findByText("en (2)");

		fireEvent.mouseDown(screen.getByText("Subtitles"));
		expect(onClose).not.toHaveBeenCalled();

		fireEvent.mouseDown(document.body);
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it("closes from its close button", async () => {
		const { onClose } = renderPicker();
		await screen.findByText("en (2)");
		fireEvent.click(screen.getByRole("button", { name: "Close" }));
		expect(onClose).toHaveBeenCalledTimes(1);
	});
});

describe("SubtitlePicker settings", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("tells the player when the settings open and close", () => {
		const onSettingsModeChange = vi.fn();
		renderPicker({ onSettingsModeChange });
		expect(onSettingsModeChange).toHaveBeenLastCalledWith(false);
		expect(screen.queryByText("Subtitle Settings")).toBeNull();

		openSettings();
		expect(screen.getByText("Subtitle Settings")).toBeInTheDocument();
		expect(onSettingsModeChange).toHaveBeenLastCalledWith(true);

		fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
		expect(screen.queryByText("Subtitle Settings")).toBeNull();
		expect(onSettingsModeChange).toHaveBeenLastCalledWith(false);

		openSettings();
		openSettings();
		expect(screen.queryByText("Subtitle Settings")).toBeNull();
	});

	it("offers four fonts and passes the one picked", () => {
		const onFontFamilyChange = vi.fn();
		renderPicker({ subtitleFontFamily: "Arial, Helvetica, sans-serif", onFontFamilyChange });
		openSettings();
		const select = screen.getByRole("combobox") as HTMLSelectElement;
		expect(Array.from(select.options).map((o) => o.textContent)).toEqual([
			"Default",
			"Sans-serif",
			"Serif",
			"Monospace",
		]);
		expect(select.selectedOptions[0].textContent).toBe("Sans-serif");

		fireEvent.change(select, { target: { value: "'Courier New', Courier, monospace" } });
		expect(onFontFamilyChange).toHaveBeenCalledExactlyOnceWith(
			"'Courier New', Courier, monospace"
		);
	});

	it("changes the size two pixels at a time between 12 and 40", () => {
		const onFontSizeChange = vi.fn();
		const { rerender, imdbId, onClose } = renderPicker({
			subtitleFontSize: 18,
			onFontSizeChange,
		});
		openSettings();
		expect(screen.getByText("18px")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("button", { name: "Smaller subtitles" }));
		expect(onFontSizeChange).toHaveBeenLastCalledWith(16);
		fireEvent.click(screen.getByRole("button", { name: "Larger subtitles" }));
		expect(onFontSizeChange).toHaveBeenLastCalledWith(20);

		const at = (size: number) =>
			rerender(
				<SubtitlePicker
					imdbId={imdbId}
					onClose={onClose}
					subtitleFontSize={size}
					onFontSizeChange={onFontSizeChange}
				/>
			);
		at(13);
		fireEvent.click(screen.getByRole("button", { name: "Smaller subtitles" }));
		expect(onFontSizeChange).toHaveBeenLastCalledWith(12);
		at(39);
		fireEvent.click(screen.getByRole("button", { name: "Larger subtitles" }));
		expect(onFontSizeChange).toHaveBeenLastCalledWith(40);
	});

	it("nudges the delay with the arrow keys only while the pointer is over it", () => {
		render(<Harness />);
		openSettings();
		const delaySection = screen.getByText("Delay").parentElement as HTMLElement;

		fireEvent.keyDown(document, { key: "ArrowRight" });
		expect(screen.getByText("0.0s")).toBeInTheDocument();

		fireEvent.mouseEnter(delaySection);
		// The key is used up here, so the player doesn't seek or move the subtitle as well.
		expect(fireEvent.keyDown(document, { key: "ArrowRight" })).toBe(false);
		expect(screen.getByText("+0.1s")).toBeInTheDocument();
		fireEvent.keyDown(document, { key: "ArrowLeft" });
		fireEvent.keyDown(document, { key: "ArrowLeft" });
		expect(screen.getByText("-0.1s")).toBeInTheDocument();
		expect(fireEvent.keyDown(document, { key: "ArrowUp" })).toBe(true);
		expect(screen.getByText("-0.1s")).toBeInTheDocument();

		fireEvent.mouseLeave(delaySection);
		fireEvent.keyDown(document, { key: "ArrowRight" });
		expect(screen.getByText("-0.1s")).toBeInTheDocument();
	});

	it("leaves the arrow keys to a confirm open over it", () => {
		const { rerender } = render(<WithConfirm confirm={false} />);
		openSettings();
		fireEvent.mouseEnter(screen.getByText("Delay").parentElement as HTMLElement);
		rerender(<WithConfirm confirm />);

		const ok = screen.getByRole("button", { name: "OK" });
		expect(fireEvent.keyDown(ok, { key: "ArrowRight" })).toBe(true);
		expect(screen.getByText("0.0s")).toBeInTheDocument();
	});
});
