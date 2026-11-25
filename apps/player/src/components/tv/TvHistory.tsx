// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Trash } from "lucide-react";
import { useWatchHistory } from "@/hooks/useWatchHistory";
import { deleteHistoryEntry } from "@/lib/tauri";
import type { WatchHistoryEntry } from "@/lib/types";
import { formatRelativeDate } from "@/lib/watch-history";
import { TvList } from "./TvList";
import { COLUMN_HEIGHT, TvButton, TvChannelRow, TvEmpty, TvHeader } from "./ui";
import { useRemembered } from "./tv-nav";

const ROW_HEIGHT = 3.4;
const HISTORY_LIMIT = 200;

/** What was watched, newest first. OK picks it up again, and Remove is one press to the right. */
export const TvHistory = ({
	onOpen,
	opening = false,
	missingId = null,
}: {
	onOpen: (entry: WatchHistoryEntry) => void;
	/** The episodes of the entry OK was pressed on are loading. */
	opening?: boolean;
	/** The entry that had nothing to open when OK was pressed on it. */
	missingId?: string | null;
}) => {
	const { entries, loading, change } = useWatchHistory(
		HISTORY_LIMIT,
		undefined,
		"[TvHistory] failed to fetch history:"
	);
	const [active, setActive] = useRemembered("history", 0);
	const entry: WatchHistoryEntry | undefined = entries[Math.min(active, entries.length - 1)];
	const missing = missingId === entry?.channelId;

	const remove = async (channelId: string) => {
		try {
			await deleteHistoryEntry(channelId);
			change((prev) => prev.filter((e) => e.channelId !== channelId));
		} catch (err) {
			console.error("[TvHistory] failed to delete entry:", err);
		}
	};

	return (
		<div className="flex h-full flex-col">
			<TvHeader title="History" />
			{entries.length > 0 ? (
				<div className="flex gap-[1.5rem] px-[1.5rem]">
					<TvList
						className="w-[36rem] shrink-0"
						items={entries}
						label="History"
						itemKey={(e) => e.channelId}
						active={active}
						onActiveChange={setActive}
						onSelect={onOpen}
						rowHeight={ROW_HEIGHT}
						height={COLUMN_HEIGHT}
						start
						itemClassName="rounded-[0.5rem]"
						renderItem={(e) => (
							<TvChannelRow
								channel={{
									name: e.channelName,
									logoUrl: e.channelLogo ?? undefined,
									isFavorite: false,
								}}
								line={formatRelativeDate(e.lastWatchedAt)}
							/>
						)}
					/>
					{entry && (
						<div className="min-w-0 flex-1">
							<TvButton
								className="w-full"
								onClick={() => void remove(entry.channelId)}
							>
								<Trash aria-hidden className="size-[1.25rem]" />
								Remove
							</TvButton>
							<p role="status" className="mt-[0.75rem] text-base opacity-70">
								{opening && "Loading episodes"}
								{!opening &&
									missing &&
									"Couldn't open this. It may have left your provider."}
							</p>
						</div>
					)}
				</div>
			) : (
				!loading && <TvEmpty title="What you watch shows up here" />
			)}
		</div>
	);
};
