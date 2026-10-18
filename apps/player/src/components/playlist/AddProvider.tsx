// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { LoaderCircle, Upload, FileText, Link, X } from "lucide-react";
import { usePlatform } from "@/hooks/usePlatform";
import {
	filenameFromPath,
	isPlaylistFile,
	nameFromFilename,
	PLAYLIST_EXTENSIONS,
} from "@/lib/file-url";
import { isMobilePlatform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ContentDisclaimer } from "./ContentDisclaimer";
import { XtreamFields } from "./XtreamFields";

type M3uMode = "url" | "file";

const M3U_MODES: SegmentedOption<M3uMode>[] = [
	{ value: "url", label: "URL", icon: <Link className="h-3.5 w-3.5" /> },
	{ value: "file", label: "File", icon: <FileText className="h-3.5 w-3.5" /> },
];

interface AddProviderProps {
	onAddM3u: (name: string, url: string) => Promise<void>;
	onAddM3uFile: (name: string, path: string) => Promise<void>;
	onAddXtream: (name: string, url: string, username: string, password: string) => Promise<void>;
}

export const AddProvider = ({ onAddM3u, onAddM3uFile, onAddXtream }: AddProviderProps) => {
	const { layoutMode } = usePlatform();
	const [tab, setTab] = useState<"m3u" | "xtream">("m3u");
	const [m3uMode, setM3uMode] = useState<M3uMode>("url");
	const [name, setName] = useState("");
	const [url, setUrl] = useState("");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [filePath, setFilePath] = useState<string | null>(null);
	const [fileName, setFileName] = useState<string | null>(null);
	const [isDragOver, setIsDragOver] = useState(false);

	// An iPad in landscape gets the desktop layout but can't drop files.
	const showDragDrop = layoutMode === "desktop" && !isMobilePlatform();
	const showFileBrowse = layoutMode !== "tv";

	// A picked or dropped file names the provider unless the user typed a name.
	const selectFile = useCallback(
		(path: string) => {
			const fname = filenameFromPath(path);
			setFilePath(path);
			setFileName(fname);
			setError(null);
			if (!name) {
				setName(nameFromFilename(fname));
			}
		},
		[name]
	);

	const acceptFileDrop = useCallback(
		(paths: string[]) => {
			const m3uPath = paths.find(isPlaylistFile);
			if (!m3uPath) {
				setError("Please drop an .m3u or .m3u8 file");
				return;
			}
			selectFile(m3uPath);
			setM3uMode("file");
			setTab("m3u");
		},
		[selectFile]
	);

	useEffect(() => {
		const appWindow = getCurrentWebviewWindow();
		const unlisten = appWindow.onDragDropEvent((event) => {
			if (event.payload.type === "enter" || event.payload.type === "over") {
				setIsDragOver(true);
			} else if (event.payload.type === "leave") {
				setIsDragOver(false);
			} else if (event.payload.type === "drop") {
				setIsDragOver(false);
				acceptFileDrop(event.payload.paths);
			}
		});

		return () => {
			unlisten.then((fn) => fn());
		};
	}, [acceptFileDrop]);

	const handleBrowse = useCallback(async () => {
		try {
			const selected = await open({
				multiple: false,
				filters: [
					{
						name: "M3U Playlist",
						extensions: PLAYLIST_EXTENSIONS,
					},
				],
			});
			if (selected) selectFile(selected);
		} catch (e) {
			setError(String(e));
		}
	}, [selectFile]);

	const clearFile = useCallback(() => {
		setFilePath(null);
		setFileName(null);
	}, []);

	const handleSubmit = (e: React.SubmitEvent): Promise<void> => {
		e.preventDefault();
		setLoading(true);
		setError(null);
		const add = async () => {
			if (tab === "m3u") {
				if (m3uMode === "file" && filePath) {
					await onAddM3uFile(name || fileName || "M3U File", filePath);
					clearFile();
				} else {
					await onAddM3u(name || "M3U Playlist", url);
				}
			} else {
				await onAddXtream(name || "Xtream Provider", url, username, password);
			}
			setName("");
			setUrl("");
			setUsername("");
			setPassword("");
		};
		// Promise callbacks in place of try and finally, which the React
		// Compiler can't compile yet.
		return add()
			.catch((err) => setError(String(err)))
			.finally(() => setLoading(false));
	};

	const canSubmit =
		!loading && (tab === "xtream" ? !!url : m3uMode === "file" ? !!filePath : !!url);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-lg">Add Provider</CardTitle>
				<div role="group" aria-label="Provider type" className="flex gap-2">
					<Button
						variant={tab === "m3u" ? "default" : "secondary"}
						size="sm"
						aria-pressed={tab === "m3u"}
						onClick={() => setTab("m3u")}
					>
						M3U Playlist
					</Button>
					<Button
						variant={tab === "xtream" ? "default" : "secondary"}
						size="sm"
						aria-pressed={tab === "xtream"}
						onClick={() => setTab("xtream")}
					>
						Xtream Codes
					</Button>
				</div>
			</CardHeader>
			<CardContent>
				<form onSubmit={handleSubmit} className="flex flex-col gap-3">
					<Field label="Provider name" hideLabel>
						{(id) => (
							<Input
								id={id}
								placeholder="Provider name (optional)"
								value={name}
								onChange={(e) => setName(e.target.value)}
							/>
						)}
					</Field>

					{tab === "m3u" && (
						<>
							{showFileBrowse && (
								<SegmentedControl
									aria-label="Playlist source"
									value={m3uMode}
									onChange={setM3uMode}
									options={M3U_MODES}
									fill
								/>
							)}

							{m3uMode === "url" && (
								<Field label="Playlist URL" hideLabel>
									{(id) => (
										<Input
											id={id}
											placeholder="M3U playlist URL"
											value={url}
											onChange={(e) => setUrl(e.target.value)}
											required
										/>
									)}
								</Field>
							)}

							{m3uMode === "file" && (
								<>
									{filePath ? (
										<div className="flex items-center gap-2 p-3 rounded-lg border border-primary/30 bg-primary/5">
											<FileText className="h-5 w-5 text-primary shrink-0" />
											<div className="flex-1 min-w-0">
												<p className="text-sm font-medium truncate">
													{fileName}
												</p>
												<p className="text-xs text-muted-foreground truncate">
													{filePath}
												</p>
											</div>
											<Button
												type="button"
												variant="ghost"
												size="icon"
												className="h-7 w-7 shrink-0"
												onClick={clearFile}
												aria-label="Clear selected file"
											>
												<X className="h-3.5 w-3.5" />
											</Button>
										</div>
									) : (
										<div
											role="button"
											tabIndex={0}
											className={cn(
												"flex flex-col items-center justify-center gap-2 p-6 rounded-lg border-2 border-dashed transition-colors cursor-pointer ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
												isDragOver
													? "border-primary bg-primary/10"
													: "border-border hover:border-muted-foreground/50"
											)}
											onClick={handleBrowse}
											onKeyDown={(e) => {
												if (e.key !== "Enter" && e.key !== " ") return;
												e.preventDefault();
												handleBrowse();
											}}
										>
											<Upload
												className={cn(
													"h-8 w-8",
													isDragOver
														? "text-primary"
														: "text-muted-foreground"
												)}
											/>
											{showDragDrop ? (
												<p className="text-sm text-muted-foreground text-center">
													Drop an .m3u file here or{" "}
													<span className="text-primary font-medium">
														browse
													</span>
												</p>
											) : (
												<p className="text-sm text-muted-foreground text-center">
													Tap to select an .m3u file
												</p>
											)}
											<p className="text-xs text-muted-foreground">
												Supports .m3u and .m3u8
											</p>
										</div>
									)}
								</>
							)}
						</>
					)}

					{tab === "xtream" && (
						<XtreamFields
							variant="add"
							url={url}
							username={username}
							password={password}
							onUrlChange={setUrl}
							onUsernameChange={setUsername}
							onPasswordChange={setPassword}
						/>
					)}

					{error && (
						<p role="alert" className="text-sm text-destructive">
							{error}
						</p>
					)}

					<Button type="submit" disabled={!canSubmit}>
						{loading && <LoaderCircle className="h-4 w-4 mr-2 animate-spin" />}
						{tab === "m3u"
							? m3uMode === "file"
								? "Import Playlist"
								: "Load Playlist"
							: "Connect"}
					</Button>
				</form>
				<div className="mt-4">
					<ContentDisclaimer />
				</div>
			</CardContent>
		</Card>
	);
};
