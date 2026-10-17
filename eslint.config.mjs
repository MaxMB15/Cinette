// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import { defineConfig, globalIgnores } from "eslint/config";
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default defineConfig(
	globalIgnores([
		"dist/**",
		"node_modules/**",
		"**/*.min.js",
		"libs/**",
		"site/dist/**",
		"site/reports/**",
		"site/.stryker-tmp/**",
	]),
	eslint.configs.recommended,
	tseslint.configs.recommended,
	react.configs.flat.recommended,
	react.configs.flat["jsx-runtime"],
	reactHooks.configs.flat.recommended,
	{
		settings: {
			// Set by hand because detecting it calls a method ESLint 10 removed.
			react: { version: "19.3" },
		},
		languageOptions: {
			globals: { ...globals.browser },
		},
		rules: {
			"func-style": ["error", "expression"],
			"react/no-unescaped-entities": "off",
			"no-empty": ["error", { allowEmptyCatch: true }],
			"@typescript-eslint/no-empty-object-type": "off",
			"@typescript-eslint/no-unused-expressions": "off",
			"no-constant-binary-expression": "off",
		},
	},
	{
		// The website's build and test configs run in Node.
		files: ["site/*.config.{ts,mjs}"],
		languageOptions: {
			globals: { ...globals.node },
		},
	},
	eslintConfigPrettier
);
