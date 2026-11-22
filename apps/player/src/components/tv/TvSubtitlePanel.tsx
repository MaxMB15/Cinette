// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, type KeyboardEvent } from "react";
import { Check, ChevronLeft, ChevronRight, LoaderCircle, SlidersHorizontal } from "lucide-react";
import { useSubtitleSearch, type SubtitleSearchOptions } from "@/hooks/useSubtitleSearch";
import { nudgeSubtitle, type SubtitlePosition } from "@/lib/subtitle-position";
import {
	addSubtitleDelay,
	FONT_FAMILIES,
	formatSubtitleDelay,
	languageName,
	stepSubtitleSize,
} from "@/lib/subtitle-style";
import { moveFocus } from "@/lib/tv-focus";
import type { SubtitleEntry } from "@/lib/types";
import { TvList } from "./TvList";
import { PANEL_LIST_HEIGHT, TvPanel } from "./TvPanel";
import { TvTextRow } from "./ui";

const OFF = "off";
const STYLE = "style";
const CHOICE_ROW_HEIGHT = 2.75;
const RELEASE_ROW_HEIGHT = 3.5;
const STYLE_ROW_HEIGHT = 3;
const DELAY_STEP = 0.1;

export interface TvSubtitleStyle {
	fontSize: number;
	fontFamily: string;
	delay: number;
	position: SubtitlePosition;
	onFontSizeChange: (size: number) => void;
	onFontFamilyChange: (family: string) => void;
	onDelayChange: (delay: number) => void;
	onPositionChange: (position: SubtitlePosition) => void;
}

type TvSubtitlePanelProps = SubtitleSearchOptions & {
	currentSelectedEntry: SubtitleEntry | null;
	style: TvSubtitleStyle;
};

/** The font after `family` in the list, going round at its ends. */
const stepFont = (family: string, direction: 1 | -1): string => {
	const at = Math.max(
		0,
		FONT_FAMILIES.findIndex((f) => f.value === family)
	);
	const count = FONT_FAMILIES.length;
	return FONT_FAMILIES[(at + direction + count) % count].value;
};

/**
 * The row that opens the text settings. Its icon, its arrow and the line under
 * it set it apart from the languages below.
 */
const TvStyleRow = ({ label }: { label: string }) => (
	<div className="relative flex h-full items-center gap-[0.5rem] rounded-[0.5rem] px-[0.75rem] text-base font-medium after:absolute after:inset-x-[0.75rem] after:bottom-0 after:h-px after:bg-white/20">
		<SlidersHorizontal aria-hidden className="size-[1.25rem] shrink-0 text-primary" />
		<span className="min-w-0 flex-1 truncate">{label}</span>
		<ChevronRight aria-hidden className="size-[1.25rem] shrink-0" />
	</div>
);

/**
 * One row for each thing to set. Left and Right change the row's value, so the
 * text changes on the video beside the panel, and Back returns to the list.
 */
const TvSubtitleStylePanel = ({
	style,
	onClose,
}: {
	style: TvSubtitleStyle;
	onClose: () => void;
}) => {
	const [active, setActive] = useState(0);
	const font = FONT_FAMILIES.find((f) => f.value === style.fontFamily) ?? FONT_FAMILIES[0];
	const rows = [
		{
			label: "Size",
			value: String(style.fontSize),
			step: (d: 1 | -1) => style.onFontSizeChange(stepSubtitleSize(style.fontSize, d)),
		},
		{
			label: "Font",
			value: font.label,
			step: (d: 1 | -1) => style.onFontFamilyChange(stepFont(style.fontFamily, d)),
		},
		{
			label: "Delay",
			value: formatSubtitleDelay(style.delay),
			step: (d: 1 | -1) => style.onDelayChange(addSubtitleDelay(style.delay, d * DELAY_STEP)),
		},
		{
			label: "Height",
			value: `${100 - style.position.y}%`,
			step: (d: 1 | -1) =>
				style.onPositionChange(
					nudgeSubtitle(style.position, d === 1 ? "ArrowUp" : "ArrowDown")
				),
		},
	];

	const onKeyDown = (e: KeyboardEvent) => {
		if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
		e.preventDefault();
		rows[active].step(e.key === "ArrowRight" ? 1 : -1);
	};

	return (
		<TvPanel title="Text and timing" onClose={onClose} className="w-[20rem]">
			<div onKeyDown={onKeyDown}>
				<TvList
					items={rows}
					label="Text and timing"
					itemKey={(row) => row.label}
					active={active}
					onActiveChange={setActive}
					rowHeight={STYLE_ROW_HEIGHT}
					height={STYLE_ROW_HEIGHT * rows.length}
					start
					itemClassName="rounded-[0.5rem]"
					renderItem={(row) => (
						<div className="flex h-full items-center gap-[0.25rem] rounded-[0.5rem] px-[0.75rem] text-base font-medium">
							<span className="flex-1">{row.label}</span>
							<ChevronLeft aria-hidden className="size-[1rem] shrink-0" />
							<span className="w-[6.5rem] text-center tabular-nums">{row.value}</span>
							<ChevronRight aria-hidden className="size-[1rem] shrink-0" />
						</div>
					)}
				/>
			</div>
			<p className="mt-[1rem] px-[0.5rem] text-[0.8rem] leading-[1.1rem] opacity-70">
				Left or Right changes a value. Back returns to the subtitles.
			</p>
		</TvPanel>
	);
};

