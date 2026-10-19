// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	RefreshCw,
	Plus,
	Pencil,
	Trash,
	Sparkles,
	Check,
	X,
	ChevronUp,
	ChevronDown,
	ArrowRight,
	RotateCcw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	deleteGroupHierarchy,
	categorizeProvider,
	fixUncategorizedGroups,
	getGeminiApiKey,
	updateGroupHierarchyEntry,
	reorderGroupHierarchyEntry,
	renameSuperCategory,
	deleteSuperCategory,
} from "@/lib/tauri";
import { ask } from "@tauri-apps/plugin-dialog";
import { groupSamples, groupTitles, superCategoryNames } from "@/lib/group-hierarchy";
import type { Channel, GroupHierarchyEntry } from "@/lib/types";
import { formatCount } from "@/lib/format";
import { groupHierarchyQuery } from "@/lib/queries";
import { cn } from "@/lib/utils";

/** The hierarchy while it loads, kept the same between renders. */
const NO_ENTRIES: GroupHierarchyEntry[] = [];

// Enough channel names for Gemini to tell what a group holds.
const SAMPLES_PER_GROUP = 5;
// Adding to one category sends every other group, so fewer names each keeps the request small.
const SAMPLES_PER_CANDIDATE = 3;
// Each category owns a block of sort orders, so its groups stay together in their own order.
const CATEGORY_SORT_BLOCK = 1000;
// What to call the names Gemini gets from each group, by content type.
const SAMPLE_NAMES: Record<string, string> = {
	live: "channel names",
	movie: "movie titles",
	series: "series titles",
};

interface GroupChipProps {
	name: string;
	selected: boolean;
	/** Groups placed by hand keep their place when Gemini sorts again, so they get a badge. */
	userPlaced?: boolean;
	/** Uncategorized groups are drawn a little fainter. */
	muted?: boolean;
	onToggle: () => void;
}

const GroupChip = ({
	name,
	selected,
	userPlaced = false,
	muted = false,
	onToggle,
}: GroupChipProps) => (
	<button
		onClick={onToggle}
		aria-pressed={selected}
		className={cn(
			"px-2.5 py-1 rounded-md text-xs transition-all",
			selected
				? "bg-primary text-primary-foreground ring-2 ring-primary/50"
				: muted
					? "bg-secondary/70 hover:bg-accent"
					: "bg-secondary hover:bg-accent"
		)}
	>
		{name}
		{userPlaced && (
			<span className="ml-1 text-[9px] bg-primary/20 text-primary px-1 rounded">user</span>
		)}
	</button>
);

interface CategoryManagerProps {
	providerId: string;
	contentType: string;
	channels: Channel[];
	onClose: () => void;
}

