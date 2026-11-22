// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import {
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type KeyboardEvent,
	type RefObject,
} from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { HistoryImportedNotice } from "@/components/remote/HistoryImportedNotice";
import { ControllersBar, ProvidersAddedNotice } from "@/components/remote/RemoteControls";
import { hasOpenFocusTrap, onFocusLostOnClose } from "@/hooks/useFocusTrap";
import { useTvRemote } from "@/hooks/useTvRemote";
import { mpvSetVisible } from "@/lib/tauri";
import { focusTvFirstColumn, focusTvStart, moveFocus } from "@/lib/tv-focus";
import { TvNavContext, type TvNav, type TvSection } from "./tv-nav";
import { TvRail, currentRailItem } from "./TvRail";

/**
 * Moves the focus into the page's first column, if a section just opened and
 * the page has a place for it.
 */
const focusOpenedPage = (page: HTMLElement | null, wanted: RefObject<boolean>) => {
	if (wanted.current && page && focusTvFirstColumn(page)) wanted.current = false;
};

/** Gives the focus back to the page, or to the rail when the page has nothing to take it. */
const refocus = (page: HTMLElement | null, rail: HTMLElement | null) => {
	if (page && !focusTvStart(page)) focusTvStart(rail!);
};

/**
 * The TV's frame: a rail of sections beside the page. The player has the
 * whole screen with nothing around it. Each screen keeps its place in `memory`,
 * which outlives the player, so it comes back as it was.
 */
export const TvLayout = () => {
	const { pathname } = useLocation();
	const navigate = useNavigate();
	const isPlayer = pathname === "/player";
	useTvRemote();

	useEffect(() => {
		mpvSetVisible(isPlayer).catch(() => {});
	}, [isPlayer]);

	useLayoutEffect(
		() => {
			const root = document.documentElement;
			root.classList.add("tv");
			return () => root.classList.remove("tv");
		},
		// Stryker disable next-line ArrayDeclaration: any constant list runs the effect once, as an empty one does.
		[]
	);

	const [section, setSection] = useState<TvSection>("live");
	const [memory] = useState(() => new Map<string, unknown>());
	// The focus goes into the page once it has something to take it. A second
	// press on the current section still navigates, which renders the layout.
	const wantsPageRef = useRef(false);
	const pageRef = useRef<HTMLElement>(null);
	const railRef = useRef<HTMLElement>(null);

	useEffect(() => focusOpenedPage(pageRef.current, wantsPageRef));

	// A list that loads after its section opens, such as History's, doesn't render
	// the layout again, so the layout watches for it. It also catches the focused
	// row going away, such as the last entry of History, which leaves no cursor.
	useEffect(() => {
		const page = pageRef.current;
		if (!page) return;
		const observer = new MutationObserver(() => {
			focusOpenedPage(page, wantsPageRef);
			if (document.activeElement === document.body && !hasOpenFocusTrap()) {
				refocus(page, railRef.current);
			}
		});
		observer.observe(page, { childList: true, subtree: true });
		return () => observer.disconnect();
	}, [isPlayer]);

	// The splash, or a modal whose opener has gone, leaves focus nowhere.
	useEffect(
		() => onFocusLostOnClose(() => refocus(pageRef.current, railRef.current)),
		// Stryker disable next-line ArrayDeclaration: any constant list runs the effect once, as an empty one does.
		[]
	);

	const openSection: TvNav["openSection"] = (next) => {
		wantsPageRef.current = true;
		if (next === "settings") {
			navigate("/settings");
			return;
		}
		setSection(next);
		navigate("/");
	};

	const nav: TvNav = { section, openSection, memory };

	// Back walks left through a screen's columns to the rail. On the rail, Back
	// goes to Live TV, and from there it isn't taken, so the app closes.
	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== "Escape" || e.defaultPrevented) return;
		const rail = railRef.current;
		// Stryker disable next-line OptionalChaining: this handler sits on the rail's parent, so the rail is always mounted when it runs.
		if (!rail?.contains(document.activeElement)) {
			if (moveFocus("left")) e.preventDefault();
			return;
		}
		if (currentRailItem(pathname, section) !== "live") {
			e.preventDefault();
			wantsPageRef.current = false;
			setSection("live");
			navigate("/");
		}
	};

	return (
		<TvNavContext.Provider value={nav}>
			{isPlayer ? (
				<div className="fixed inset-0 overflow-clip text-foreground">
					<Outlet />
				</div>
			) : (
				<div
					className="relative h-screen overflow-clip bg-background text-foreground"
					onKeyDown={onKeyDown}
				>
					<TvRail ref={railRef} current={currentRailItem(pathname, section)} />
					<main
						ref={pageRef}
						className="absolute inset-y-0 right-[0.5rem] left-[4rem] overflow-clip peer-focus-within/rail:opacity-35"
					>
						<Outlet />
						{/* After the page, so the first control of a page with no marked row is its own. */}
						<div className="absolute top-[0.75rem] right-[1.5rem] z-30 flex w-[24rem] flex-col gap-[0.5rem] empty:hidden">
							<ControllersBar />
						</div>
					</main>
				</div>
			)}
			{/* They float over the page, the player included, and take the focus. */}
			<ProvidersAddedNotice />
			<HistoryImportedNotice />
		</TvNavContext.Provider>
	);
};
