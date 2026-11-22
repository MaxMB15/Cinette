// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useDeferredValue, useMemo } from "react";
import type { Channel } from "@/lib/types";
import { BACKSPACE, CLEAR, SPACE, TvKeys, applyKey } from "./TvKeyboard";
import { KINDS_START, TvKinds, type TvKind } from "./TvKinds";
import { TvEmpty, TvField, TvHeader } from "./ui";
import { useRemembered } from "./tv-nav";

const KEY_COLUMNS = 6;
const FIELD_HEIGHT = 3.25;
/** The most results of one kind. */
const MAX_RESULTS = 200;

const KEYS = [..."abcdefghijklmnopqrstuvwxyz0123456789", SPACE, BACKSPACE, CLEAR];

/** The items whose name has the text, those that start with it first. */
export const searchItems = (items: readonly Channel[], text: string): Channel[] => {
	const term = text.trim().toLowerCase();
	if (!term) return [];
	const starts: Channel[] = [];
	const within: Channel[] = [];
	for (const item of items) {
		const name = item.name.toLowerCase();
		if (name.startsWith(term)) starts.push(item);
		else if (name.includes(term)) within.push(item);
	}
	return [...starts, ...within].slice(0, MAX_RESULTS);
};

/**
 * Search, with letters on the screen for the D-pad, and a field above them
 * for the system's keyboard. Results fill in beside the letters as they're
 * picked, split by kind, so the kinds are one press to the right and their
 * results one more.
 */
export const TvSearch = ({
	kinds,
	onOpen,
}: {
	/** The channels, the movies and the shows. */
	kinds: readonly TvKind[];
	onOpen: (item: Channel) => void;
}) => {
	const [place, setPlace] = useRemembered("search", { key: 0, text: "", results: KINDS_START });
	const deferred = useDeferredValue(place.text);
	const found = useMemo(
		() =>
			kinds
				.map((kind) => ({ name: kind.name, items: searchItems(kind.items, deferred) }))
				.filter((kind) => kind.items.length > 0),
		[kinds, deferred]
	);

	return (
		<div className="flex h-full flex-col">
			<TvHeader title="Search" />
			<div className="flex gap-[1.5rem] px-[1.5rem]">
				<div className="w-[16.5rem] shrink-0">
					<TvField
						type="search"
						aria-label="Search for a channel, movie or show"
						placeholder="Channel, movie or show"
						value={place.text}
						onChange={(e) =>
							setPlace({ ...place, text: e.target.value, results: KINDS_START })
						}
						className="mb-[0.5rem] w-full rounded-[0.5rem] bg-white/10 px-[0.75rem] text-base font-medium placeholder:opacity-70"
						style={{ height: `${FIELD_HEIGHT - 0.5}rem` }}
					/>
					<TvKeys
						keys={KEYS}
						columns={KEY_COLUMNS}
						active={place.key}
						onActiveChange={(i) => setPlace({ ...place, key: i })}
						onKey={(k) =>
							setPlace({
								...place,
								text: applyKey(place.text, k),
								results: KINDS_START,
							})
						}
						upper
						start
					/>
				</div>
				{place.text.trim() ? (
					found.length > 0 ? (
						<div className="flex min-w-0 flex-1 gap-[1rem]">
							<TvKinds
								kinds={found}
								place={place.results}
								onPlaceChange={(results) => setPlace({ ...place, results })}
								onOpen={onOpen}
								itemsClassName="min-w-0 flex-1"
								start={false}
							/>
						</div>
					) : (
						<div className="min-w-0 flex-1">
							<TvEmpty title={`Nothing called "${place.text.trim()}"`} />
						</div>
					)
				) : null}
			</div>
		</div>
	);
};
