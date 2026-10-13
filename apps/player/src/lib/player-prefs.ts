// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// Player preferences kept in web storage.
//
// The volume picked in the player lasts until the app quits (sessionStorage),
// so leaving and reopening the player doesn't reset it. The default volume,
// hardware decoding and skip lengths are Settings choices and persist across
// launches (localStorage), as do the skip modes for intros and credits.
// Storage can throw (private mode, quota), so every access is guarded and
// falls back to the built-in defaults.

const VOLUME_KEY = "mvp_volume";
const DEFAULT_VOLUME_KEY = "mvp_default_volume";
const HWDEC_KEY = "mvp_hwdec";

export const MAX_VOLUME = 150;
const BUILTIN_VOLUME = 100;

export interface VolumePreference {
	/** The volume the user last chose. */
	volume: number;
	/** Volume to restore when unmuting. */
	preMute: number;
}

const clampVolume = (v: number): number => Math.min(MAX_VOLUME, Math.max(0, Math.round(v)));

const isVolumePreference = (v: unknown): v is VolumePreference =>
	typeof v === "object" &&
	v !== null &&
	Number.isFinite((v as VolumePreference).volume) &&
	Number.isFinite((v as VolumePreference).preMute);

/** The volume playback starts at in a new session (Settings → Default volume). */
export const readDefaultVolume = (): number => {
	try {
		const raw = localStorage.getItem(DEFAULT_VOLUME_KEY);
		const n = raw === null ? NaN : Number.parseFloat(raw);
		return Number.isFinite(n) ? clampVolume(n) : BUILTIN_VOLUME;
	} catch {
		return BUILTIN_VOLUME;
	}
};

/**
 * Save a new default volume. It also drops the volume remembered for this
 * session, so the next stream starts at the new default instead of waiting
 * for a restart.
 */
export const writeDefaultVolume = (volume: number): void => {
	try {
		localStorage.setItem(DEFAULT_VOLUME_KEY, String(clampVolume(volume)));
		sessionStorage.removeItem(VOLUME_KEY);
	} catch {}
};

/** The volume to use for the next stream: this session's choice, else the default. */
export const readVolumePreference = (): VolumePreference => {
	try {
		const raw = sessionStorage.getItem(VOLUME_KEY);
		const saved: unknown = raw ? JSON.parse(raw) : null;
		if (isVolumePreference(saved)) {
			return { volume: clampVolume(saved.volume), preMute: clampVolume(saved.preMute) };
		}
	} catch {}
	const volume = readDefaultVolume();
	return { volume, preMute: volume > 0 ? volume : BUILTIN_VOLUME };
};

export const writeVolumePreference = (pref: VolumePreference): void => {
	try {
		sessionStorage.setItem(VOLUME_KEY, JSON.stringify(pref));
	} catch {}
};

/** Whether mpv may use hardware decoding. On unless turned off in Settings. */
export const readHwdecEnabled = (): boolean => {
	try {
		return localStorage.getItem(HWDEC_KEY) !== "off";
	} catch {
		return true;
	}
};

export const writeHwdecEnabled = (enabled: boolean): void => {
	try {
		localStorage.setItem(HWDEC_KEY, enabled ? "on" : "off");
	} catch {}
};

/**
 * Reads and saves a group of Settings choices, one localStorage key per
 * field. A value that isn't in `allowed` reads as `fallback` and isn't
 * saved. Saving fires `event`, which `usePlayerPref` listens for.
 */
const choiceGroup = <F extends string, V extends string | number>(
	keys: Record<F, string>,
	allowed: readonly V[],
	fallback: V,
	event: string,
	parse: (raw: string | null) => unknown
) => {
	const isAllowed = (v: unknown): v is V => allowed.includes(v as V);
	const readOne = (field: F): V => {
		try {
			const v = parse(localStorage.getItem(keys[field]));
			return isAllowed(v) ? v : fallback;
		} catch {
			return fallback;
		}
	};
	const fields = Object.keys(keys) as F[];
	return {
		read: (): Record<F, V> =>
			Object.fromEntries(fields.map((f) => [f, readOne(f)])) as Record<F, V>,
		write: (field: F, value: V): void => {
			if (!isAllowed(value)) return;
			try {
				localStorage.setItem(keys[field], String(value));
				window.dispatchEvent(new Event(event));
			} catch {}
		},
	};
};

/** The skip lengths Settings offers, in seconds. */
export const SKIP_OPTIONS: readonly number[] = [5, 10, 15, 30, 60];
const BUILTIN_SKIP = 10;

/** Window event fired after either skip length changes. */
export const SKIP_INTERVALS_EVENT = "mvp-skip-intervals";

export interface SkipIntervals {
	/** Seconds the skip back button, double-tap and left arrow jump. */
	back: number;
	/** Seconds the skip forward button, double-tap and right arrow jump. */
	forward: number;
}

const skipIntervals = choiceGroup<keyof SkipIntervals, number>(
	{ back: "mvp_skip_back", forward: "mvp_skip_forward" },
	SKIP_OPTIONS,
	BUILTIN_SKIP,
	SKIP_INTERVALS_EVENT,
	Number
);

/** How far the player skips back and forward. 10 seconds each unless changed in Settings. */
export const readSkipIntervals: () => SkipIntervals = skipIntervals.read;

/** Save one skip length. Values that aren't in SKIP_OPTIONS are ignored. */
export const writeSkipInterval: (direction: keyof SkipIntervals, seconds: number) => void =
	skipIntervals.write;

/**
 * What the player does at a part of a movie or episode that can be skipped.
 * "button" shows a Skip button, "auto" skips on its own with a way to undo,
 * and "off" does neither.
 */
export type SkipSegmentMode = "button" | "auto" | "off";

/** The two groups of skippable parts, each with its own Settings choice. */
export interface SkipSegmentModes {
	/** Intros and recaps. */
	opening: SkipSegmentMode;
	/** End credits and previews of the next episode. */
	ending: SkipSegmentMode;
}

/** Window event fired after either skip mode changes. */
export const SKIP_SEGMENT_MODES_EVENT = "mvp-skip-segment-modes";

const skipSegmentModes = choiceGroup<keyof SkipSegmentModes, SkipSegmentMode>(
	{ opening: "mvp_skip_opening", ending: "mvp_skip_ending" },
	["button", "auto", "off"],
	"button",
	SKIP_SEGMENT_MODES_EVENT,
	(raw) => raw
);

/** How the player handles intros and credits. A Skip button for both unless changed in Settings. */
export const readSkipSegmentModes: () => SkipSegmentModes = skipSegmentModes.read;

/** Save the mode for one group. Unknown modes are ignored. */
export const writeSkipSegmentMode: (group: keyof SkipSegmentModes, mode: SkipSegmentMode) => void =
	skipSegmentModes.write;
