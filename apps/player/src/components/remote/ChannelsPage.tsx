// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useNavigate } from "react-router";
import { ChannelList } from "@/components/channels/ChannelList";
import { RemoteCatalog } from "@/components/remote/RemoteCatalog";
import { useLeave } from "@/components/remote/RemoteControls";
import { RemoteLibrary } from "@/components/remote/RemoteLibrary";
import { useRemoteControl } from "@/hooks/useRemoteControl";
import { controlsOthers } from "@/lib/platform";

/**
 * The channels page: this device's channels, or, while another device is
 * the one that plays, that device's, since its ids and channels are its own.
 * A device that sends its library shows in the same screens as this one's,
 * and an older one in its catalog.
 */
export const ChannelsPage = () => (controlsOthers() ? <ChannelsOrRemote /> : <ChannelList />);

const ChannelsOrRemote = () => {
	const { link } = useRemoteControl();
	const navigate = useNavigate();
	// Kept here, since the library's screen goes with the link.
	const { leave, failed } = useLeave();
	const remote = link?.phase.phase === "connected" || link?.phase.phase === "reconnecting";
	return (
		<>
			{failed}
			{/* Once the other device takes an item, its controls are on the player page. */}
			{!remote ? (
				<ChannelList />
			) : link.features.includes("library") ? (
				<RemoteLibrary key={link.id} link={link} onLeave={leave} />
			) : (
				<RemoteCatalog
					key={link.deviceId}
					link={link}
					onPlayed={() => navigate("/player")}
				/>
			)}
		</>
	);
};
