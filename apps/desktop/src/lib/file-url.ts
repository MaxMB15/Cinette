// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// A playlist imported from disk is stored as a file:// URL so it can share the
// provider's url field with remote playlists.
const FILE_SCHEME = "file://";

// The same extensions the file picker offers.
const PLAYLIST_EXTENSION = /\.(m3u8?|txt)$/i;

export const isFileUrl = (url: string): boolean => url.startsWith(FILE_SCHEME);

export const fileUrlFromPath = (path: string): string => `${FILE_SCHEME}${path}`;

/** Returns anything that isn't a file:// URL unchanged. */
export const pathFromFileUrl = (url: string): string =>
	isFileUrl(url) ? url.slice(FILE_SCHEME.length) : url;

/** Handles Windows separators too, since the file picker returns native paths. */
export const filenameFromPath = (path: string): string => {
	const parts = path.replace(/\\/g, "/").split("/");
	return parts[parts.length - 1] || path;
};

export const isPlaylistFile = (path: string): boolean => PLAYLIST_EXTENSION.test(path);

export const nameFromFilename = (filename: string): string =>
	filename.replace(PLAYLIST_EXTENSION, "");

/** A full local path is long and says little on a provider card, so files show their name. */
export const displayUrl = (url: string): string =>
	isFileUrl(url) ? filenameFromPath(pathFromFileUrl(url)) : url;
