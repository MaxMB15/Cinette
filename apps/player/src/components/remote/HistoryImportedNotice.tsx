// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useTauriEvent } from "@/hooks/useRemoteTarget";
import { formatTime } from "@/lib/format";
import { playbackKey } from "@/lib/playback";
import { channelsQuery, historyKey } from "@/lib/queries";
import { applyRemoteCommand, getMountedPlayer, waitForMountedPlayer } from "@/lib/remote-target";
import { getPlaybackPosition, mpvStop, type RemoteHistoryImported } from "@/lib/tauri";
import type { Channel } from "@/lib/types";

/**
 * Says history from another device was added here, and loads the history,
 * favorites and pinned groups again, so they show without a restart. When
 * the other device's last item matched one here, it offers to continue it
 * at the saved place. Nothing plays until that's chosen, and then it starts
 * from the place saved here by then.
 */
export const HistoryImportedNotice = () => {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [imported, setImported] = useState<RemoteHistoryImported | null>(null);
	useTauriEvent<RemoteHistoryImported>("remote://history-imported", (event) => {
		void queryClient.invalidateQueries({ queryKey: historyKey() });
		void queryClient.invalidateQueries({ queryKey: channelsQuery().queryKey });
		void queryClient.invalidateQueries({ queryKey: ["local", "pinnedGroups"] });
		setImported(event);
	});
	if (!imported) return null;
	const channel = imported.channel;
	const at = imported.report.resume?.position;
	const resume = async (channel: Channel) => {
		setImported(null);
		// It may have been watched here since the import.
		const key = playbackKey(channel);
		const saved = key ? await getPlaybackPosition(key).catch(() => undefined) : null;
		const startAt = saved && !saved.finished ? saved.positionSeconds : undefined;
		await applyRemoteCommand(
			{ action: "load", itemId: channel.id, startAt },
			{
				player: getMountedPlayer(),
				findChannel: () => channel,
				openPlayer: () => navigate("/player"),
				waitForPlayer: waitForMountedPlayer,
				stopWithoutPlayer: mpvStop,
			}
		).catch(() => {});
	};
	return createPortal(
		<div
			role="status"
			className="fixed left-1/2 -translate-x-1/2 bottom-4 z-10000 flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-4 py-2 text-sm shadow-xl max-w-[calc(100vw-2rem)] break-words"
		>
			<span>
				Added history from <bdi>{imported.from || "another device"}</bdi>.
			</span>
			{channel && (
				<button
					type="button"
					className="px-3 py-1 text-xs rounded-md bg-primary text-primary-foreground hover:bg-primary/90"
					onClick={() => void resume(channel)}
				>
					Continue watching <bdi>{channel.name}</bdi>
					{at ? ` at ${formatTime(at)}` : ""}
				</button>
			)}
			<button
				type="button"
				aria-label="Dismiss"
				className="text-muted-foreground hover:text-foreground"
				onClick={() => setImported(null)}
			>
				<X className="h-4 w-4" aria-hidden />
			</button>
		</div>,
		document.body
	);
};
