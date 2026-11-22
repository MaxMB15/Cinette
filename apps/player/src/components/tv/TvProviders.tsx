// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Calendar, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
	EMPTY_GUIDE_MESSAGE,
	EPG_INTERVAL_OPTIONS,
	INTERVAL_OPTIONS,
} from "@/components/playlist/ProviderSettingsModal";
import { M3U_DEFAULT_NAME, XTREAM_DEFAULT_NAME } from "@/components/playlist/AddProvider";
import { DISCLAIMER_TEXT } from "@/components/playlist/ContentDisclaimer";
import {
	getEpgLastRefresh,
	loadProviderSettings,
	saveProviderSettings,
	setEpgLastRefresh,
	useChannels,
	type ProviderSettings,
} from "@/hooks/useChannels";
import { useNow } from "@/hooks/useNow";
import { useTvTasks } from "@/hooks/useTvTasks";
import { parseDateMs, timeAgo } from "@/lib/date";
import { displayUrl, isFileUrl } from "@/lib/file-url";
import { formatCount } from "@/lib/format";
import { contentCountsQuery } from "@/lib/queries";
import { detectEpgUrl, refreshEpg, setEpgUrl } from "@/lib/tauri";
import type { ContentCounts, Provider } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
	TvStatusDot,
	choiceRow,
	toggleRow,
	type TvSetting,
	type TvSettingsSection,
} from "./TvSettingsColumns";

/** A URL typed with the D-pad starts here, since most do. */
const URL_START = "http://";

const asChoices = (options: { label: string; hours: number }[]) =>
	options.map(({ label, hours }) => ({ value: hours, label }));

const TYPES: { value: Provider["type"]; label: string }[] = [
	{ value: "m3u", label: "M3U playlist" },
	{ value: "xtream", label: "Xtream Codes" },
];

/** A tile's color for each provider in turn. */
const TILE_COLORS = [
	"bg-[hsl(214_45%_32%)]",
	"bg-[hsl(160_45%_32%)]",
	"bg-[hsl(275_35%_38%)]",
	"bg-[hsl(25_55%_36%)]",
	"bg-[hsl(340_40%_38%)]",
];

const COUNTS: { key: keyof ContentCounts; label: string }[] = [
	{ key: "live", label: "Live TV" },
	{ key: "movies", label: "Movies" },
	{ key: "series", label: "Series" },
];

/**
 * A provider's first letter on a color of its own, since a provider has no
 * logo. The letter is drawn by CSS, so it isn't part of the row's text.
 */
const ProviderTile = ({ name, index, large }: { name: string; index: number; large?: boolean }) => (
	<span
		aria-hidden
		data-letter={name.charAt(0).toUpperCase()}
		className={cn(
			"flex shrink-0 items-center justify-center font-bold text-white before:content-[attr(data-letter)]",
			large
				? "size-[2.6rem] rounded-[0.65rem] text-[1.3rem]"
				: "size-[2rem] rounded-[0.5rem] text-[1rem]",
			TILE_COLORS[index % TILE_COLORS.length]
		)}
	/>
);

/** What sits over a provider's rows: its kind, how much it has, and when it last updated. */
const ProviderSummary = ({
	provider,
	index,
	failed,
}: {
	provider: Provider;
	index: number;
	failed: boolean;
}) => {
	// The counts change only when the provider updates.
	const { data: counts } = useQuery(contentCountsQuery(provider.id, provider.lastUpdated));
	const now = useNow() * 1000;
	const updated = parseDateMs(provider.lastUpdated);
	const guide = getEpgLastRefresh(provider.id);
	const line = [
		failed && "Refresh failed",
		updated > 0 && `Updated ${timeAgo(updated, now)}`,
		guide > 0 && `Guide updated ${timeAgo(guide, now)}`,
	]
		.filter(Boolean)
		.join(" · ");
	return (
		<div className="flex flex-col gap-[0.7rem]">
			<div className="flex items-center gap-[0.7rem]">
				<ProviderTile name={provider.name} index={index} large />
				<div className="min-w-0">
					<p className="truncate text-[1.2rem] leading-[1.5rem] font-semibold">
						{provider.name}
					</p>
					<p className="text-[0.8rem] leading-[1rem] opacity-65">
						{TYPES.find((t) => t.value === provider.type)!.label}
					</p>
				</div>
			</div>
			<dl className="flex h-[2.3rem] gap-[1.8rem]">
				{counts &&
					COUNTS.map(({ key, label }) => (
						<div key={key} className="flex flex-col-reverse">
							<dt className="text-[0.7rem] leading-[0.9rem] opacity-60">{label}</dt>
							<dd className="text-[1.1rem] leading-[1.4rem] font-semibold tabular-nums">
								{counts[key].toLocaleString()}
							</dd>
						</div>
					))}
			</dl>
			<p className="flex items-center gap-[0.4rem] text-[0.75rem] leading-[1rem] opacity-80">
				<TvStatusDot status={failed ? "failed" : "ok"} />
				<span className="truncate">{line}</span>
			</p>
		</div>
	);
};

