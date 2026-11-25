// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import type { NowNext } from "@/hooks/useNowNext";
import type { TvView } from "@/hooks/useTvPlayer";
import { formatHHMM } from "@/lib/epg-window";
import { LIVE_SLACK } from "@/lib/live-seek";
import type { Channel, EpgProgram } from "@/lib/types";
import { makeChannel } from "@/test/channel-fixtures";
import type { TvRowOptions, TvTileOptions } from "./tv-buttons";
import { timeLeft, TvControls, tvSubtitleTop, type TvLiveBar, type TvVideoBar } from "./TvControls";

const NOW = 1_800_000_000;

const guide = vi.hoisted(() => ({
	of: vi.fn<(channel: Channel) => NowNext>(),
}));

vi.mock("@/hooks/useNow", () => ({ useNow: () => NOW }));
vi.mock("@/hooks/useNowNext", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/hooks/useNowNext")>()),
	useNowNext: () => ({ now: NOW, nowNextOf: guide.of }),
}));

const NEWS = makeChannel({ id: "news", name: "News 24", contentType: "live" });

const program = (title: string, startTime: number, endTime: number): EpgProgram => ({
	channelId: "news",
	title,
	startTime,
	endTime,
});

/** An episode's row: its info, the skips each side of Pause, and its subtitles, which show. */
const makeRow = (overrides: Partial<TvRowOptions> = {}): TvRowOptions => ({
	live: false,
	series: true,
	paused: false,
	retrying: false,
	onRetry: vi.fn(),
	onTogglePlay: vi.fn(),
	skip: { back: 10, forward: 30 },
	onSkip: vi.fn(),
	atLive: true,
	onZap: vi.fn(),
	onGuide: vi.fn(),
	onSubtitles: vi.fn(),
	subtitlesOn: true,
	onInfo: vi.fn(),
	...overrides,
});

/** Its speed, and a download it can't do. */
const makeTiles = (): TvTileOptions => ({
	live: false,
	onSource: vi.fn(),
	onAutoplayChange: vi.fn(),
	onAudio: vi.fn(),
	speed: "Normal",
	onSpeed: vi.fn(),
});

const VIDEO: TvVideoBar = { kind: "video", position: 30, duration: 120, bufferedTo: 60, speed: 1 };

const live = (overrides: Partial<TvLiveBar> = {}): TvLiveBar => ({
	kind: "live",
	channel: NEWS,
	behind: 0,
	buffered: null,
	rewind: 300,
	...overrides,
});

type Props = ComponentProps<typeof TvControls>;

const makeProps = (overrides: Partial<Props> = {}): Props => ({
	view: "controls",
	strip: false,
	hint: "OK pauses.",
	bar: VIDEO,
	row: makeRow(),
	tiles: makeTiles(),
	details: <p>The Lantern Keeper</p>,
	onViewChange: vi.fn(),
	onLeave: vi.fn(),
	onHide: vi.fn(),
	...overrides,
});

const controls = () => screen.getByTestId("tv-controls");
const row = () => screen.getByRole("toolbar", { name: "Player" });
const tray = () => screen.getByRole("toolbar", { name: "More" });
const named = (name: string) => screen.getByRole("button", { name });
const bar = () => screen.getByRole("progressbar", { name: "Position" });
/** The filled part of the bar, which shows how far it has played. */
const played = () => bar().querySelector<HTMLElement>(".bg-primary")!;

/** Gives `el` a box, since jsdom lays nothing out and the D-pad skips what has none. */
const place = (el: Element, left: number, top: number) => {
	el.getBoundingClientRect = () =>
		({ left, top, right: left + 100, bottom: top + 40, width: 100, height: 40 }) as DOMRect;
};

describe("tvSubtitleTop", () => {
	it.each<[TvView, number]>([
		["details", 24],
		["tray", 40],
		["controls", 58],
		["none", 72],
	])("puts the subtitles above the %s view", (view, top) => {
		expect(tvSubtitleTop(view)).toBe(top);
	});
});

describe("timeLeft", () => {
	it.each([
		[1350, "23 min left"],
		[60, "1 min left"],
		[3599, "1 h 0 min left"],
		[3900, "1 h 5 min left"],
		[0, "0 min left"],
		[-30, "0 min left"],
	])("says %i seconds as %s", (seconds, text) => {
		expect(timeLeft(seconds)).toBe(text);
	});
});

