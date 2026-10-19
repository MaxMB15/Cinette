// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! Google Cast, through the open protocol (CASTV2) that VLC and pychromecast
//! speak to Google's Default Media Receiver. No Google SDK is involved.
//!
//! Nothing here touches a socket or a clock. The platform layer opens a TLS
//! connection to the receiver's port 8009, passes in the bytes it reads and
//! the current time, and sends the frames that come back ([`session`]). Each
//! frame is a length and a protobuf message ([`frame`]) with a JSON payload
//! ([`message`]).

pub mod frame;
pub mod message;
pub mod session;

#[cfg(test)]
mod frame_tests;
#[cfg(test)]
mod loopback_tests;
#[cfg(test)]
mod session_tests;