const NO_FORM = { type: "m3u" as Provider["type"], name: "", url: "", username: "", password: "" };

/** A row with a text value, which the keyboard changes. */
const textRow = (
	id: string,
	label: string,
	text: string,
	onDone: (text: string) => void,
	shown: string = text || "Not set"
): TvSetting => ({
	id,
	label,
	value: shown,
	entry: {
		title: label,
		value: text,
		prefill: id.endsWith("url") ? URL_START : undefined,
		onDone,
	},
});

/**
 * Settings' sections for providers: one for each, with every setting as a row
 * that applies when it's chosen, then one to add a provider. A file can't be
 * picked on a TV, and the last section points to another device that can send
 * providers with their logins, which beats typing a password with arrows.
 */
export const useTvProviderSections = (): TvSettingsSection[] => {
	const {
		providers,
		loadM3u,
		loadXtream,
		refreshProvider,
		refreshProviders,
		removeProvider,
		updateProvider,
	} = useChannels();
	const tasks = useTvTasks();
	// What this screen changed, over what storage says.
	const [changed, setChanged] = useState<Record<string, ProviderSettings>>({});
	const [form, setForm] = useState(NO_FORM);

	const section = (p: Provider, index: number): TvSettingsSection => {
		const key = (row: string) => `${p.id}/${row}`;
		const isFile = isFileUrl(p.url);
		const isXtream = p.type === "xtream";
		const prefs = changed[p.id] ?? loadProviderSettings(p.id);
		const setPrefs = (change: Partial<ProviderSettings>) => {
			const next = { ...prefs, ...change };
			saveProviderSettings(p.id, next);
			setChanged((now) => ({ ...now, [p.id]: next }));
		};
		const edit = (change: Partial<Provider>) =>
			tasks.run(key("details"), () => {
				const next = { ...p, ...change };
				return updateProvider(
					p.id,
					next.name,
					next.url,
					isXtream ? (next.username ?? "") : undefined,
					isXtream ? (next.password ?? "") : undefined
				);
			});
		const setGuideUrl = async (url: string | null) => {
			await setEpgUrl(p.id, url);
			await refreshProviders();
		};
		const detailsHint = tasks.message(key("details"));
		const updated =
			p.lastUpdated &&
			`Updated ${new Date(p.lastUpdated).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;

		const rows: TvSetting[] = [
			...(isFile
				? []
				: [
						{
							id: "refresh",
							label: "Refresh now",
							icon: <RefreshCw aria-hidden />,
							busy: tasks.busy(key("refresh")),
							hint: tasks.message(key("refresh")) ?? updated,
							onSelect: () => tasks.run(key("refresh"), () => refreshProvider(p.id)),
						},
					]),
			{
				id: "guide-refresh",
				label: "Refresh guide now",
				icon: <Calendar aria-hidden />,
				busy: tasks.busy(key("guide-refresh")),
				hint: tasks.message(key("guide-refresh")),
				onSelect: () =>
					tasks.run(key("guide-refresh"), async () => {
						const saved = await refreshEpg(p.id);
						// The automatic refresh waits a full interval from now, and the
						// channel list loads the guide again.
						setEpgLastRefresh(p.id);
						return saved === 0 ? EMPTY_GUIDE_MESSAGE : "The guide is up to date.";
					}),
			},
			{
				...textRow("name", "Name", p.name, (text) => {
					if (text.trim()) edit({ name: text.trim() });
				}),
				hint: detailsHint,
			},
			isFile
				? { id: "file", label: "File", value: displayUrl(p.url) }
				: {
						...textRow(
							"url",
							isXtream ? "Server URL" : "Playlist URL",
							p.url,
							(text) => {
								if (text.trim()) edit({ url: text.trim() });
							}
						),
						hint: detailsHint ?? <p className="break-all">{p.url}</p>,
					},
			...(isXtream
				? [
						{
							...textRow("username", "Username", p.username ?? "", (text) =>
								edit({ username: text })
							),
							hint: detailsHint,
						},
						{
							...textRow(
								"password",
								"Password",
								p.password ?? "",
								(text) => edit({ password: text }),
								p.password ? "Set" : "Not set"
							),
							hint: detailsHint,
						},
					]
				: []),
			...(isFile
				? []
				: [
						toggleRow("auto", "Refresh automatically", prefs.autoRefresh, (on) =>
							setPrefs({ autoRefresh: on })
						),
						...(prefs.autoRefresh
							? [
									choiceRow(
										"every",
										"Refresh every",
										asChoices(INTERVAL_OPTIONS),
										prefs.refreshIntervalHours,
										(hours) => setPrefs({ refreshIntervalHours: hours })
									),
								]
							: []),
					]),
			{
				...textRow("guide-url", "Guide URL", p.epgUrl ?? "", (text) =>
					tasks.run(key("guide-url"), () => setGuideUrl(text.trim() || null))
				),
				busy: tasks.busy(key("guide-url")),
				hint:
					tasks.message(key("guide-url")) ??
					(p.epgUrl && <p className="break-all">{p.epgUrl}</p>),
			},
			{
				id: "guide-find",
				label: "Find the guide URL",
				busy: tasks.busy(key("guide-find")),
				hint: tasks.message(key("guide-find")),
				onSelect: () =>
					tasks.run(key("guide-find"), async () => {
						const detected = await detectEpgUrl(p.id);
						if (!detected) return "No EPG URL detected";
						await setGuideUrl(detected);
						return `Found ${detected}`;
					}),
			},
			toggleRow("guide-auto", "Refresh guide automatically", prefs.epgAutoRefresh, (on) =>
				setPrefs({ epgAutoRefresh: on })
			),
			...(prefs.epgAutoRefresh
				? [
						choiceRow(
							"guide-every",
							"Refresh guide every",
							asChoices(EPG_INTERVAL_OPTIONS),
							prefs.epgRefreshIntervalHours,
							(hours) => setPrefs({ epgRefreshIntervalHours: hours })
						),
					]
				: []),
			{
				id: "remove",
				label: "Remove provider",
				icon: <Trash2 aria-hidden />,
				danger: true,
				confirm: {
					title: "Remove provider?",
					message: `Remove "${p.name}"? Its channels and favorites are removed too.`,
					label: "Remove",
					onConfirm: () => void removeProvider(p.id),
				},
			},
		];
		const failed = tasks.failed(key("refresh"));
		return {
			id: p.id,
			label: p.name,
			icon: <ProviderTile name={p.name} index={index} />,
			detail: formatCount(p.channelCount, "channel"),
			status: failed ? "failed" : "ok",
			summary: <ProviderSummary provider={p} index={index} failed={failed} />,
			settings: rows,
		};
	};

	const isXtream = form.type === "xtream";
	const add = () => {
		const { name, url, username, password } = form;
		tasks.run("add", async () => {
			if (!url) return "Enter the URL first.";
			await (isXtream
				? loadXtream(name || XTREAM_DEFAULT_NAME, url, username, password)
				: loadM3u(name || M3U_DEFAULT_NAME, url));
			setForm(NO_FORM);
		});
	};

	const adding: TvSettingsSection = {
		id: "add",
		label: "Add a provider",
		icon: (
			<span
				aria-hidden
				className="flex size-[1.9rem] items-center justify-center rounded-[0.5rem] border-[1.5px] border-dashed border-current/45"
			>
				<Plus className="size-[1rem]" />
			</span>
		),
		aside: <p>{DISCLAIMER_TEXT}</p>,
		settings: [
			{
				id: "send",
				label: "From another device",
				hint: "Open Cinette on your phone or computer, connect to this TV, and choose Send providers. Each one comes with its login, so there's nothing to type.",
			},
			choiceRow("type", "Type", TYPES, form.type, (type) => setForm({ ...form, type })),
			textRow("name", "Name", form.name, (name) => setForm({ ...form, name: name.trim() })),
			textRow("url", isXtream ? "Server URL" : "Playlist URL", form.url, (url) =>
				setForm({ ...form, url: url.trim() })
			),
			...(isXtream
				? [
						textRow("username", "Username", form.username, (username) =>
							setForm({ ...form, username })
						),
						textRow(
							"password",
							"Password",
							form.password,
							(password) => setForm({ ...form, password }),
							form.password ? "Set" : "Not set"
						),
					]
				: []),
			{
				id: "add",
				label: "Add provider",
				busy: tasks.busy("add"),
				hint: tasks.message("add"),
				onSelect: add,
			},
		],
	};

	return [...providers.map((p, i) => section(p, i)), adding];
};
