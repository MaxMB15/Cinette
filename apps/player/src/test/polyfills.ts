// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

// jsdom has no AnimationEvent, and since 28.1 its style object has
// WebkitAnimation, so React would listen for webkitAnimationEnd. This must load
// before react-dom.
if (!("AnimationEvent" in globalThis)) {
	globalThis.AnimationEvent = class extends Event {} as unknown as typeof AnimationEvent;
}
