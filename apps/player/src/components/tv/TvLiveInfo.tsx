// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useChannels } from "@/hooks/useChannels";
import { useNowNext } from "@/hooks/useNowNext";
import type { Channel } from "@/lib/types";
import { ChannelInfo } from "./TvLive";
import { PANEL_LIST_HEIGHT, TvPanel } from "./TvPanel";

/** What's on the channel being watched and after it, beside the video. */
export const TvLiveInfo = ({ channel, onClose }: { channel: Channel; onClose: () => void }) => {
	const { channels, toggleFavorite } = useChannels();
	const { now, scheduleOf } = useNowNext();
	const latest = channels.find((ch) => ch.id === channel.id) ?? channel;
	return (
		<TvPanel title={channel.name} onClose={onClose}>
			<div className="flex px-[0.5rem]">
				<ChannelInfo
					channel={latest}
					schedule={scheduleOf(channel)}
					now={now}
					height={PANEL_LIST_HEIGHT}
					onToggleFavorite={() => void toggleFavorite(channel.id)}
				/>
			</div>
		</TvPanel>
	);
};
