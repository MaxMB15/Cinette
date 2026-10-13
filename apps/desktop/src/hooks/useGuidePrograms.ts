// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useMemo, useRef, useState } from "react";
import type { TimeRange } from "@/lib/epg-window";
import { getEpgForLiveChannels } from "@/lib/tauri";
import type { EpgProgram } from "@/lib/types";

/** Every channel's programs, or only those of the channels with these guide ids. */
export type GuideChannels = "all" | readonly string[];

/** What the guide has loaded for one range. */
interface Loaded {
	range: TimeRange;
	resetKey: unknown;
	/** Every channel's programs are loaded, so `ids` doesn't matter. */
	all: boolean;
	ids: ReadonlySet<string>;
}

/** The programs grouped by guide id, each channel's in the order they came. */
const byChannel = (programs: EpgProgram[]): Map<string, EpgProgram[]> => {
	const map = new Map<string, EpgProgram[]>();
	for (const p of programs) {
		const list = map.get(p.channelId);
		if (list) list.push(p);
		else map.set(p.channelId, [p]);
	}
	return map;
};

/**
 * What `channels` asks for as one string, with each id once and in order. The
 * effect then runs again only when the request changes, not each time the
 * caller builds a new list with the same ids.
 */
const requestKey = (channels: GuideChannels | null): string | null =>
	channels === null || channels === "all"
		? channels
		: JSON.stringify([...new Set(channels)].sort());

/**
 * The guide's programs over `range` by guide id, for `channels`. With null it
 * loads nothing.
 *
 * A list of ids loads only the ones it doesn't have yet for the range and adds
 * them to the rest, so a new favorite loads just its own programs. Once every
 * channel is loaded, a list loads nothing. A new range or `resetKey` loads
 * again from scratch, and so does the next request after a null one.
 */
export const useGuidePrograms = (
	range: TimeRange | null,
	channels: GuideChannels | null,
	resetKey: unknown
): ReadonlyMap<string, EpgProgram[]> => {
	const [programs, setPrograms] = useState<ReadonlyMap<string, EpgProgram[]>>(() => new Map());
	const loaded = useRef<Loaded | null>(null);
	const key = useMemo(() => requestKey(channels), [channels]);

	useEffect(() => {
		if (key === null) {
			loaded.current = null;
			return;
		}
		if (!range) return;
		const prev = loaded.current;
		const base =
			prev !== null &&
			prev.resetKey === resetKey &&
			prev.range.from === range.from &&
			prev.range.to === range.to
				? prev
				: null;
		if (base?.all) return;
		const missing =
			key === "all"
				? undefined
				: (JSON.parse(key) as string[]).filter((id) => !base?.ids.has(id));
		if (missing?.length === 0) return;

		// A newer request drops this one's answer, and asks again for any of
		// these ids it still needs.
		let current = true;
		getEpgForLiveChannels(range.from, range.to, missing)
			.then((progs) => {
				if (!current) return;
				const found = byChannel(progs);
				if (base && missing) {
					loaded.current = { ...base, ids: new Set([...base.ids, ...missing]) };
					setPrograms((old) => new Map([...old, ...found]));
				} else {
					loaded.current = { range, resetKey, all: !missing, ids: new Set(missing) };
					setPrograms(found);
				}
			})
			.catch(() => {});
		return () => {
			current = false;
		};
	}, [range, key, resetKey]);

	return programs;
};
