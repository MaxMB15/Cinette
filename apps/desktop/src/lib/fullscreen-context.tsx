// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { setWindowFullscreen } from "@/lib/fullscreen";

interface FullscreenContextValue {
	isFullscreen: boolean;
	/**
	 * Puts the player in or out of full screen. This hides or shows the
	 * sidebar and sets the window to match, so every way in or out, such as
	 * the button, Escape or closing the player, leaves the two in step.
	 */
	setFullscreen: (on: boolean) => void;
}

export const FullscreenContext = createContext<FullscreenContextValue>({
	isFullscreen: false,
	setFullscreen: () => {},
});

export const FullscreenProvider = ({ children }: { children: React.ReactNode }) => {
	const [isFullscreen, setIsFullscreen] = useState(false);
	const setFullscreen = useCallback((on: boolean) => {
		setIsFullscreen(on);
		setWindowFullscreen(on).catch((e) => {
			console.error(`[fullscreen] setFullscreen(${on}) failed:`, e);
		});
	}, []);
	const value = useMemo(() => ({ isFullscreen, setFullscreen }), [isFullscreen, setFullscreen]);
	return <FullscreenContext.Provider value={value}>{children}</FullscreenContext.Provider>;
};

export const useFullscreen = () => useContext(FullscreenContext);
