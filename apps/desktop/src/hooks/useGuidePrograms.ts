// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useMemo, useRef, useState } from "react";
import type { TimeRange } from "@/lib/epg-window";
import { getEpgForLiveChannels } from "@/lib/tauri";
import type { EpgProgram } from "@/lib/types";

/** Every channel's programs, or only those of the channels with these guide ids. */
export type GuideChannels = "all" | readonly string[];

/** What has been asked for over one range since the reset key last changed. */
interface Loads {
	/** Whether every channel's programs are on their way or in. */
	all: "no" | "asked" | "loaded";
	/** The guide ids whose programs are on their way or in. */
	ids: Set<string>;
}

/** The loads that have finished over one range since the reset key last changed. */
interface Landed {
	range: TimeRange;
	resetKey: unknown;
	/** Every channel's load finished. */
	all: boolean;
	/** The guide ids whose own load finished. */
	ids: ReadonlySet<string>;
}

/** The guide's programs and which channels are still waiting for theirs. */
export interface GuidePrograms {
	/** The programs over the range by guide id. */
	programs: ReadonlyMap<string, EpgProgram[]>;
	/**
	 * This guide id's programs are asked for and haven't come in, so a channel
	 * with none may only be waiting for them.
	 */
	isPending: (id: string) => boolean;
}

const nothingAsked = (): Loads => ({ all: "no", ids: new Set() });

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
 * A list of ids loads only the ones that aren't loaded or on their way for the
 * range, and their answer replaces just those ids, so a new favorite loads only
 * its own programs. "all" loads once for the range, and its answer replaces all
 * the programs. After that a list loads nothing, though while it's on its way a
 * list still loads its own ids rather than wait for it.
 *
 * A new range or `resetKey`, or a null request, starts over and drops the
 * answers still on their way. The programs stay until the next answer replaces
 * them, so the rows keep showing what they had while the guide loads again.
 */
export const useGuidePrograms = (
	range: TimeRange | null,
	channels: GuideChannels | null,
	resetKey: unknown
): GuidePrograms => {
	const [programs, setPrograms] = useState<ReadonlyMap<string, EpgProgram[]>>(() => new Map());
	const [landed, setLanded] = useState<Landed | null>(null);
	const loads = useRef<Loads | null>(null);
	const key = useMemo(() => requestKey(channels), [channels]);
	const asked = useMemo(
		() => (key === null || key === "all" ? key : new Set<string>(JSON.parse(key) as string[])),
		[key]
	);

	// One record for each range and reset key. An answer counts only while its
	// record is the current one. This runs before the load below, which then
	// sees the new record.
	useEffect(() => {
		loads.current = nothingAsked();
		return () => {
			loads.current = null;
		};
	}, [range, resetKey]);

	useEffect(() => {
		if (key === null) {
			// Leaving the guide's tabs forgets what's loaded, and coming back
			// loads it again.
			loads.current = nothingAsked();
			return;
		}
		const record = loads.current;
		if (!range || !record || record.all === "loaded") return;
		const ids =
			key === "all"
				? undefined
				: (JSON.parse(key) as string[]).filter((id) => !record.ids.has(id));
		if (ids ? ids.length === 0 : record.all === "asked") return;
		if (ids) for (const id of ids) record.ids.add(id);
		else record.all = "asked";
		const land = () =>
			setLanded((old) =>
				!ids
					? { range, resetKey, all: true, ids: new Set() }
					: old && old.resetKey === resetKey && old.range === range
						? { ...old, ids: new Set([...old.ids, ...ids]) }
						: { range, resetKey, all: false, ids: new Set(ids) }
			);

		getEpgForLiveChannels(range.from, range.to, ids).then(
			(progs) => {
				if (loads.current !== record) return;
				const found = byChannel(progs);
				if (ids) {
					setPrograms((old) => {
						const next = new Map(old);
						for (const id of ids) next.delete(id);
						for (const [id, list] of found) next.set(id, list);
						return next;
					});
				} else {
					record.all = "loaded";
					setPrograms(found);
				}
				land();
			},
			() => {
				// The next request asks for these again.
				if (loads.current !== record) return;
				if (ids) for (const id of ids) record.ids.delete(id);
				else record.all = "no";
				land();
			}
		);
	}, [range, key, resetKey]);

	const done = landed && landed.range === range && landed.resetKey === resetKey ? landed : null;
	const isPending = (id: string): boolean =>
		asked !== null && !done?.all && !done?.ids.has(id) && (asked === "all" || asked.has(id));
	return { programs, isPending };
};
