// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useLatestRef } from "@/hooks/useLatestRef";
import type { CatalogItem } from "@/lib/cinette-destination";
import type { Link } from "@/lib/remote-control";
import { remoteCatalog, type CatalogQuery } from "@/lib/tauri";

type ContentType = "live" | "movie" | "series";

const TYPES: { value: ContentType; label: string }[] = [
	{ value: "live", label: "Live" },
	{ value: "movie", label: "Movies" },
	{ value: "series", label: "Series" },
];

/** Items asked for in one page. */
export const PAGE = 100;
/** How long typing has to pause before a search goes out. */
export const SEARCH_DELAY_MS = 300;

/** Where in the other device's catalog the user is. */
type Place =
	| { kind: "groups" }
	| { kind: "group"; group: string }
	| { kind: "episodes"; series: CatalogItem; from: Place };

/** What the list shows. `more` is how the next page stands, if it's
 *  been asked for. */
type View =
	| { status: "loading" }
	| { status: "failed" }
	| {
			status: "ready";
			items: CatalogItem[];
			next: string | null;
			more: "loading" | "failed" | null;
	  };

const LOADING: View = { status: "loading" };

/** The query for what's on screen, or the page of it from `cursor`. */
const queryFor = (
	type: ContentType,
	place: Place,
	search: string,
	cursor?: string
): CatalogQuery => {
	if (search) return { kind: "search", query: search, contentType: type, limit: PAGE };
	switch (place.kind) {
		case "groups":
			return { kind: "groups", contentType: type, cursor, limit: PAGE };
		case "group":
			return { kind: "items", contentType: type, group: place.group, cursor, limit: PAGE };
		case "episodes":
			return { kind: "episodes", seriesId: place.series.id, cursor, limit: PAGE };
	}
};

/** "S1 E2" for an episode, or null for anything else. */
export const episodeLabel = (item: CatalogItem): string | null =>
	item.season !== undefined && item.episode !== undefined
		? `S${item.season} E${item.episode}`
		: null;

/** What a group is called on screen. M3U lists often leave it out. */
export const groupName = (group: string): string => group || "No group";

/**
 * The controlled device's channels, movies and series, read from that
 * device, while it's the one that plays. Browsing never touches what plays
 * there; choosing an item plays it there.
 */