describe("TvControls", () => {
	beforeEach(() => {
		guide.of.mockReturnValue({ now: null, next: null });
		Element.prototype.scrollIntoView = vi.fn();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("views", () => {
		it("shows only the bar and the hint while no view is open", () => {
			render(<TvControls {...makeProps({ view: "none", strip: true })} />);
			expect(controls()).not.toHaveClass("invisible");
			expect(screen.getByText("OK pauses.").tagName).toBe("P");
			expect(bar()).toBeInTheDocument();
			expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
			expect(screen.queryByText(formatHHMM(NOW))).not.toBeInTheDocument();
			expect(screen.queryByText("The Lantern Keeper")).not.toBeInTheDocument();
			expect(controls().style.background).toContain("rgba(0, 0, 0, 0.85) 0%");
		});

		it("hides even the bar until it's wanted", () => {
			render(<TvControls {...makeProps({ view: "none" })} />);
			expect(controls()).toHaveClass("invisible");
		});

		it("leaves out the hint when there isn't one", () => {
			render(<TvControls {...makeProps({ view: "none", strip: true, hint: undefined })} />);
			expect(controls().querySelector("p")).toBeNull();
		});

		it("shows the row, the time and a way to more with the controls", () => {
			render(<TvControls {...makeProps()} />);
			expect(
				within(row())
					.getAllByRole("button")
					.map((b) => b.getAttribute("aria-label"))
			).toEqual(["Episodes and info", "Back 10 s", "Pause", "Forward 30 s", "Subtitles"]);
			expect(screen.getByText(formatHHMM(NOW))).toBeInTheDocument();
			expect(screen.getByText("More")).toBeInTheDocument();
			expect(screen.queryByText("OK pauses.")).not.toBeInTheDocument();
			expect(screen.queryByText("The Lantern Keeper")).not.toBeInTheDocument();
			expect(screen.queryByRole("toolbar", { name: "More" })).not.toBeInTheDocument();
			expect(controls().style.background).toContain("rgba(0, 0, 0, 0.72) 24%");
		});

		it("adds what plays above the row with the details", () => {
			render(<TvControls {...makeProps({ view: "details" })} />);
			expect(screen.getByText("The Lantern Keeper")).toBeInTheDocument();
			expect(row()).toBeInTheDocument();
			expect(screen.getByText("More")).toBeInTheDocument();
			expect(controls().style.background).toContain("rgba(0, 0, 0, 0.84) 40%");
		});

		it("shades more of a live channel's details, which run taller", () => {
			render(<TvControls {...makeProps({ view: "details", bar: live() })} />);
			expect(controls().style.background).toContain("rgba(0, 0, 0, 0.86) 52%");
		});

		it("puts the tray under the row in place of the way to more", () => {
			render(<TvControls {...makeProps({ view: "tray" })} />);
			expect(row()).toBeInTheDocument();
			expect(
				within(tray())
					.getAllByRole("button")
					.map((b) => b.textContent)
			).toEqual(["SpeedNormal", "DownloadNeeds storage"]);
			expect(screen.queryByText("More")).not.toBeInTheDocument();
			expect(controls().style.background).toContain("rgba(0, 0, 0, 0.78) 36%");
		});

		it("shades the top of the screen for the clock", () => {
			render(<TvControls {...makeProps()} />);
			expect(controls().style.background).toContain("rgba(0, 0, 0, 0.45) 0%");
		});
	});

	describe("focus", () => {
		it("starts on the playback button", () => {
			const focus = vi.spyOn(HTMLElement.prototype, "focus");
			render(<TvControls {...makeProps()} />);
			expect(named("Pause")).toHaveFocus();
			// The page stays put, since the controls sit over the video.
			expect(focus).toHaveBeenCalledWith({ preventScroll: true });
		});

		it("starts the tray on its first option", () => {
			render(<TvControls {...makeProps({ view: "tray" })} />);
			expect(within(tray()).getAllByRole("button")[0]).toHaveFocus();
		});

		it("goes back to the playback button as the tray closes", () => {
			const { rerender } = render(<TvControls {...makeProps({ view: "tray" })} />);
			rerender(<TvControls {...makeProps({ view: "controls" })} />);
			expect(named("Pause")).toHaveFocus();
		});

		it("puts the focus back on the row when its button goes away", () => {
			const { rerender } = render(<TvControls {...makeProps()} />);
			named("Back 10 s").focus();
			rerender(<TvControls {...makeProps({ row: makeRow({ skip: undefined }) })} />);
			expect(named("Pause")).toHaveFocus();
		});

		it("leaves the focus where it is otherwise", () => {
			const { rerender } = render(<TvControls {...makeProps()} />);
			named("Subtitles").focus();
			rerender(<TvControls {...makeProps()} />);
			expect(named("Subtitles")).toHaveFocus();
		});

		it("says the row has gone so the focus can leave it", () => {
			const onHide = vi.fn();
			const { rerender } = render(<TvControls {...makeProps({ onHide })} />);
			expect(onHide).not.toHaveBeenCalled();
			rerender(<TvControls {...makeProps({ view: "none", onHide })} />);
			expect(onHide).toHaveBeenCalledTimes(1);
		});
	});

	describe("keys on the row", () => {
		it("opens the tray on Down from the controls", () => {
			const onViewChange = vi.fn();
			render(<TvControls {...makeProps({ onViewChange })} />);
			expect(fireEvent.keyDown(named("Pause"), { key: "ArrowDown" })).toBe(false);
			expect(onViewChange).toHaveBeenCalledWith("tray");
		});

		it("goes back to the video on Down from the details", () => {
			const onViewChange = vi.fn();
			render(<TvControls {...makeProps({ view: "details", onViewChange })} />);
			expect(fireEvent.keyDown(named("Pause"), { key: "ArrowDown" })).toBe(false);
			expect(onViewChange).toHaveBeenCalledWith("none");
		});

		it("leaves on Up with nothing above the row", () => {
			const onLeave = vi.fn();
			render(<TvControls {...makeProps({ onLeave })} />);
			expect(fireEvent.keyDown(named("Pause"), { key: "ArrowUp" })).toBe(false);
			expect(onLeave).toHaveBeenCalledTimes(1);
		});

		it("goes up to what sits above the row, such as the skip prompt", () => {
			const onLeave = vi.fn();
			render(
				<>
					<button type="button">Skip intro</button>
					<TvControls {...makeProps({ onLeave })} />
				</>
			);
			place(named("Skip intro"), 0, 100);
			within(row())
				.getAllByRole("button")
				.forEach((b, i) => place(b, i * 110, 500));
			fireEvent.keyDown(named("Pause"), { key: "ArrowUp" });
			expect(named("Skip intro")).toHaveFocus();
			expect(onLeave).not.toHaveBeenCalled();
		});

		it("stays put on Up from the details, with nothing above them", () => {
			const onLeave = vi.fn();
			const onViewChange = vi.fn();
			render(<TvControls {...makeProps({ view: "details", onLeave, onViewChange })} />);
			expect(fireEvent.keyDown(named("Pause"), { key: "ArrowUp" })).toBe(false);
			expect(onLeave).not.toHaveBeenCalled();
			expect(onViewChange).not.toHaveBeenCalled();
		});

		it("leaves on Back", () => {
			const onLeave = vi.fn();
			render(<TvControls {...makeProps({ onLeave })} />);
			expect(fireEvent.keyDown(named("Pause"), { key: "Escape" })).toBe(false);
			expect(onLeave).toHaveBeenCalledTimes(1);
		});

		it("lets Left and Right through to move along the row", () => {
			const onLeave = vi.fn();
			const onViewChange = vi.fn();
			render(<TvControls {...makeProps({ onLeave, onViewChange })} />);
			expect(fireEvent.keyDown(named("Pause"), { key: "ArrowLeft" })).toBe(true);
			expect(onLeave).not.toHaveBeenCalled();
			expect(onViewChange).not.toHaveBeenCalled();
		});
	});

	describe("keys in the tray", () => {
		const first = () => within(tray()).getAllByRole("button")[0];

		it("goes back up to the controls on Up", () => {
			const onViewChange = vi.fn();
			render(<TvControls {...makeProps({ view: "tray", onViewChange })} />);
			expect(fireEvent.keyDown(first(), { key: "ArrowUp" })).toBe(false);
			expect(onViewChange).toHaveBeenCalledWith("controls");
		});

		it("leaves on Back", () => {
			const onLeave = vi.fn();
			render(<TvControls {...makeProps({ view: "tray", onLeave })} />);
			expect(fireEvent.keyDown(first(), { key: "Escape" })).toBe(false);
			expect(onLeave).toHaveBeenCalledTimes(1);
		});

		it("stops at the bottom on Down", () => {
			const onLeave = vi.fn();
			const onViewChange = vi.fn();
			render(<TvControls {...makeProps({ view: "tray", onLeave, onViewChange })} />);
			expect(fireEvent.keyDown(first(), { key: "ArrowDown" })).toBe(false);
			expect(onLeave).not.toHaveBeenCalled();
			expect(onViewChange).not.toHaveBeenCalled();
		});

		it("lets Left and Right through to move along the tray", () => {
			const onViewChange = vi.fn();
			render(<TvControls {...makeProps({ view: "tray", onViewChange })} />);
			expect(fireEvent.keyDown(first(), { key: "ArrowRight" })).toBe(true);
			expect(onViewChange).not.toHaveBeenCalled();
		});
	});

	describe("buttons", () => {
		it("names each button under it, and presses it", () => {
			const r = makeRow();
			render(<TvControls {...makeProps({ row: r })} />);
			expect(within(named("Subtitles")).getByText("Subtitles")).toBeInTheDocument();
			fireEvent.click(named("Pause"));
			expect(r.onTogglePlay).toHaveBeenCalledTimes(1);
			expect(named("Pause")).not.toHaveAttribute("aria-disabled");
		});

		it("fades a button that can't be pressed and does nothing with it", () => {
			// Live TV that's live has nothing ahead to skip to.
			const r = makeRow({ live: true });
			render(<TvControls {...makeProps({ row: r })} />);
			expect(named("Forward 30 s")).toHaveAttribute("aria-disabled", "true");
			fireEvent.click(named("Forward 30 s"));
			expect(r.onSkip).not.toHaveBeenCalled();
		});

		it("shows a skip's seconds in it and a dot on subtitles that show", () => {
			render(<TvControls {...makeProps()} />);
			expect(within(named("Back 10 s")).getByText("10")).toBeInTheDocument();
			expect(within(named("Subtitles")).getByTestId("dot")).toBeInTheDocument();
			expect(within(named("Pause")).queryByTestId("dot")).not.toBeInTheDocument();
			expect(within(named("Pause")).queryByTestId("badge")).not.toBeInTheDocument();
		});

		it("makes the playback button bigger than the rest", () => {
			render(<TvControls {...makeProps()} />);
			expect(named("Pause")).toHaveClass("size-[3.6rem]");
			expect(named("Pause")).not.toHaveClass("size-[2.8rem]");
			expect(named("Subtitles")).toHaveClass("size-[2.8rem]");
			expect(named("Subtitles")).not.toHaveClass("size-[3.6rem]");
		});

		it("marks the buttons at the end of the row, which cover the way to more", () => {
			render(<TvControls {...makeProps()} />);
			expect(
				Array.from(row().querySelectorAll("[data-end]"), (b) => b.getAttribute("data-id"))
			).toEqual(["subtitles"]);
		});

		it("presses an option in the tray, but not one that's faded", () => {
			const tiles = makeTiles();
			render(<TvControls {...makeProps({ view: "tray", tiles })} />);
			const [speed, save] = within(tray()).getAllByRole("button");
			fireEvent.click(speed);
			fireEvent.click(save);
			expect(tiles.onSpeed).toHaveBeenCalledTimes(1);
			expect(speed).not.toHaveAttribute("aria-disabled");
			expect(save).toHaveAttribute("aria-disabled", "true");
		});
	});

	describe("for a movie or an episode", () => {
		it("shows how far along the video is and how much has loaded", () => {
			render(<TvControls {...makeProps()} />);
			expect(screen.getByText("0:30")).toBeInTheDocument();
			expect(screen.getByText("2:00")).toBeInTheDocument();
			expect(screen.getByTestId("knob")).toHaveStyle({ left: "25%" });
			expect(screen.queryByTestId("bubble")).not.toBeInTheDocument();
			expect(bar()).toHaveAttribute("aria-valuenow", "25");
			expect(bar()).toHaveAttribute("aria-valuetext", "0:30 of 2:00");
			expect(played()).toHaveStyle({ width: "25%" });
			expect(screen.getByTestId("buffered")).toHaveStyle({ width: "50%" });
		});

		it("rounds the bar's value to a whole percent", () => {
			render(<TvControls {...makeProps({ bar: { ...VIDEO, position: 40 } })} />);
			expect(bar()).toHaveAttribute("aria-valuenow", "33");
		});

		it("leaves out what has loaded until the player says", () => {
			render(<TvControls {...makeProps({ bar: { ...VIDEO, bufferedTo: null } })} />);
			expect(screen.queryByTestId("buffered")).not.toBeInTheDocument();
		});

		it("says when it ends with the controls, at the speed it plays", () => {
			const { rerender } = render(<TvControls {...makeProps()} />);
			expect(screen.getByText(`Ends at ${formatHHMM(NOW + 90)}`)).toBeInTheDocument();
			rerender(<TvControls {...makeProps({ bar: { ...VIDEO, speed: 2, position: 0 } })} />);
			expect(screen.getByText(`Ends at ${formatHHMM(NOW + 60)}`)).toBeInTheDocument();
		});

		it("leaves out when it ends from the bar alone", () => {
			render(<TvControls {...makeProps({ view: "none", strip: true })} />);
			expect(screen.queryByText(/^Ends at/)).not.toBeInTheDocument();
		});

		it("shows only the time while the length isn't known", () => {
			render(<TvControls {...makeProps({ bar: { ...VIDEO, duration: 0 } })} />);
			expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
			expect(screen.getByText("0:30")).toBeInTheDocument();
		});
	});

	describe("for live TV", () => {
		const ON_NOW = program("Headlines", NOW - 600, NOW + 1200);

		it("shows the program on now from its start to its end, playing live", () => {
			guide.of.mockReturnValue({ now: ON_NOW, next: null });
			render(<TvControls {...makeProps({ bar: live() })} />);
			expect(guide.of).toHaveBeenCalledWith(NEWS);
			expect(screen.getByText(formatHHMM(NOW - 600))).toBeInTheDocument();
			expect(screen.getByText(formatHHMM(NOW + 1200))).toBeInTheDocument();
			expect(screen.getByText("20 min left")).toBeInTheDocument();
			expect(screen.getByText("LIVE")).toBeInTheDocument();
			expect(bar()).toHaveAttribute("aria-valuetext", "Live");
			expect(bar()).toHaveAttribute("aria-valuenow", "33");
			expect(screen.queryByTestId("rewindable")).not.toBeInTheDocument();
			expect(screen.queryByText(/^−/)).not.toBeInTheDocument();
		});

		it("leaves out the time left from the bar alone", () => {
			guide.of.mockReturnValue({ now: ON_NOW, next: null });
			render(<TvControls {...makeProps({ view: "none", strip: true, bar: live() })} />);
			expect(screen.queryByText("20 min left")).not.toBeInTheDocument();
		});

		it("shows how far behind live it plays and what it can go back to", () => {
			guide.of.mockReturnValue({ now: ON_NOW, next: null });
			render(
				<TvControls
					{...makeProps({ bar: live({ behind: 300, buffered: { from: 600, to: 60 } }) })}
				/>
			);
			expect(screen.getByText("GO LIVE")).toBeInTheDocument();
			expect(screen.getByTestId("bubble")).toHaveTextContent("−5:00");
			expect(screen.getByTestId("bubble").style.left).toBe(played().style.width);
			expect(screen.getByTestId("knob").style.left).toBe(played().style.width);
			expect(bar()).toHaveAttribute("aria-valuetext", "−5:00 behind live");
			expect(bar()).toHaveAttribute("aria-valuenow", "17");
			expect(screen.getByTestId("rewindable")).toHaveStyle({ left: "0%", width: "30%" });
		});

		it("counts a few seconds behind as live", () => {
			guide.of.mockReturnValue({ now: ON_NOW, next: null });
			render(
				<TvControls
					{...makeProps({
						bar: live({ behind: LIVE_SLACK, buffered: { from: 600, to: 0 } }),
					})}
				/>
			);
			expect(screen.getByText("LIVE")).toBeInTheDocument();
			expect(bar()).toHaveAttribute("aria-valuetext", "Live");
			expect(screen.queryByTestId("rewindable")).not.toBeInTheDocument();
			expect(screen.queryByTestId("bubble")).not.toBeInTheDocument();
		});

		it("leaves out what it can go back to until the player says", () => {
			guide.of.mockReturnValue({ now: ON_NOW, next: null });
			render(<TvControls {...makeProps({ bar: live({ behind: 300 }) })} />);
			expect(screen.getByText("−5:00")).toBeInTheDocument();
			expect(screen.queryByTestId("rewindable")).not.toBeInTheDocument();
		});

		it("shows as far back as the player goes on a channel with no guide", () => {
			render(<TvControls {...makeProps({ bar: live({ behind: 150 }) })} />);
			expect(screen.getByText(formatHHMM(NOW - 300))).toBeInTheDocument();
			expect(screen.getByText("Now")).toBeInTheDocument();
			expect(screen.queryByText(/min left$/)).not.toBeInTheDocument();
			expect(played()).toHaveStyle({ width: "50%" });
		});
	});
});
