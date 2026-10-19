// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";
import { notifyManager } from "@tanstack/react-query";

// Vitest runs without globals, so Testing Library can't register its own
// cleanup. Unmount what each test rendered, including its timers and polls.
afterEach(cleanup);

// jsdom has no ResizeObserver. Components that measure themselves, such as
// the Radix slider thumb, only need it to exist.
if (!("ResizeObserver" in globalThis)) {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
}

// TanStack Query tells components about new data on a timer, which fires
// after act() has returned. A microtask lands inside act(), so a test can read
// the new data straight after it, as it can for a state update.
notifyManager.setScheduler(queueMicrotask);
