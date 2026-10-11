// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { Routes, Route } from "react-router-dom";
import { AppLayout } from "./components/AppLayout";
import { PlayerView } from "./components/player/VideoPlayer";
import { ChannelList } from "./components/channels/ChannelList";
import { PlaylistManager } from "./components/playlist/PlaylistManager";
import { Settings } from "./components/settings/Settings";
import { UpdateBanner } from "./components/UpdateBanner";
import { SplashScreen } from "./components/SplashScreen";
import { DonationPopup } from "./components/DonationPopup";
import { ChannelsContext, useChannels, useChannelsProvider } from "./hooks/useChannels";
import { useUpdateChecker } from "./hooks/useUpdateChecker";
import { useSplashScreen } from "./hooks/useSplashScreen";
import { useDonationPrompt } from "./hooks/useDonationPrompt";
import { FullscreenProvider } from "./lib/fullscreen-context";
import { DownloadsProvider } from "@/hooks/useDownloads";
import { isMobilePlatform } from "@/lib/platform";

export default function App() {
	const channelsValue = useChannelsProvider();
	const updateState = useUpdateChecker();

	return (
		<ChannelsContext.Provider value={channelsValue}>
			<FullscreenProvider>
				<DownloadsProvider>
					<AppRoutes updateState={updateState} />
				</DownloadsProvider>
			</FullscreenProvider>
		</ChannelsContext.Provider>
	);
}

// Inner component so useSplashScreen can access ChannelsContext via useChannels.
interface AppRoutesProps {
	updateState: ReturnType<typeof useUpdateChecker>;
}

const AppRoutes = ({ updateState }: AppRoutesProps) => {
	const { refreshProviders, refreshChannels } = useChannels();
	const splash = useSplashScreen({
		updateState,
		// After splash finishes any playlist/EPG refreshes, sync ChannelsContext so
		// polling in useChannels reads fresh lastUpdated timestamps (avoids re-triggering
		// the same refresh 60s later due to stale state).
		onComplete: (didRefreshProviders) => {
			if (didRefreshProviders) {
				refreshProviders().catch(() => {});
				refreshChannels().catch(() => {});
			}
		},
	});

	// No donation prompt on mobile, where App Store rules don't allow one.
	const donation = useDonationPrompt({ enabled: splash.dismissed && !isMobilePlatform() });

	return (
		<>
			{!splash.dismissed && <SplashScreen splash={splash} updateState={updateState} />}

			<Routes>
				<Route element={<AppLayout />}>
					<Route path="/" element={<ChannelList />} />
					<Route path="/player" element={<PlayerView />} />
					<Route path="/playlists" element={<PlaylistManager />} />
					<Route path="/settings" element={<Settings updateState={updateState} />} />
				</Route>
			</Routes>

			<UpdateBanner state={updateState} hidden={!splash.dismissed} />
			{donation.shouldShow && !updateState.update && (
				<DonationPopup onDismiss={donation.dismiss} />
			)}
		</>
	);
};
