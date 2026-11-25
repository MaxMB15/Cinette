// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// Whose library the channel screens show, and what picking an item there
// does. Without a provider they show this device's and open the player page.

import { createContext, useCallback, useContext } from "react";
import { useNavigate } from "react-router";
import { LOCAL, type Source } from "@/lib/library";
import type { Channel } from "@/lib/types";

/** What the channel screens pick to play, as the player page takes it. */
export interface PlayState {
	url: string;
	channelName: string;
	channel: Channel;
	seriesEpisodes?: Channel[];
}

interface LibraryContextValue {
	source: Source;
	/** Plays a pick on another device, in place of this device's player page. */
	play?: (state: PlayState) => void;
}

const LibraryContext = createContext<LibraryContextValue>({ source: LOCAL });

export const LibraryProvider = LibraryContext.Provider;

/** Where the library the channel screens show comes from. */
export const useLibrarySource = (): Source => useContext(LibraryContext).source;

/** Whether the channel screens show the library of a device this one controls. */
export const useRemoteLibrary = (): boolean => useLibrarySource() !== LOCAL;

/** Plays what the channel screens picked, on this device's player or the controlled device. */
export const usePlay = (): ((state: PlayState) => void) => {
	const { play } = useContext(LibraryContext);
	const navigate = useNavigate();
	const local = useCallback(
		(state: PlayState) => {
			void navigate("/player", { state });
		},
		[navigate]
	);
	return play ?? local;
};
