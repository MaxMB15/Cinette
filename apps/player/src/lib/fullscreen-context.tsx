// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createChangeTracker } from "@/lib/change-tracker";
import {
	RECHECK_MS,
	followWindowFullscreen,
	setWindowFullscreen,
	type FullscreenFollower,
} from "@/lib/fullscreen";

interface FullscreenContextValue {
	isFullscreen: boolean;
	/**
	 * Puts the player in or out of full screen. This hides or shows the
	 * sidebar and sets the window to match, so every way in or out, such as
	 * the button, Escape or closing the player, leaves the two in step. The
	 * state also follows the window when it changes some other way.
	 */
	setFullscreen: (on: boolean) => void;
}

export const FullscreenContext = createContext<FullscreenContextValue>({
	isFullscreen: false,
	setFullscreen: () => {},
});

export const FullscreenProvider = ({ children }: { children: React.ReactNode }) => {
	const [isFullscreen, setIsFullscreen] = useState(false);
	// The app's own changes, so that a read of the window sent before one
	// can't undo it.
	const [changes] = useState(createChangeTracker);
	const followerRef = useRef<FullscreenFollower | null>(null);
	const setFullscreen = useCallback(
		(on: boolean) => {
			setIsFullscreen(on);
			const done = changes.begin();
			setWindowFullscreen(on)
				.catch((e) => {
					console.error(`[fullscreen] setFullscreen(${on}) failed:`, e);
				})
				.finally(() => {
					done();
					// macOS can turn the change down, and then the window
					// doesn't resize, so nothing else would read it.
					setTimeout(() => followerRef.current?.recheck(), RECHECK_MS);
				});
		},
		[changes]
	);
	// The window can go in or out of full screen without the app, such as
	// with the green button on macOS. A change asked for during the animation
	// of another one only lands when that ends. Following the window keeps
	// the sidebar, the button and Escape in step with what's on screen.
	useEffect(() => {
		const follower = followWindowFullscreen(setIsFullscreen, changes);
		followerRef.current = follower;
		return () => {
			follower.stop();
			followerRef.current = null;
		};
	}, [changes]);
	const value = useMemo(() => ({ isFullscreen, setFullscreen }), [isFullscreen, setFullscreen]);
	return <FullscreenContext.Provider value={value}>{children}</FullscreenContext.Provider>;
};

export const useFullscreen = () => useContext(FullscreenContext);
