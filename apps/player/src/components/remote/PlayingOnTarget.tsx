// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useLocation } from "react-router";
import { usePlayingOnTarget, useRemoteSessions } from "@/hooks/useRemoteTarget";

const FollowMpv = () => {
	usePlayingOnTarget();
	return null;
};

/**
 * Lets controllers follow and drive what mpv plays on with the player page
 * closed. It polls mpv, so it only runs while a controller is connected.
 */
export const PlayingOnTarget = () => {
	const connected = useRemoteSessions().some((s) => s.connected);
	const { pathname } = useLocation();
	return connected && pathname !== "/player" ? <FollowMpv /> : null;
};