/**
 * The subtitles for what's playing, in two columns. The cursor on a language
 * shows its releases, and Right or OK goes to them.
 */
export const TvSubtitlePanel = ({
	currentSelectedEntry,
	style,
	onClose,
	...search
}: TvSubtitlePanelProps) => {
	const { loading, grouped, selectedFileId, downloadingId, error, handleSelect, handleNone } =
		useSubtitleSearch({ ...search, onClose });
	const [activeKey, setActiveKey] = useState<string | null>(null);
	const [activeRelease, setActiveRelease] = useState(0);
	const [styling, setStyling] = useState(false);

	const choices = [
		{ key: OFF, label: "Off" },
		{ key: STYLE, label: "Text and timing" },
		...grouped.map(({ lang, entries }) => ({
			key: lang,
			label: languageName(lang),
			count: entries.length,
		})),
	];
	// The list opens on the language in use, once the search has found it.
	const currentLanguage =
		selectedFileId !== null ? currentSelectedEntry?.languageCode : undefined;
	const choiceKey = activeKey ?? currentLanguage ?? OFF;
	const choiceIndex = Math.max(
		0,
		choices.findIndex((c) => c.key === choiceKey)
	);
	const entries = grouped.find((g) => g.lang === choices[choiceIndex].key)?.entries ?? [];

	const openChoice = (key: string) => {
		if (key === OFF) {
			handleNone();
			onClose();
		} else if (key === STYLE) setStyling(true);
		else moveFocus("right");
	};

	if (styling) return <TvSubtitleStylePanel style={style} onClose={() => setStyling(false)} />;

	return (
		<TvPanel title="Subtitles" onClose={onClose} className="w-[36rem]">
			<div className="flex gap-[0.75rem]">
				<TvList
					className="w-[13rem] shrink-0"
					items={choices}
					label="Languages"
					itemKey={(c) => c.key}
					active={choiceIndex}
					onActiveChange={(i) => {
						setActiveKey(choices[i].key);
						setActiveRelease(0);
					}}
					onSelect={(c) => openChoice(c.key)}
					rowHeight={CHOICE_ROW_HEIGHT}
					height={PANEL_LIST_HEIGHT}
					start
					itemClassName="rounded-[0.5rem]"
					renderItem={(c) =>
						c.key === STYLE ? (
							<TvStyleRow label={c.label} />
						) : (
							<TvTextRow
								label={c.label}
								end={
									"count" in c ? (
										c.count
									) : c.key === OFF && selectedFileId === null ? (
										<Check aria-label="In use" className="size-[1.25rem]" />
									) : undefined
								}
							/>
						)
					}
				/>
				<div className="min-w-0 flex-1">
					{entries.length > 0 ? (
						<TvList
							items={entries}
							label="Releases"
							itemKey={(entry) => String(entry.fileId)}
							active={activeRelease}
							onActiveChange={setActiveRelease}
							onSelect={(entry) => void handleSelect(entry)}
							rowHeight={RELEASE_ROW_HEIGHT}
							height={RELEASE_ROW_HEIGHT * 8}
							itemClassName="rounded-[0.5rem]"
							renderItem={(entry) => (
								<div className="flex h-full items-center gap-[0.5rem] rounded-[0.5rem] px-[0.75rem]">
									<p className="line-clamp-2 min-w-0 flex-1 text-[0.875rem] leading-[1.25rem] font-medium break-all">
										{entry.releaseName ?? `Subtitle ${entry.fileId}`}
									</p>
									{downloadingId === entry.fileId ? (
										<LoaderCircle
											aria-label="Loading"
											className="size-[1.25rem] shrink-0 animate-spin"
										/>
									) : (
										selectedFileId === entry.fileId && (
											<Check
												aria-label="In use"
												className="size-[1.25rem] shrink-0"
											/>
										)
									)}
								</div>
							)}
						/>
					) : (
						<p className="px-[0.5rem] pt-[0.5rem] text-base opacity-70">
							{loading
								? "Searching for subtitles"
								: grouped.length === 0
									? "No subtitles found"
									: null}
						</p>
					)}
					{error && (
						<p className="px-[0.5rem] pt-[0.5rem] text-[0.875rem] leading-[1.25rem] font-medium">
							{error}
						</p>
					)}
				</div>
			</div>
		</TvPanel>
	);
};
