// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useState } from "react";
import { useDestinationState } from "@/hooks/useDestinationState";
import { CATALOG_PAGE, type CatalogItem } from "@/lib/cinette-destination";
import { episodeNeighbors, sortEpisodes } from "@/lib/episodes";
import type { Link } from "@/lib/remote-control";
import { remoteCatalog } from "@/lib/tauri";

/** No episodes before or after. */
const NONE = { prev: null, next: null };

/**
 * The episodes before and after the one the device `link` goes to plays,
 * from that device's catalog. None without a link, for an item that isn't
 * an episode, or from a device too old to name an episode's series. They're
 * asked for while the link is connected, and again once it's back.
 */
export const useRemoteEpisodes = (
	link: Pick<Link, "id" | "phase" | "destination"> | null
): { prev: CatalogItem | null; next: CatalogItem | null } => {
	const item = useDestinationState(link ? link.destination : null)?.item;
	const ref = item?.ref;
	const seriesId = item?.seriesId;
	const linkId = link?.id;
	const connected = link?.phase.phase === "connected";
	// Only an item from a link names a series.
	const key = seriesId ? `${linkId}\n${seriesId}` : null;
	const [found, setFound] = useState<{ key: string; episodes: CatalogItem[] } | null>(null);
	useEffect(() => {
		if (key === null || !connected) return;
		let current = true;
		const episodes: CatalogItem[] = [];
		// A key is only made with both.
		const query = { kind: "episodes" as const, seriesId: seriesId!, limit: CATALOG_PAGE };
		const page = (cursor?: string): Promise<void> =>
			remoteCatalog(linkId!, { ...query, cursor }).then((p) => {
				episodes.push(...p.items);
				return p.next && current ? page(p.next) : undefined;
			});
		page().then(
			() => {
				if (current) setFound({ key, episodes: sortEpisodes(episodes) });
			},
			() => {}
		);
		return () => {
			current = false;
		};
	}, [key, linkId, seriesId, connected]);
	if (found?.key !== key) return NONE;
	return episodeNeighbors(
		found.episodes,
		found.episodes.findIndex((e) => e.id === ref)
	);
};
