// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { Channel } from "@/lib/types";
import { KINDS_START, TvKinds, type TvKind } from "./TvKinds";
import { TvEmpty, TvHeader } from "./ui";
import { useRemembered } from "./tv-nav";

/** Favorites by kind beside the favorites of that kind. */
export const TvFavorites = ({
	groups,
	onOpen,
}: {
	groups: readonly TvKind[];
	onOpen: (item: Channel, list: readonly Channel[]) => void;
}) => {
	const [place, setPlace] = useRemembered("favorites", KINDS_START);
	const shown = groups.filter((g) => g.items.length > 0);

	return (
		<div className="flex h-full flex-col">
			<TvHeader title="Favorites" />
			{shown.length > 0 ? (
				<div className="flex gap-[1rem] px-[1.5rem]">
					<TvKinds
						kinds={shown}
						place={place}
						onPlaceChange={setPlace}
						onOpen={onOpen}
						itemsClassName="w-[30rem] shrink-0"
					/>
				</div>
			) : (
				<TvEmpty title="Channels and movies you add to your favorites show up here" />
			)}
		</div>
	);
};
