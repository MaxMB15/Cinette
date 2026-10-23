// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useSyncExternalStore } from "react";
import { nowPlaying, type NowPlayingState } from "@/lib/now-playing";

/** The TV something plays on, what it plays, and why the last one ended. */
export const useNowPlaying = (): NowPlayingState =>
	useSyncExternalStore(nowPlaying.subscribe, nowPlaying.getState);
