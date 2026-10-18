// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { ChannelList } from "@/components/channels/ChannelList";
import { RemoteCatalog } from "@/components/remote/RemoteCatalog";
import { useRemoteControl } from "@/hooks/useRemoteControl";

/**
 * The channels page: this device's channels, or, while another device is
 * the one that plays, that device's catalog, since its ids and channels are
 * its own.
 */
export const ChannelsPage = () => {
	const { link } = useRemoteControl();
	const remote = link?.phase.phase === "connected" || link?.phase.phase === "reconnecting";
	return remote ? <RemoteCatalog key={link.deviceId} link={link} /> : <ChannelList />;
};
