// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useEffect, useCallback } from "react";
import {
	RefreshCw,
	Plus,
	Pencil,
	Trash2,
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
	getGroupHierarchy,
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
import type { GroupHierarchyEntry } from "@/lib/types";
import type { Channel } from "@/lib/types";

interface CategoryManagerProps {
	providerId: string;
	contentType: string;
	channels: Channel[];
	onClose: () => void;
	onHierarchyChanged: () => void;
}

export const CategoryManager = ({
	providerId,
	contentType,
	channels,
	onClose,
	onHierarchyChanged,
}: CategoryManagerProps) => {
	const [entries, setEntries] = useState<GroupHierarchyEntry[]>([]);
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

	const load = useCallback(async () => {
		try {
			const h = await getGroupHierarchy(providerId, contentType);
			if (h.length > 0) {
				setEntries(h);
				// Remove empty categories that now have groups in DB
				const dbCatNames = new Set(
					h.filter((e) => e.superCategory).map((e) => e.superCategory!)
				);
				setEmptyCategories((prev) => prev.filter((c) => !dbCatNames.has(c)));
			} else {
				// No hierarchy yet — show all provider groups as uncategorized
				const groupNames = [
					...new Set(
						channels
							.filter((c) => c.contentType === contentType)
							.map((c) => c.groupTitle)
					),
				];
				setEntries(
					groupNames.map((g, i) => ({
						providerId,
						contentType,
						groupName: g,
						superCategory: null,
						sortOrder: i,
						isUserOverride: false,
					}))
				);
			}
		} catch {
			// silent
		}
	}, [providerId, contentType, channels]);

	useEffect(() => {
		load();
	}, [load]);

	const dbCats = [
		...new Set(entries.filter((e) => e.superCategory).map((e) => e.superCategory!)),
	];
	const superCats = [...dbCats, ...emptyCategories.filter((c) => !dbCats.includes(c))];
	const uncategorized = entries.filter((e) => !e.superCategory);

	const handleRecategorize = async () => {
		setCategorizing(true);
		setError(null);
		try {
			const apiKey = await getGeminiApiKey();
			if (!apiKey) {
				setError("No Gemini API key configured. Add one in Settings → AI.");
				return;
			}
			const groupNames = [
				...new Set(
					channels.filter((c) => c.contentType === contentType).map((c) => c.groupTitle)
				),
			];
			const groupsWithSamples: [string, string[]][] = groupNames.map((g) => [
				g,
				channels
					.filter((c) => c.groupTitle === g && c.contentType === contentType)
					.slice(0, 5)
					.map((c) => c.name),
			]);
			const result = await categorizeProvider(
				providerId,
				contentType,
				apiKey,
				groupsWithSamples
			);
			setEntries(result);
			onHierarchyChanged();
		} catch (e) {
			setError(String(e));
		} finally {
			setCategorizing(false);
		}
	};

	const handleFixUncategorized = async () => {
		if (uncategorized.length === 0 || superCats.length === 0) return;
		setFixingUncategorized(true);
		setError(null);
		try {
			const apiKey = await getGeminiApiKey();
			if (!apiKey) {
				setError("No Gemini API key configured. Add one in Settings → AI.");
				return;
			}
			const uncatGroups: [string, string[]][] = uncategorized.map((e) => [
				e.groupName,
				channels
					.filter((c) => c.groupTitle === e.groupName && c.contentType === contentType)
					.slice(0, 5)
					.map((c) => c.name),
			]);
			const result = await fixUncategorizedGroups(
				providerId,
				contentType,
				apiKey,
				uncatGroups,
				superCats
			);
			setEntries(result);
			onHierarchyChanged();
		} catch (e) {
			setError(String(e));
		} finally {
			setFixingUncategorized(false);
		}
	};

	const handleAiPromptSubmit = async () => {
		if (!aiPromptCategory) return;
		setAiPromptLoading(true);
		setError(null);
		try {
			const apiKey = await getGeminiApiKey();
			if (!apiKey) {
				setError("No Gemini API key configured. Add one in Settings → AI.");
				return;
			}
			// Send ALL groups not already in the target category
			const candidateGroups: [string, string[]][] = entries
				.filter((e) => e.superCategory !== aiPromptCategory)
				.map(
					(e) =>
						[
							e.groupName,
							channels
								.filter(
									(c) =>
										c.groupTitle === e.groupName &&
										c.contentType === contentType
								)
								.slice(0, 3)
								.map((c) => c.name),
						] as [string, string[]]
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
			setEntries(result);
			onHierarchyChanged();
			setAiPromptCategory(null);
		} catch (e) {
			setError(String(e));
		} finally {
			setAiPromptLoading(false);
		}
	};

	const handleMoveGroup = async (groupName: string, targetCategory: string | null) => {
		try {
			const siblingSortOrders = entries
				.filter((e) => e.superCategory === targetCategory && e.groupName !== groupName)
				.map((e) => e.sortOrder);
			const newSortOrder =
				siblingSortOrders.length > 0 ? Math.max(...siblingSortOrders) + 1 : 0;
			await updateGroupHierarchyEntry(
				providerId,
				contentType,
				groupName,
				targetCategory,
				newSortOrder
			);
			await load();
			onHierarchyChanged();
			setMovingGroup(null);
		} catch (e) {
			setError(String(e));
		}
	};

	const handleRenameCategory = async (oldName: string) => {
		if (!renameValue.trim() || renameValue === oldName) {
			setRenamingCategory(null);
			return;
		}
		try {
			await renameSuperCategory(providerId, contentType, oldName, renameValue.trim());
			await load();
			onHierarchyChanged();
			setRenamingCategory(null);
		} catch (e) {
			setError(String(e));
		}
	};

	const handleDeleteCategory = async (catName: string) => {
		const confirmed = await ask(`Delete "${catName}"? Groups will become uncategorized.`, {
			title: "Delete Category",
			kind: "warning",
		});
		if (!confirmed) return;
		try {
			await deleteSuperCategory(providerId, contentType, catName);
			await load();
			onHierarchyChanged();
		} catch (e) {
			setError(String(e));
		}
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

		// Reassign sort_order for ALL groups: category at position i gets block i*1000
		try {
			for (let catIdx = 0; catIdx < newOrder.length; catIdx++) {
				const groups = entries.filter((e) => e.superCategory === newOrder[catIdx]);
				for (let gi = 0; gi < groups.length; gi++) {
					await reorderGroupHierarchyEntry(
						providerId,
						contentType,
						groups[gi].groupName,
						catIdx * 1000 + gi
					);
				}
			}
			// Uncategorized groups go at the end
			const uncatEntries = entries.filter((e) => !e.superCategory);
			for (let i = 0; i < uncatEntries.length; i++) {
				await reorderGroupHierarchyEntry(
					providerId,
					contentType,
					uncatEntries[i].groupName,
					newOrder.length * 1000 + i
				);
			}
			await load();
			onHierarchyChanged();
		} catch (e) {
			setError(String(e));
		}
	};

	const handleReset = async () => {
		const confirmed = await ask(
			"Reset all categories? This removes all category assignments and returns to the original provider groups.",
			{ title: "Reset Categories", kind: "warning" }
		);
		if (!confirmed) return;
		try {
			await deleteGroupHierarchy(providerId, contentType);
			setEmptyCategories([]);
			await load();
			onHierarchyChanged();
		} catch (e) {
			setError(String(e));
		}
	};

	return (
		<div className="flex flex-col h-full">
			{/* Header */}
			<div className="flex items-center justify-between p-4 border-b border-border">
				<div>
					<h2 className="text-base font-semibold">Manage Categories</h2>
					<p className="text-xs text-muted-foreground mt-0.5">
						{contentType} &middot; {entries.length} groups &middot; {superCats.length}{" "}
						categories
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
						{categorizing ? "Categorizing..." : "Re-categorize All"}
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
					placeholder="New category name..."
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
						<div key={catName} className="rounded-xl border border-border bg-card">
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
											aria-label="Save name"
										>
											<Check className="h-3.5 w-3.5" />
										</button>
										<button
											onClick={() => setRenamingCategory(null)}
											className="text-muted-foreground hover:text-foreground p-1"
											aria-label="Cancel rename"
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
											{groups.length} groups
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
											aria-label="Move category up"
										>
											<ChevronUp className="h-3.5 w-3.5" />
										</button>
										<button
											onClick={() => handleReorderCategory(catName, "down")}
											disabled={catIdx === superCats.length - 1}
											className="p-1 text-muted-foreground hover:text-foreground disabled:opacity-20 rounded hover:bg-accent"
											aria-label="Move category down"
										>
											<ChevronDown className="h-3.5 w-3.5" />
										</button>
										<button
											onClick={() => handleDeleteCategory(catName)}
											className="p-1 text-muted-foreground hover:text-destructive rounded hover:bg-destructive/10"
											title="Delete category"
										>
											<Trash2 className="h-3 w-3" />
										</button>
									</>
								)}
							</div>
							{/* Groups */}
							<div className="p-2.5 flex flex-wrap gap-1.5">
								{groups.map((g) => (
									<button
										key={g.groupName}
										onClick={() =>
											setMovingGroup(
												movingGroup === g.groupName ? null : g.groupName
											)
										}
										className={`px-2.5 py-1 rounded-md text-xs transition-all ${
											movingGroup === g.groupName
												? "bg-primary text-primary-foreground ring-2 ring-primary/50"
												: "bg-secondary hover:bg-accent"
										}`}
									>
										{g.groupName}
										{g.isUserOverride && (
											<span className="ml-1 text-[9px] bg-primary/20 text-primary px-1 rounded">
												user
											</span>
										)}
									</button>
								))}
							</div>
						</div>
					);
				})}

				{/* Uncategorized */}
				{uncategorized.length > 0 && (
					<div className="rounded-xl border-2 border-dashed border-border bg-card/50">
						<div className="flex items-center gap-2 px-3 py-2.5 border-b border-border/50">
							<span className="text-sm font-semibold text-muted-foreground flex-1">
								Uncategorized
							</span>
							<span className="text-[10px] text-muted-foreground tabular-nums">
								{uncategorized.length} groups
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
									{fixingUncategorized ? "Assigning..." : "Assign All with AI"}
								</Button>
							)}
						</div>
						<div className="p-2.5 flex flex-wrap gap-1.5">
							{uncategorized.map((g) => (
								<button
									key={g.groupName}
									onClick={() =>
										setMovingGroup(
											movingGroup === g.groupName ? null : g.groupName
										)
									}
									className={`px-2.5 py-1 rounded-md text-xs transition-all ${
										movingGroup === g.groupName
											? "bg-primary text-primary-foreground ring-2 ring-primary/50"
											: "bg-secondary/70 hover:bg-accent"
									}`}
								>
									{g.groupName}
								</button>
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
							aria-label="Cancel move"
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
							aria-label="Close AI prompt"
						>
							<X className="h-4 w-4" />
						</button>
					</div>
					<p className="text-xs text-muted-foreground mb-2">
						AI will look at all other groups and move ones that belong in this category.
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
									<RefreshCw className="h-3 w-3 mr-1 animate-spin" /> Working...
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
			<div className="px-4 py-2.5 border-t border-border text-[10px] text-muted-foreground">
				Click a group to move it &middot;{" "}
				<span className="bg-primary/20 text-primary px-1 rounded text-[9px]">user</span> =
				manually placed (preserved on re-categorize)
			</div>
		</div>
	);
};