export const CategoryManager = ({
	providerId,
	contentType,
	channels,
	onClose,
}: CategoryManagerProps) => {
	// The channel list reads the same cached hierarchy, so it shows each change
	// without being told.
	const queryClient = useQueryClient();
	const hierarchyQuery = groupHierarchyQuery(providerId, contentType);
	const saved = useQuery(hierarchyQuery);
	const [categorizing, setCategorizing] = useState(false);
	const [fixingUncategorized, setFixingUncategorized] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Editing state
	const [renamingCategory, setRenamingCategory] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [newCategoryName, setNewCategoryName] = useState("");
	const [movingGroup, setMovingGroup] = useState<string | null>(null);

	// Empty categories created by user (not yet in DB)
	const [emptyCategories, setEmptyCategories] = useState<string[]>([]);

	// AI prompt dialog
	const [aiPromptCategory, setAiPromptCategory] = useState<string | null>(null);
	const [aiPromptLoading, setAiPromptLoading] = useState(false);

	// No hierarchy yet, so show all provider groups as uncategorized.
	const unsorted = useMemo(
		() =>
			groupTitles(channels, contentType).map((g, i): GroupHierarchyEntry => ({
				providerId,
				contentType,
				groupName: g,
				superCategory: null,
				sortOrder: i,
				// Stryker disable next-line BooleanLiteral: only categorized groups show the badge, and these are all uncategorized.
				isUserOverride: false,
			})),
		[channels, contentType, providerId]
	);
	// Empty while it loads, and when it can't be read. A reload that fails
	// keeps the last list it read.
	const entries =
		saved.data === undefined ? NO_ENTRIES : saved.data.length > 0 ? saved.data : unsorted;

	// Remove empty categories that now have groups in DB. It's cheap, and
	// does nothing once they're gone, so it runs on every render.
	if (saved.data) {
		const dbCatNames = new Set(superCategoryNames(saved.data));
		const stillEmpty = emptyCategories.filter((c) => !dbCatNames.has(c));
		if (stillEmpty.length !== emptyCategories.length) setEmptyCategories(stillEmpty);
	}

	/** Loads the stored hierarchy again, for every screen that shows it. */
	const reload = () => queryClient.invalidateQueries({ queryKey: hierarchyQuery.queryKey });

	/** Shows a hierarchy Gemini returned, which the backend has already stored. */
	const show = (result: GroupHierarchyEntry[]) =>
		queryClient.setQueryData(hierarchyQuery.queryKey, result);

	const dbCats = superCategoryNames(entries);
	const superCats = [...dbCats, ...emptyCategories.filter((c) => !dbCats.includes(c))];
	const uncategorized = entries.filter((e) => !e.superCategory);

	/** Shows the error and gives null when no key is set, so the caller can stop. */
	const requireGeminiKey = async (): Promise<string | null> => {
		const apiKey = await getGeminiApiKey();
		if (!apiKey) setError("No Gemini API key configured. Add one in Settings → AI.");
		return apiKey || null;
	};

	/**
	 * Saves one change, then reloads so the list shows what was stored.
	 * Gives false when it failed, after showing the error.
	 */
	const applyChange = async (change: () => Promise<unknown>): Promise<boolean> => {
		try {
			await change();
			await reload();
			return true;
		} catch (e) {
			setError(String(e));
			return false;
		}
	};

	const toggleMoving = (groupName: string) =>
		setMovingGroup(movingGroup === groupName ? null : groupName);

	/**
	 * Runs a Gemini action with its spinner on, and shows what went wrong.
	 * Promise callbacks stand in for try and finally, which the React Compiler
	 * can't compile yet.
	 */
	const runBusy = (setBusy: (busy: boolean) => void, action: () => Promise<void>) => {
		setBusy(true);
		setError(null);
		return action()
			.catch((e) => setError(String(e)))
			.finally(() => setBusy(false));
	};

	const handleRecategorize = async () => {
		await runBusy(setCategorizing, async () => {
			const apiKey = await requireGeminiKey();
			if (!apiKey) return;
			const groupsWithSamples = groupSamples(
				channels,
				groupTitles(channels, contentType),
				contentType,
				SAMPLES_PER_GROUP
			);
			const result = await categorizeProvider(
				providerId,
				contentType,
				apiKey,
				groupsWithSamples
			);
			show(result);
		});
	};

	const handleFixUncategorized = async () => {
		if (uncategorized.length === 0 || superCats.length === 0) return;
		await runBusy(setFixingUncategorized, async () => {
			const apiKey = await requireGeminiKey();
			if (!apiKey) return;
			const uncatGroups = groupSamples(
				channels,
				uncategorized.map((e) => e.groupName),
				contentType,
				SAMPLES_PER_GROUP
			);
			const result = await fixUncategorizedGroups(
				providerId,
				contentType,
				apiKey,
				uncatGroups,
				superCats
			);
			show(result);
		});
	};

	const handleAiPromptSubmit = async () => {
		if (!aiPromptCategory) return;
		await runBusy(setAiPromptLoading, async () => {
			const apiKey = await requireGeminiKey();
			if (!apiKey) return;
			// Send ALL groups not already in the target category
			const candidateGroups = groupSamples(
				channels,
				entries.filter((e) => e.superCategory !== aiPromptCategory).map((e) => e.groupName),
				contentType,
				SAMPLES_PER_CANDIDATE
			);

			if (candidateGroups.length === 0) {
				setError("No other groups available to assign.");
				setAiPromptCategory(null);
				return;
			}

			const result = await fixUncategorizedGroups(
				providerId,
				contentType,
				apiKey,
				candidateGroups,
				[aiPromptCategory]
			);
			show(result);
			setAiPromptCategory(null);
		});
	};

	const handleMoveGroup = async (groupName: string, targetCategory: string | null) => {
		const siblingSortOrders = entries
			.filter((e) => e.superCategory === targetCategory && e.groupName !== groupName)
			.map((e) => e.sortOrder);
		const newSortOrder = siblingSortOrders.length > 0 ? Math.max(...siblingSortOrders) + 1 : 0;
		const moved = await applyChange(() =>
			updateGroupHierarchyEntry(
				providerId,
				contentType,
				groupName,
				targetCategory,
				newSortOrder
			)
		);
		if (moved) setMovingGroup(null);
	};

	const handleRenameCategory = async (oldName: string) => {
		if (!renameValue.trim() || renameValue === oldName) {
			setRenamingCategory(null);
			return;
		}
		const renamed = await applyChange(() =>
			renameSuperCategory(providerId, contentType, oldName, renameValue.trim())
		);
		if (renamed) setRenamingCategory(null);
	};

	const handleDeleteCategory = async (catName: string) => {
		const confirmed = await ask(`Delete "${catName}"? Groups will become uncategorized.`, {
			title: "Delete Category",
			kind: "warning",
		});
		if (!confirmed) return;
		await applyChange(() => deleteSuperCategory(providerId, contentType, catName));
	};

	const handleCreateCategory = () => {
		const name = newCategoryName.trim();
		if (!name) return;
		if (superCats.includes(name)) return;
		setEmptyCategories((prev) => [...prev, name]);
		setNewCategoryName("");
	};

	const handleReorderCategory = async (catName: string, direction: "up" | "down") => {
		const idx = superCats.indexOf(catName);
		const swapIdx = direction === "up" ? idx - 1 : idx + 1;
		if (swapIdx < 0 || swapIdx >= superCats.length) return;

		// Build new category order by swapping the two
		const newOrder = [...superCats];
		[newOrder[idx], newOrder[swapIdx]] = [newOrder[swapIdx], newOrder[idx]];

		// Reassign sort_order for ALL groups, so the category at position i gets block i
		await applyChange(async () => {
			// Loops over entries(), since the React Compiler can't compile a
			// counter's ++ inside a function.
			for (const [catIdx, cat] of newOrder.entries()) {
				const groups = entries.filter((e) => e.superCategory === cat);
				for (const [gi, group] of groups.entries()) {
					await reorderGroupHierarchyEntry(
						providerId,
						contentType,
						group.groupName,
						catIdx * CATEGORY_SORT_BLOCK + gi
					);
				}
			}
			// Uncategorized groups go at the end
			const uncatEntries = entries.filter((e) => !e.superCategory);
			for (const [i, entry] of uncatEntries.entries()) {
				await reorderGroupHierarchyEntry(
					providerId,
					contentType,
					entry.groupName,
					newOrder.length * CATEGORY_SORT_BLOCK + i
				);
			}
		});
	};

	const handleReset = async () => {
		const confirmed = await ask(
			"Reset all categories? This removes all category assignments and returns to the original provider groups.",
			{ title: "Reset Categories", kind: "warning" }
		);
		if (!confirmed) return;
		await applyChange(async () => {
			await deleteGroupHierarchy(providerId, contentType);
			setEmptyCategories([]);
		});
	};

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center justify-between p-4 border-b border-border">
				<div>
					<h2 className="text-base font-semibold">Manage Categories</h2>
					<p className="text-xs text-muted-foreground mt-0.5">
						{contentType} &middot; {formatCount(entries.length, "group")} &middot;{" "}
						{formatCount(superCats.length, "category", "categories")}
					</p>
				</div>
				<div className="flex gap-2">
					<Button
						size="sm"
						variant="ghost"
						onClick={handleReset}
						title="Reset to original provider groups"
					>
						<RotateCcw className="h-3.5 w-3.5 mr-1.5" />
						Reset
					</Button>
					<Button
						size="sm"
						variant="outline"
						onClick={handleRecategorize}
						disabled={categorizing}
					>
						<RefreshCw
							className={`h-3.5 w-3.5 mr-1.5 ${categorizing ? "animate-spin" : ""}`}
						/>
						{categorizing ? "Categorizing…" : "Re-categorize All"}
					</Button>
					<Button size="sm" variant="ghost" onClick={onClose}>
						Close
					</Button>
				</div>
			</div>

			{error && (
				<div className="mx-4 mt-3 p-2.5 rounded-lg bg-destructive/10 text-destructive text-xs">
					{error}
					<button onClick={() => setError(null)} className="ml-2 underline">
						dismiss
					</button>
				</div>
			)}

			{/* New category */}
			<div className="px-4 pt-3 pb-2 flex items-center gap-2 border-b border-border/50">
				<Plus className="h-4 w-4 text-muted-foreground shrink-0" />
				<Input
					placeholder="New category name…"
					value={newCategoryName}
					onChange={(e) => setNewCategoryName(e.target.value)}
					className="flex-1 h-8 text-xs"
					onKeyDown={(e) => e.key === "Enter" && handleCreateCategory()}
				/>
				<Button
					size="sm"
					variant="secondary"
					onClick={handleCreateCategory}
					disabled={!newCategoryName.trim() || superCats.includes(newCategoryName.trim())}
					className="h-8 text-xs"
				>
					Create
				</Button>
			</div>

			{/* Categories list */}
			<div className="flex-1 overflow-y-auto p-4 space-y-3">
				{superCats.map((catName, catIdx) => {
					const groups = entries.filter((e) => e.superCategory === catName);
					const isRenaming = renamingCategory === catName;
					return (
						<div
							key={catName}
							role="group"
							aria-label={catName}
							className="rounded-xl border border-border bg-card"
						>
							{/* Category header */}
							<div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/50">
								{isRenaming ? (
									<div className="flex items-center gap-1.5 flex-1">
										<Input
											value={renameValue}
											onChange={(e) => setRenameValue(e.target.value)}
											className="h-7 text-sm flex-1"
											autoFocus
											onKeyDown={(e) => {
												if (e.key === "Enter")
													handleRenameCategory(catName);
												if (e.key === "Escape") setRenamingCategory(null);
											}}
										/>
										<button
											onClick={() => handleRenameCategory(catName)}
											className="text-green-500 hover:text-green-400 p-1"
											title="Save name"
										>
											<Check className="h-3.5 w-3.5" />
										</button>
										<button
											onClick={() => setRenamingCategory(null)}
											className="text-muted-foreground hover:text-foreground p-1"
											title="Cancel rename"
										>
											<X className="h-3.5 w-3.5" />
										</button>
									</div>
								) : (
									<>
										<span className="text-sm font-semibold flex-1">
											{catName}
										</span>
										<span className="text-[10px] text-muted-foreground tabular-nums">
											{formatCount(groups.length, "group")}
										</span>
										<button
											onClick={() => {
												setRenamingCategory(catName);
												setRenameValue(catName);
											}}
											className="p-1 text-muted-foreground hover:text-foreground rounded hover:bg-accent"
											title="Rename"
										>
											<Pencil className="h-3 w-3" />
										</button>
										<button
											onClick={() => {
												setAiPromptCategory(catName);
											}}
											className="p-1 text-muted-foreground hover:text-primary rounded hover:bg-primary/10"
											title="AI: add groups to this category"
										>
											<Sparkles className="h-3 w-3" />
										</button>
										<button
											onClick={() => handleReorderCategory(catName, "up")}
											disabled={catIdx === 0}
											className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-20 rounded hover:bg-accent"
											title="Move up"
										>
											<ChevronUp className="h-3.5 w-3.5" />
										</button>
										<button
											onClick={() => handleReorderCategory(catName, "down")}
											disabled={catIdx === superCats.length - 1}
											className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-20 rounded hover:bg-accent"
											title="Move down"
										>
											<ChevronDown className="h-3.5 w-3.5" />
										</button>
										<button
											onClick={() => handleDeleteCategory(catName)}
											className="p-1 text-muted-foreground hover:text-destructive rounded hover:bg-destructive/10"
											title="Delete category"
										>
											<Trash className="h-3 w-3" />
										</button>
									</>
								)}
							</div>
							{/* Groups */}
							<div className="p-2.5 flex flex-wrap gap-1.5">
								{groups.map((g) => (
									<GroupChip
										key={g.groupName}
										name={g.groupName}
										selected={movingGroup === g.groupName}
										userPlaced={g.isUserOverride}
										onToggle={() => toggleMoving(g.groupName)}
									/>
								))}
							</div>
						</div>
					);
				})}

				{/* Uncategorized */}
				{uncategorized.length > 0 && (
					<div
						role="group"
						aria-label="Uncategorized"
						className="rounded-xl border-2 border-dashed border-border bg-card/50"
					>
						<div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/50">
							<span className="text-sm font-semibold text-muted-foreground flex-1">
								Uncategorized
							</span>
							<span className="text-[10px] text-muted-foreground tabular-nums">
								{formatCount(uncategorized.length, "group")}
							</span>
							{superCats.length > 0 && (
								<Button
									size="sm"
									variant="outline"
									onClick={handleFixUncategorized}
									disabled={fixingUncategorized}
									className="h-7 text-xs"
								>
									<Sparkles
										className={`h-3 w-3 mr-1 ${fixingUncategorized ? "animate-pulse" : ""}`}
									/>
									{fixingUncategorized ? "Assigning…" : "Assign All with AI"}
								</Button>
							)}
						</div>
						<div className="p-2.5 flex flex-wrap gap-1.5">
							{uncategorized.map((g) => (
								<GroupChip
									key={g.groupName}
									name={g.groupName}
									selected={movingGroup === g.groupName}
									muted
									onToggle={() => toggleMoving(g.groupName)}
								/>
							))}
						</div>
					</div>
				)}
			</div>

			{/* Move group bar — slides up when a group is selected */}
			{movingGroup && (
				<div className="border-t-2 border-primary/30 bg-primary/5 p-3 animate-in slide-in-from-bottom-2">
					<div className="flex items-center gap-2 mb-2">
						<ArrowRight className="h-4 w-4 text-primary shrink-0" />
						<span className="text-sm font-medium">
							Move <span className="text-primary">&quot;{movingGroup}&quot;</span> to:
						</span>
						<div className="flex-1" />
						<button
							onClick={() => setMovingGroup(null)}
							className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
							title="Cancel move"
						>
							<X className="h-4 w-4" />
						</button>
					</div>
					<div className="flex flex-wrap gap-1.5">
						{superCats
							.filter((cat) => {
								const g = entries.find((e) => e.groupName === movingGroup);
								return g?.superCategory !== cat;
							})
							.map((cat) => (
								<button
									key={cat}
									onClick={() => handleMoveGroup(movingGroup, cat)}
									className="px-3 py-1.5 rounded-lg text-xs font-medium bg-card border border-border hover:bg-primary hover:text-primary-foreground hover:border-primary transition-all"
								>
									{cat}
								</button>
							))}
						{entries.find((e) => e.groupName === movingGroup)?.superCategory && (
							<button
								onClick={() => handleMoveGroup(movingGroup, null)}
								className="px-3 py-1.5 rounded-lg text-xs font-medium bg-card border-2 border-dashed border-border hover:bg-muted transition-all text-muted-foreground"
							>
								Uncategorized
							</button>
						)}
					</div>
				</div>
			)}

			{/* AI prompt dialog */}
			{aiPromptCategory && (
				<div className="border-t-2 border-primary/30 bg-primary/5 p-3">
					<div className="flex items-center gap-2 mb-2">
						<Sparkles className="h-4 w-4 text-primary shrink-0" />
						<span className="text-sm font-medium">
							AI: Add groups to{" "}
							<span className="text-primary">&quot;{aiPromptCategory}&quot;</span>
						</span>
						<div className="flex-1" />
						<button
							onClick={() => setAiPromptCategory(null)}
							className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
							title="Close AI panel"
						>
							<X className="h-4 w-4" />
						</button>
					</div>
					<p className="text-xs text-muted-foreground mb-2">
						Google Gemini looks at the other groups and moves the ones that belong in
						this category.
					</p>
					<div className="flex gap-2">
						<Button
							size="sm"
							onClick={handleAiPromptSubmit}
							disabled={aiPromptLoading}
							className="text-xs"
						>
							{aiPromptLoading ? (
								<>
									<RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Working…
								</>
							) : (
								<>
									<Sparkles className="h-3 w-3 mr-1" /> Find &amp; Add Groups
								</>
							)}
						</Button>
						<Button
							size="sm"
							variant="ghost"
							onClick={() => setAiPromptCategory(null)}
							className="text-xs"
						>
							Cancel
						</Button>
					</div>
				</div>
			)}

			{/* Footer */}
			<div className="px-4 py-2.5 border-t border-border text-[10px] text-muted-foreground space-y-0.5">
				<p>
					Click a group to move it &middot;{" "}
					<span className="bg-primary/20 text-primary px-1 rounded text-[9px]">user</span>{" "}
					= manually placed (preserved on re-categorize)
				</p>
				<p>
					AI actions send your group and category names, and a few{" "}
					{SAMPLE_NAMES[contentType] ?? "names"} from each group, to Google Gemini.
				</p>
			</div>
		</div>
	);
};
