// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useEffect, useState } from "react";
import { useLatestRef } from "@/hooks/useLatestRef";
import { ChevronLeft, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
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

/** The query for what's on screen, or the next page of it. */
const queryFor = (
	type: ContentType,
	place: Place,
	search: string,
	cursor?: string
): CatalogQuery => {
	if (search) return { kind: "search", query: search, contentType: type, limit: PAGE };
	switch (place.kind) {
		case "groups":
			return { kind: "groups", contentType: type };
		case "group":
			return cursor === undefined
				? { kind: "items", contentType: type, group: place.group, limit: PAGE }
				: { kind: "items", contentType: type, group: place.group, cursor, limit: PAGE };
		case "episodes":
			return { kind: "episodes", seriesId: place.series.id };
	}
};

const episodeLabel = (item: CatalogItem): string | null =>
	item.season !== undefined && item.episode !== undefined
		? `S${item.season} E${item.episode}`
		: null;

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
	const [items, setItems] = useState<CatalogItem[]>([]);
	const [next, setNext] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [failed, setFailed] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	const searchRef = useLatestRef(search);
	useEffect(() => {
		const timer = setTimeout(() => {
			const wanted = typed.trim();
			if (wanted === searchRef.current) return;
			setLoading(true);
			setItems([]);
			setSearch(wanted);
		}, SEARCH_DELAY_MS);
		return () => clearTimeout(timer);
	}, [typed, searchRef]);

	useEffect(() => {
		let current = true;
		remoteCatalog(queryFor(type, place, search))
			.then((page) => {
				if (!current) return;
				setItems(page.items);
				setNext(page.next);
				setFailed(false);
			})
			.catch(() => {
				if (current) setFailed(true);
			})
			.finally(() => {
				if (current) setLoading(false);
			});
		return () => {
			current = false;
		};
	}, [type, place, search]);

	const go = (to: Place) => {
		setLoading(true);
		setItems([]);
		setPlace(to);
	};

	const more = () => {
		if (next === null) return;
		remoteCatalog(queryFor(type, place, search, next))
			.then((page) => {
				setItems((shown) => [...shown, ...page.items]);
				setNext(page.next);
			})
			.catch(() => setFailed(true));
	};

	const play = (item: CatalogItem) => {
		setMessage(null);
		link.destination
			.load({ kind: "remote", itemId: item.id, title: item.name })
			.catch(() => setMessage(`${link.name} couldn't play ${item.name}.`));
	};

	const choose = (item: CatalogItem) => {
		if (search === "" && place.kind === "groups") go({ kind: "group", group: item.id });
		else if (item.contentType === "series" && episodeLabel(item) === null)
			go({
				kind: "episodes",
				series: item,
				from: search === "" ? place : { kind: "groups" },
			});
		else play(item);
	};

	const back: Place = place.kind === "episodes" ? place.from : { kind: "groups" };
	const title =
		place.kind === "group"
			? place.group
			: place.kind === "episodes"
				? place.series.name
				: `On ${link.name}`;

	return (
		<div className="h-full flex flex-col">
			<div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b border-border">
				{place.kind !== "groups" && search === "" && (
					<button
						type="button"
						aria-label="Back"
						className="p-1 rounded hover:bg-accent"
						onClick={() => go(back)}
					>
						<ChevronLeft className="h-4 w-4" aria-hidden />
					</button>
				)}
				<h1 className="text-base font-semibold truncate">{title}</h1>
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
				{failed ? (
					<p className="p-4 text-sm text-muted-foreground">
						Couldn&apos;t load this from {link.name}.
					</p>
				) : loading ? (
					<p className="p-4 text-sm text-muted-foreground">Loading…</p>
				) : items.length === 0 ? (
					<p className="p-4 text-sm text-muted-foreground">
						{search ? `Nothing on ${link.name} matches.` : "Nothing here."}
					</p>
				) : (
					<ul aria-label={title}>
						{items.map((item) => (
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
											className="h-8 w-8 object-contain shrink-0"
										/>
									) : (
										<span
											className="h-8 w-8 shrink-0 rounded bg-muted"
											aria-hidden
										/>
									)}
									<span className="flex-1 min-w-0">
										<span className="block text-sm truncate">{item.name}</span>
										{(item.nowPlaying || episodeLabel(item)) && (
											<span className="block text-xs text-muted-foreground truncate">
												{episodeLabel(item) ?? item.nowPlaying}
											</span>
										)}
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
				{next !== null && !failed && !loading && (
					<button
						type="button"
						className="m-4 px-3 py-1.5 text-xs rounded-md bg-secondary hover:bg-secondary/80"
						onClick={more}
					>
						Load more
					</button>
				)}
			</div>
		</div>
	);
};
