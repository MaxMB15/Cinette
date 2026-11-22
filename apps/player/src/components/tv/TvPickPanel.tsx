// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState } from "react";
import { Check } from "lucide-react";
import type { PlaybackPick } from "@/lib/playback-options";
import { TvList } from "./TvList";
import { PANEL_LIST_HEIGHT, TvPanel } from "./TvPanel";

const ROW_HEIGHT = 3;

/**
 * A list of choices, such as the sources or the audio tracks, with the
 * current one marked and under the cursor.
 */
export const TvPickPanel = ({
	title,
	label,
	picks,
	current,
	onPick,
	onClose,
}: {
	title: string;
	/** The list's name for a screen reader. */
	label: string;
	picks: readonly PlaybackPick[];
	current: string;
	onPick: (key: string) => void;
	onClose: () => void;
}) => {
	const [active, setActive] = useState(() =>
		Math.max(
			0,
			picks.findIndex((p) => p.key === current)
		)
	);
	return (
		<TvPanel title={title} onClose={onClose}>
			<TvList
				items={picks}
				label={label}
				itemKey={(pick) => pick.key}
				active={active}
				onActiveChange={setActive}
				onSelect={(pick) => onPick(pick.key)}
				rowHeight={ROW_HEIGHT}
				height={PANEL_LIST_HEIGHT}
				start
				itemClassName="rounded-[0.5rem]"
				renderItem={(pick) => (
					<div className="flex h-full items-center gap-[0.5rem] rounded-[0.5rem] px-[0.75rem]">
						<div className="min-w-0 flex-1">
							<p className="truncate text-base font-medium">{pick.label}</p>
							{pick.detail && (
								<p className="truncate text-[0.8rem] leading-[1.1rem] opacity-70">
									{pick.detail}
								</p>
							)}
						</div>
						{pick.key === current && (
							<Check aria-label="Playing" className="size-[1.25rem] shrink-0" />
						)}
					</div>
				)}
			/>
		</TvPanel>
	);
};
