// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Upload, FileText, Link, X } from "lucide-react";
import { usePlatform } from "@/hooks/usePlatform";
import { isMobilePlatform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ContentDisclaimer } from "./ContentDisclaimer";

type M3uMode = "url" | "file";

interface AddProviderProps {
	onAddM3u: (name: string, url: string) => Promise<void>;
	onAddM3uFile: (name: string, path: string) => Promise<void>;
	onAddXtream: (name: string, url: string, username: string, password: string) => Promise<void>;
}

const filenameFromPath = (path: string): string => {
	const parts = path.replace(/\\/g, "/").split("/");
	return parts[parts.length - 1] || path;
};

const nameFromFilename = (filename: string): string => filename.replace(/\.(m3u8?|txt)$/i, "");

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

	const acceptFileDrop = useCallback(
		(paths: string[]) => {
			const m3uPath = paths.find((p) => /\.(m3u8?|txt)$/i.test(p));
			if (!m3uPath) {
				setError("Please drop an .m3u or .m3u8 file");
				return;
			}
			setError(null);
			const fname = filenameFromPath(m3uPath);
			setFilePath(m3uPath);
			setFileName(fname);
			setM3uMode("file");
			setTab("m3u");
			if (!name) {
				setName(nameFromFilename(fname));
			}
		},
		[name]
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
						extensions: ["m3u", "m3u8", "txt"],
					},
				],
			});
			if (selected) {
				const path = typeof selected === "string" ? selected : selected;
				if (path) {
					const fname = filenameFromPath(path);
					setFilePath(path);
					setFileName(fname);
					setError(null);
					if (!name) {
						setName(nameFromFilename(fname));
					}
				}
			}
		} catch (e) {
			setError(String(e));
		}
	}, [name]);

	const clearFile = useCallback(() => {
		setFilePath(null);
		setFileName(null);
	}, []);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setLoading(true);
		setError(null);
		try {
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
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	};

	const canSubmit =
		!loading && (tab === "xtream" ? !!url : m3uMode === "file" ? !!filePath : !!url);

	return (
		<Card>
			<CardHeader>
				<CardTitle className="text-lg">Add Provider</CardTitle>
				<div className="flex gap-2 mt-2">
					<Button
						variant={tab === "m3u" ? "default" : "secondary"}
						size="sm"
						onClick={() => setTab("m3u")}
					>
						M3U Playlist
					</Button>
					<Button
						variant={tab === "xtream" ? "default" : "secondary"}
						size="sm"
						onClick={() => setTab("xtream")}
					>
						Xtream Codes
					</Button>
				</div>
			</CardHeader>
			<CardContent>
				<form onSubmit={handleSubmit} className="flex flex-col gap-3">
					<Input
						placeholder="Provider name (optional)"
						value={name}
						onChange={(e) => setName(e.target.value)}
					/>

					{tab === "m3u" && (
						<>
							{showFileBrowse && (
								<div className="flex gap-1 p-1 bg-secondary rounded-lg">
									<button
										type="button"
										onClick={() => setM3uMode("url")}
										className={cn(
											"flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md text-xs font-medium transition-colors",
											m3uMode === "url"
												? "bg-background text-foreground shadow-sm"
												: "text-muted-foreground hover:text-foreground"
										)}
									>
										<Link className="h-3.5 w-3.5" />
										URL
									</button>
									<button
										type="button"
										onClick={() => setM3uMode("file")}
										className={cn(
											"flex-1 flex items-center justify-center gap-1.5 py-1.5 px-3 rounded-md text-xs font-medium transition-colors",
											m3uMode === "file"
												? "bg-background text-foreground shadow-sm"
												: "text-muted-foreground hover:text-foreground"
										)}
									>
										<FileText className="h-3.5 w-3.5" />
										File
									</button>
								</div>
							)}

							{m3uMode === "url" && (
								<Input
									placeholder="M3U playlist URL"
									value={url}
									onChange={(e) => setUrl(e.target.value)}
									required
								/>
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
											>
												<X className="h-3.5 w-3.5" />
											</Button>
										</div>
									) : (
										<div
											className={cn(
												"flex flex-col items-center justify-center gap-2 p-6 rounded-lg border-2 border-dashed transition-colors cursor-pointer",
												isDragOver
													? "border-primary bg-primary/10"
													: "border-border hover:border-muted-foreground/50"
											)}
											onClick={handleBrowse}
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
						<>
							<Input
								placeholder="Server URL (e.g. http://example.com:8080)"
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								required
							/>
							<Input
								placeholder="Username"
								value={username}
								onChange={(e) => setUsername(e.target.value)}
								required
							/>
							<Input
								placeholder="Password"
								type="password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								required
							/>
						</>
					)}

					{error && <p className="text-sm text-destructive">{error}</p>}

					<Button type="submit" disabled={!canSubmit}>
						{loading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
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