export const RemoteCatalog = ({ link }: { link: Link }) => {
	const [type, setType] = useState<ContentType>("live");
	const [place, setPlace] = useState<Place>({ kind: "groups" });
	const [typed, setTyped] = useState("");
	const [search, setSearch] = useState("");
	const [view, setView] = useState<View>(LOADING);
	// A new one loads what's on screen again.
	const [attempt, setAttempt] = useState({});
	const [message, setMessage] = useState<string | null>(null);
	// Which view a page of "Load more" belongs to; a newer one drops it.
	const shownRef = useRef({});
	// What the list on screen was loaded for, so a link that comes back
	// keeps it, with the pages loaded since.
	const loadedForRef = useRef<unknown[] | null>(null);
	const viewRef = useLatestRef(view);
	const connected = link.phase.phase === "connected";

	const searchRef = useLatestRef(search);
	useEffect(() => {
		const timer = setTimeout(() => {
			const wanted = typed.trim();
			if (wanted === searchRef.current) return;
			setView(LOADING);
			setSearch(wanted);
		}, SEARCH_DELAY_MS);
		return () => clearTimeout(timer);
	}, [typed, searchRef]);

	useEffect(() => {
		// While the link is down nothing can come.
		if (!connected) return;
		const wanted = [link.id, type, place, search, attempt];
		const loadedFor = loadedForRef.current;
		if (
			viewRef.current.status === "ready" &&
			loadedFor?.every((value, i) => Object.is(value, wanted[i]))
		)
			return;
		let current = true;
		shownRef.current = {};
		remoteCatalog(link.id, queryFor(type, place, search))
			.then(({ items, next }) => {
				if (!current) return;
				loadedForRef.current = wanted;
				setView({ status: "ready", items, next, more: null });
			})
			.catch(() => {
				if (current) setView({ status: "failed" });
			});
		return () => {
			current = false;
		};
	}, [link.id, connected, type, place, search, attempt, viewRef]);

	const go = (to: Place) => {
		setView(LOADING);
		setPlace(to);
	};

	const retry = () => {
		setView(LOADING);
		setAttempt({});
	};

	const more = (shown: CatalogItem[], cursor: string) => {
		const forView = shownRef.current;
		const ready = (more: "loading" | "failed") =>
			setView({ status: "ready", items: shown, next: cursor, more });
		ready("loading");
		remoteCatalog(link.id, queryFor(type, place, search, cursor))
			.then(({ items, next }) => {
				if (shownRef.current !== forView) return;
				setView({ status: "ready", items: [...shown, ...items], next, more: null });
			})
			.catch(() => {
				if (shownRef.current === forView) ready("failed");
			});
	};

	const play = (item: CatalogItem) => {
		setMessage(null);
		link.destination
			.load({ kind: "remote", itemId: item.id, title: item.name })
			.catch(() => setMessage(`${link.name} couldn't play ${item.name}.`));
	};

	const choose = (item: CatalogItem) => {
		if (search === "" && place.kind === "groups") go({ kind: "group", group: item.id });
		else if (item.contentType === "series" && episodeLabel(item) === null) {
			// From search results, the episodes replace the search, and going
			// back goes to the groups.
			setTyped("");
			setSearch("");
			go({ kind: "episodes", series: item, from: search ? { kind: "groups" } : place });
		} else play(item);
	};

	const title = search
		? `Search results on ${link.name}`
		: place.kind === "group"
			? groupName(place.group)
			: place.kind === "episodes"
				? place.series.name
				: `On ${link.name}`;
	const canGoBack = place.kind !== "groups" && search === "";
	const listsGroups = place.kind === "groups" && search === "";
	const nextPage =
		view.status === "ready" && view.next !== null
			? { shown: view.items, cursor: view.next, more: view.more }
			: null;

	return (
		<div className="h-full flex flex-col">
			<div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
				{canGoBack && (
					<button
						type="button"
						aria-label="Back"
						className="p-1 rounded hover:bg-accent"
						onClick={() =>
							go(place.kind === "episodes" ? place.from : { kind: "groups" })
						}
					>
						<ChevronLeft className="h-4 w-4" aria-hidden />
					</button>
				)}
				<h1 className="text-base font-semibold truncate min-w-0" title={title}>
					{title}
				</h1>
				<SegmentedControl
					value={type}
					onChange={(t) => {
						setType(t);
						go({ kind: "groups" });
					}}
					options={TYPES}
				/>
				<div className="relative ml-auto w-56 max-w-full">
					<Search
						className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground"
						aria-hidden
					/>
					<Input
						value={typed}
						onChange={(e) => setTyped(e.target.value)}
						placeholder={`Search ${link.name}`}
						aria-label={`Search ${link.name}`}
						className="pl-8"
					/>
				</div>
			</div>
			{message && (
				<p role="alert" className="px-4 py-2 text-sm text-red-500">
					{message}
				</p>
			)}
			<div className="flex-1 min-h-0 overflow-y-auto">
				{view.status === "failed" ? (
					<div className="p-4 text-sm text-muted-foreground">
						<p>Couldn&apos;t load this from {link.name}.</p>
						<button
							type="button"
							className="mt-2 px-3 py-1.5 text-xs rounded-md bg-secondary hover:bg-secondary/80"
							onClick={retry}
						>
							Try again
						</button>
					</div>
				) : view.status === "loading" ? (
					<p className="p-4 text-sm text-muted-foreground">Loading…</p>
				) : view.items.length === 0 ? (
					<p className="p-4 text-sm text-muted-foreground">
						{search ? `Nothing on ${link.name} matches.` : "Nothing here."}
					</p>
				) : (
					<ul aria-label={title}>
						{view.items.map((item) => {
							const line = episodeLabel(item) ?? item.nowPlaying;
							const name = listsGroups ? groupName(item.name) : item.name;
							return (
								<li key={item.id}>
									<button
										type="button"
										className="w-full flex items-center gap-3 px-4 py-2 text-left hover:bg-accent focus-visible:outline-hidden focus-visible:bg-accent"
										onClick={() => choose(item)}
									>
										{item.logo ? (
											<img
												src={item.logo}
												alt=""
												referrerPolicy="no-referrer"
												className="h-8 w-8 object-contain shrink-0"
											/>
										) : (
											<span
												className="h-8 w-8 shrink-0 rounded bg-muted"
												aria-hidden
											/>
										)}
										<span className="flex-1 min-w-0">
											<span className="block text-sm truncate">{name}</span>
											{line && (
												<span className="block text-xs text-muted-foreground truncate">
													{line}
												</span>
											)}
										</span>
									</button>
								</li>
							);
						})}
					</ul>
				)}
				{nextPage && (
					<div className="m-4 flex items-center gap-3">
						<button
							type="button"
							disabled={nextPage.more === "loading"}
							className="px-3 py-1.5 text-xs rounded-md bg-secondary hover:bg-secondary/80 disabled:opacity-50"
							onClick={() => more(nextPage.shown, nextPage.cursor)}
						>
							{nextPage.more === "failed" ? "Try again" : "Load more"}
						</button>
						{nextPage.more === "failed" && (
							<p role="alert" className="text-xs text-red-500">
								Couldn&apos;t load more from {link.name}.
							</p>
						)}
					</div>
				)}
			</div>
		</div>
	);
};
