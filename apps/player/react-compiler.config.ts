// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";

/**
 * Files the React Compiler leaves alone, each with why. The player's files
 * belong to the remote-control work, which is changing them.
 */
export const NOT_COMPILED: Record<string, string> = {
	"src/hooks/useMpv.ts": "player: try with finally",
	"src/components/player/VideoPlayer.tsx": "player: a disabled exhaustive-deps rule",
	"src/components/player/SubtitlePicker.tsx": "player: try with finally",
};

const notCompiled = Object.keys(NOT_COMPILED);

/**
 * Tests and their helpers stay as they are written. Some test components
 * count their own renders, which memoizing would change.
 */
const TEST_FILE = /\.test\.tsx?$|\/src\/test\//;

/**
 * The React Compiler, for the app's build and its tests alike, so the tests
 * run the code the app ships.
 *
 * The compiler leaves a component or hook as it is when it meets something it
 * can't compile, such as `finally`, a `throw` or a `??` inside a `try`, or a
 * disabled React lint rule. With `all_errors`, that fails the build and every
 * test that loads the file instead, and the message names the line.
 */
export const reactCompiler = () => {
	const plugin = babel({
		presets: [
			reactCompilerPreset({
				panicThreshold: "all_errors",
				sources: (filename) =>
					!TEST_FILE.test(filename) &&
					!notCompiled.some((file) => filename.endsWith(file)),
			}),
		],
	});
	compilerPlugins.add(plugin);
	return plugin;
};

// babel() gives a promise of the plugin, which Vite waits for, so the plugin
// is told apart by the object itself rather than by its name.
const compilerPlugins = new WeakSet<object>();

/** Whether a Vite plugin is one reactCompiler made. */
export const isCompiler = (plugin: unknown): boolean =>
	typeof plugin === "object" && plugin !== null && compilerPlugins.has(plugin);
