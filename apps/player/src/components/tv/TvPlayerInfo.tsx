// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import type { Channel, OmdbData, WhatsonData } from "@/lib/types";
import { TvDetails } from "./TvDetails";
import { TvLiveInfo } from "./TvLiveInfo";

/** What the Info button opens for whatever's playing. */
export const TvPlayerInfo = ({
	channel,
	show,
	episodes,
	omdbData,
	whatsonData,
	onPlay,
	onClose,
}: {
	channel: Channel;
	/** The name and id of the show an episode belongs to. */
	show: { name: string; id: string };
	episodes: Channel[];
	omdbData: OmdbData | null | undefined;
	whatsonData: WhatsonData | null | undefined;
	onPlay: (channel: Channel) => void;
	onClose: () => void;
}) => {
	if (channel.contentType === "live") return <TvLiveInfo channel={channel} onClose={onClose} />;
	const isShow = channel.contentType === "series";
	return (
		<TvDetails
			item={isShow ? { ...channel, ...show } : channel}
			currentEpisode={isShow ? channel : undefined}
			episodesOf={() => Promise.resolve(episodes)}
			playLabel="Keep watching"
			omdbData={omdbData}
			whatsonData={whatsonData}
			onPlay={onPlay}
			onClose={onClose}
		/>
	);
};
