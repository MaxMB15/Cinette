// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useState, useSyncExternalStore } from "react";
import { CATALOG_PAGE, type CatalogItem, type CinetteDestination } from "@/lib/cinette-destination";
import { episodeNeighbors, sortEpisodes } from "@/lib/episodes";
import { remoteCatalog } from "@/lib/tauri";

// Stryker disable next-line ArrowFunction: React skips an unsubscribe that isn't a function, and this one does nothing.
const noState = () => () => {};
const getNull = () => null;

/**
 * The episodes before and after the one the device link `link` goes to
 * plays, from that device's catalog. None without a link, for an item that
 * isn't an episode, or from a device too old to name an episode's series.
 */
export const useRemoteEpisodes = (
	link: { id: number; destination: CinetteDestination } | null
): { prev: CatalogItem | null; next: CatalogItem | null } => {
	const destination = link ? link.destination : null;
	// The React Compiler can't compile ?. and ?? here.
	const subscribe = destination ? destination.subscribe : noState;
	const getState = destination ? destination.getState : getNull;
	const item = useSyncExternalStore(subscribe, getState)?.item;
	const linkId = link?.id;
	const seriesId = item?.seriesId;
	const [found, setFound] = useState<{ key: string; episodes: CatalogItem[] } | null>(null);
	const key = linkId !== undefined && seriesId ? `${linkId}\n${seriesId}` : null;
	useEffect(() => {
		if (linkId === undefined || !seriesId) return;
		let current = true;
		const episodes: CatalogItem[] = [];
		const page = (cursor?: string): Promise<void> =>
			remoteCatalog(linkId, { kind: "episodes", seriesId, cursor, limit: CATALOG_PAGE }).then(
				(p) => {
					episodes.push(...p.items);
					return p.next && current ? page(p.next) : undefined;
				}
			);
		page().then(
			() => {
				if (current)
					setFound({ key: `${linkId}\n${seriesId}`, episodes: sortEpisodes(episodes) });
			},
			() => {}
		);
		return () => {
			current = false;
		};
	}, [linkId, seriesId]);
	const episodes = found && found.key === key ? found.episodes : [];
	return episodeNeighbors(
		episodes,
		episodes.findIndex((e) => e.id === item?.ref)
	);
};
