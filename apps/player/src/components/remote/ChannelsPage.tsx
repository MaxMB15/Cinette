// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useNavigate } from "react-router";
import { ChannelList } from "@/components/channels/ChannelList";
import { RemoteCatalog } from "@/components/remote/RemoteCatalog";
import { useRemoteControl } from "@/hooks/useRemoteControl";
import { controlsOthers } from "@/lib/platform";

/**
 * The channels page: this device's channels, or, while another device is
 * the one that plays, that device's catalog, since its ids and channels are
 * its own.
 */
export const ChannelsPage = () => (controlsOthers() ? <ChannelsOrRemote /> : <ChannelList />);

const ChannelsOrRemote = () => {
	const { link } = useRemoteControl();
	const navigate = useNavigate();
	const remote = link?.phase.phase === "connected" || link?.phase.phase === "reconnecting";
	// Once the other device takes an item, its controls are on the player page.
	return remote ? (
		<RemoteCatalog key={link.deviceId} link={link} onPlayed={() => navigate("/player")} />
	) : (
		<ChannelList />
	);
};
