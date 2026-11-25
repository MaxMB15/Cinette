// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState } from "react";
import { useNowNext } from "@/hooks/useNowNext";
import type { Channel } from "@/lib/types";
import { TvList } from "./TvList";
import { TvPanel } from "./TvPanel";
import { TvChannelRow } from "./ui";

const ROW_HEIGHT = 3.4;

/** The channels to switch to, with the one on screen under the cursor. */
export const TvChannelPanel = ({
	channels,
	currentId,
	onPlay,
	onClose,
}: {
	channels: readonly Channel[];
	currentId: string;
	onPlay: (channel: Channel) => void;
	onClose: () => void;
}) => {
	const { nowNextOf } = useNowNext();
	const [active, setActive] = useState(() =>
		Math.max(
			0,
			channels.findIndex((ch) => ch.id === currentId)
		)
	);
	return (
		<TvPanel title="Channels" side="left" onClose={onClose}>
			<TvList
				items={channels}
				label="Channels"
				itemKey={(ch) => ch.id}
				active={active}
				onActiveChange={setActive}
				onSelect={onPlay}
				rowHeight={ROW_HEIGHT}
				height={ROW_HEIGHT * 9}
				start
				itemClassName="rounded-[0.5rem]"
				renderItem={(ch) => <TvChannelRow channel={ch} line={nowNextOf(ch).now?.title} />}
			/>
		</TvPanel>
	);
};
