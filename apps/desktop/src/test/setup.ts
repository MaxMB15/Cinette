// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import "@testing-library/jest-dom/vitest";

// jsdom has no ResizeObserver. Components that measure themselves, such as
// the Radix slider thumb, only need it to exist.
if (!("ResizeObserver" in globalThis)) {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
}
