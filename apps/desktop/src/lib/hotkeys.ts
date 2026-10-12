// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { SkipIntervals } from "./player-prefs";

/** Player keyboard actions. Resolved from key events by `resolvePlayerHotkey`. */
export type PlayerAction =
	| { type: "togglePlay" }
	| { type: "toggleFullscreen" }
	| { type: "toggleMute" }
	| { type: "seekBy"; seconds: number }
	| { type: "seekToPercent"; percent: number }
	| { type: "volumeBy"; delta: number }
	| { type: "nextEpisode" }
	| { type: "prevEpisode" }
	| { type: "toggleSubtitles" }
	| { type: "toggleInfo" }
	| { type: "toggleShortcuts" }
	| { type: "escape" };

/** How far the plain arrow and J/L keys jump when no skip lengths are passed in. */
export const SEEK_SHORT = 10;
/** How far Shift with an arrow or J/L jumps. */
export const SEEK_LONG = 30;
export const VOLUME_STEP = 5;

const DEFAULT_SKIP: SkipIntervals = { back: SEEK_SHORT, forward: SEEK_SHORT };

interface KeyLike {
	key: string;
	shiftKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
}

/**
 * Map a keydown event to a player action, or null if the key isn't bound.
 * Combinations with Cmd/Ctrl/Alt are never handled so OS and app shortcuts
 * (Cmd+F, Cmd+M, Cmd+Q, …) keep working. `skip` sets how far the plain arrow
 * and J/L keys jump.
 */
export const resolvePlayerHotkey = (
	e: KeyLike,
	skip: SkipIntervals = DEFAULT_SKIP
): PlayerAction | null => {
	if (e.ctrlKey || e.metaKey || e.altKey) return null;

	// Digit keys: 0–9 jump to 0%–90% of the runtime (YouTube convention).
	if (/^[0-9]$/.test(e.key)) return { type: "seekToPercent", percent: Number(e.key) * 10 };

	switch (e.key) {
		case " ":
		case "k":
		case "K":
			return { type: "togglePlay" };
		case "f":
		case "F":
			return { type: "toggleFullscreen" };
		case "m":
		case "M":
			return { type: "toggleMute" };
		case "ArrowLeft":
		case "j":
		case "J":
			return { type: "seekBy", seconds: e.shiftKey ? -SEEK_LONG : -skip.back };
		case "ArrowRight":
		case "l":
		case "L":
			return { type: "seekBy", seconds: e.shiftKey ? SEEK_LONG : skip.forward };
		case "Home":
			return { type: "seekToPercent", percent: 0 };
		case "ArrowUp":
			return { type: "volumeBy", delta: VOLUME_STEP };
		case "ArrowDown":
			return { type: "volumeBy", delta: -VOLUME_STEP };
		case "n":
		case "N":
			return { type: "nextEpisode" };
		case "p":
		case "P":
			return { type: "prevEpisode" };
		case "s":
		case "S":
			return { type: "toggleSubtitles" };
		case "i":
		case "I":
			return { type: "toggleInfo" };
		case "?":
			return { type: "toggleShortcuts" };
		case "Escape":
			return { type: "escape" };
		default:
			return null;
	}
};

const skipLabel = ({ back, forward }: SkipIntervals): string =>
	back === forward ? `Seek ${back}s back / forward` : `Seek ${back}s back / ${forward}s forward`;

/** Shortcut reference shown in the player's "?" overlay. */
export const playerShortcuts = (
	skip: SkipIntervals = DEFAULT_SKIP
): { keys: string[]; label: string }[] => [
	{ keys: ["Space", "K"], label: "Play / pause" },
	{ keys: ["F"], label: "Toggle fullscreen (or double-click)" },
	{ keys: ["M"], label: "Mute / unmute" },
	{ keys: ["←", "→"], label: skipLabel(skip) },
	{ keys: ["J", "L"], label: skipLabel(skip) },
	{ keys: ["Shift ←", "Shift →"], label: `Seek ${SEEK_LONG}s back / forward` },
	{ keys: ["Shift J", "Shift L"], label: `Seek ${SEEK_LONG}s back / forward` },
	{ keys: ["0–9"], label: "Jump to 0%–90%" },
	{ keys: ["Home"], label: "Jump to start" },
	{ keys: ["↑", "↓"], label: "Volume up / down" },
	{ keys: ["N", "P"], label: "Next / previous episode" },
	{ keys: ["S"], label: "Subtitles" },
	{ keys: ["I"], label: "Info" },
	{ keys: ["?"], label: "Show / hide this list" },
	{ keys: ["Esc"], label: "Exit fullscreen / close panel / leave player" },
];

/** True when the event target is a text field, so typing shouldn't trigger hotkeys. */
export const isTypingTarget = (target: EventTarget | null): boolean => {
	if (!(target instanceof HTMLElement)) return false;
	const tag = target.tagName;
	return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
};

const BUTTON_ROLES = new Set([
	"button",
	"link",
	"checkbox",
	"switch",
	"tab",
	"menuitem",
	"menuitemcheckbox",
	"menuitemradio",
]);

/** True when the element matches :focus-visible, or when the browser can't tell. */
const matchesFocusVisible = (el: HTMLElement): boolean => {
	try {
		return el.matches(":focus-visible");
	} catch {
		return true;
	}
};

/**
 * True when the target is a button-like control reached with the keyboard, so
 * Space should activate it rather than play/pause. Clicking a button also
 * focuses it in Chromium and WebKitGTK; those focuses don't match
 * :focus-visible, so Space keeps controlling playback after a mouse click.
 */
export const isKeyboardFocusedControl = (target: EventTarget | null): boolean => {
	if (!(target instanceof HTMLElement)) return false;
	const isControl =
		target.tagName === "BUTTON" ||
		target.tagName === "A" ||
		BUTTON_ROLES.has(target.getAttribute("role") ?? "");
	return isControl && matchesFocusVisible(target);
};

/** Keys a focused slider moves its value with. */
const SLIDER_KEYS = new Set([
	"ArrowLeft",
	"ArrowRight",
	"ArrowUp",
	"ArrowDown",
	"Home",
	"End",
	"PageUp",
	"PageDown",
]);

/**
 * True when a slider reached with the keyboard should move its own value for
 * this key, such as an arrow on the seek or volume bar after Tab. A slider
 * focused by a click leaves these keys to the player, so the arrows keep
 * seeking by the skip length instead of nudging the bar one step.
 */
export const isSliderOwnKey = (target: EventTarget | null, key: string): boolean =>
	target instanceof HTMLElement &&
	target.getAttribute("role") === "slider" &&
	SLIDER_KEYS.has(key) &&
	matchesFocusVisible(target);

/**
 * keydown handler for a slider inside the player. For a player hotkey the
 * slider doesn't own (see `isSliderOwnKey`), it stops the slider from moving
 * so only the hotkey acts. Other keys, such as End, still move the slider.
 */
export const leaveSliderKeysToPlayer = (
	e: KeyLike & { target: EventTarget | null; preventDefault: () => void }
): void => {
	if (SLIDER_KEYS.has(e.key) && !isSliderOwnKey(e.target, e.key) && resolvePlayerHotkey(e)) {
		e.preventDefault();
	}
};
