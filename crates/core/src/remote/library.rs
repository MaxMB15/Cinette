// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The target's library as its own screens read it, for a controller that
//! shows those same screens for the other device.
//!
//! A controller sends a [`LibraryCall`] in [`Message::Library`]. The target
//! answers with JSON, the same JSON its own screens get, with no stream URL,
//! login or provider server in it. The answer is deflated and goes back in
//! [`Message::LibraryData`] pieces that fit a frame. The controller
//! acknowledges each piece, and the target keeps at most [`WINDOW`] pieces
//! unacknowledged, so a big answer can't fill the connection's queue.
//!
//! Each connection runs one call at a time, in the order they came, and
//! keeps at most [`MAX_CALLS`] waiting.

use super::catalog::{MAX_ID_BYTES, MAX_QUERY_CHARS};
use super::message::{ErrorCode, Message};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{Read, Write};

/// Packed answer bytes in one piece. In base64 with the message around it,
/// that's under the frame's limit.
pub const PIECE_BYTES: usize = 45 * 1024;
/// The most pieces the target sends before the first is acknowledged.
pub const WINDOW: usize = 16;
/// The most calls one connection may have waiting, besides the one running.
pub const MAX_CALLS: usize = 32;
/// The longest packed answer, which a whole library fits in many times over.
pub const MAX_PACKED: usize = 64 * 1024 * 1024;
/// The most JSON an answer unpacks to.
pub const MAX_UNPACKED: usize = 512 * 1024 * 1024;
/// The most packed bytes waiting to go out on one connection.
pub const MAX_QUEUED: usize = 2 * MAX_PACKED;
/// The most guide ids one call names.
pub const MAX_GUIDE_IDS: usize = 1_000;
/// The longest group name or show title a call names, in bytes.
pub const MAX_TEXT_BYTES: usize = 1_024;
/// The most watch history entries one call asks for.
pub const MAX_HISTORY: u32 = 1_000;

/// What a controller asks of the target's library. The answer is the JSON
/// the target's own command of the same name returns.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "name",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum LibraryCall {
    /// Every channel, movie and series, with no stream URLs.
    Channels,
    /// The providers, with no server or login.
    Providers,
    GroupHierarchy {
        provider_id: String,
        content_type: String,
    },
    PinnedGroups {
        provider_id: String,
        content_type: String,
    },
    /// The programs from `from` to `to`, for these guide ids or for every
    /// channel.
    Guide {
        from: i64,
        to: i64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        ids: Option<Vec<String>>,
    },
    /// One channel's programs, by its guide id.
    Schedule {
        epg_id: String,
        from: i64,
        to: i64,
    },
    GuideSearch {
        query: String,
        from: i64,
    },
    History {
        limit: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content_type: Option<String>,
    },
    /// A series' episodes, loaded the way the target's series list loads
    /// them.
    SeriesEpisodes {
        series_id: String,
    },
    /// OMDb's details, with the target's key. `kind` is "movie" or "series".
    Omdb {
        id: String,
        title: String,
        kind: String,
    },
    /// Whatson's ratings. `kind` is "movie" or "show".
    Whatson {
        imdb_id: String,
        kind: String,
    },
    ToggleFavorite {
        id: String,
    },
    PinGroup {
        provider_id: String,
        content_type: String,
        group: String,
        order: i64,
    },
    UnpinGroup {
        provider_id: String,
        content_type: String,
        group: String,
    },
    DeleteHistory {
        channel_id: String,
    },
    DeleteHistorySeries {
        series_title: String,
    },
    ClearHistory {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        content_type: Option<String>,
    },
}

impl LibraryCall {
    /// Whether every field is within the limits.
    pub fn is_valid(&self) -> bool {
        let id = |s: &str| s.len() <= MAX_ID_BYTES;
        let text = |s: &str| s.len() <= MAX_TEXT_BYTES;
        let kind = |s: &str| matches!(s, "live" | "movie" | "series");
        match self {
            LibraryCall::Channels | LibraryCall::Providers => true,
            LibraryCall::GroupHierarchy {
                provider_id,
                content_type,
            }
            | LibraryCall::PinnedGroups {
                provider_id,
                content_type,
            } => id(provider_id) && kind(content_type),
            LibraryCall::Guide { from, to, ids } => {
                from <= to
                    && ids
                        .as_ref()
                        .is_none_or(|ids| ids.len() <= MAX_GUIDE_IDS && ids.iter().all(|i| id(i)))
            }
            LibraryCall::Schedule { epg_id, from, to } => id(epg_id) && from <= to,
            LibraryCall::GuideSearch { query, .. } => query.chars().count() <= MAX_QUERY_CHARS,
            LibraryCall::History {
                limit,
                content_type,
            } => *limit <= MAX_HISTORY && content_type.as_deref().is_none_or(kind),
            LibraryCall::SeriesEpisodes { series_id } => id(series_id),
            LibraryCall::Omdb {
                id: channel,
                title,
                kind,
            } => id(channel) && text(title) && matches!(kind.as_str(), "movie" | "series"),
            LibraryCall::Whatson { imdb_id, kind } => {
                id(imdb_id) && matches!(kind.as_str(), "movie" | "show")
            }
            LibraryCall::ToggleFavorite { id: channel }
            | LibraryCall::DeleteHistory {
                channel_id: channel,
            } => id(channel),
            LibraryCall::PinGroup {
                provider_id,
                content_type,
                group,
                ..
            }
            | LibraryCall::UnpinGroup {
                provider_id,
                content_type,
                group,
            } => id(provider_id) && kind(content_type) && text(group),
            LibraryCall::DeleteHistorySeries { series_title } => text(series_title),
            LibraryCall::ClearHistory { content_type } => content_type.as_deref().is_none_or(kind),
        }
    }

    /// Whether it changes the target's library, which its own screens then
    /// show.
    pub fn edits(&self) -> bool {
        matches!(
            self,
            LibraryCall::ToggleFavorite { .. }
                | LibraryCall::PinGroup { .. }
                | LibraryCall::UnpinGroup { .. }
                | LibraryCall::DeleteHistory { .. }
                | LibraryCall::DeleteHistorySeries { .. }
                | LibraryCall::ClearHistory { .. }
        )
    }
}

/// Deflates an answer's JSON.
pub fn pack(json: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::fast());
    // Writing to a Vec can't fail.
    encoder.write_all(json).expect("writing to memory");
    encoder.finish().expect("writing to memory")
}

/// Inflates an answer, which must come to at most `cap` bytes.
pub fn unpack(packed: &[u8], cap: usize) -> Result<Vec<u8>, ErrorCode> {
    let mut json = Vec::new();
    flate2::read::DeflateDecoder::new(packed)
        .take(cap as u64 + 1)
        .read_to_end(&mut json)
        .map_err(|_| ErrorCode::Invalid)?;
    if json.len() > cap {
        return Err(ErrorCode::TooLarge);
    }
    Ok(json)
}

/// The base64 the pieces carry.
const BASE64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// An answer on its way out.
struct Outgoing {
    re: u64,
    packed: Vec<u8>,
    /// How many of its bytes went out.
    sent: usize,
    /// The next piece's number.
    seq: u32,
}

/// One connection's calls and answers, on the target.
#[derive(Default)]
pub(crate) struct TargetLibrary {
    waiting: VecDeque<(u64, LibraryCall)>,
    running: Option<u64>,
    /// Answers waiting to go out, the one going out first.
    outgoing: VecDeque<Outgoing>,
    /// The pieces sent and not acknowledged yet, oldest first.
    unacked: VecDeque<(u64, u32)>,
}

impl TargetLibrary {
    /// A controller's call. Returns the call to run now, if nothing is
    /// running, or `Busy` when too many are waiting.
    pub(crate) fn ask(
        &mut self,
        id: u64,
        call: LibraryCall,
    ) -> Result<Option<(u64, LibraryCall)>, ErrorCode> {
        if self.waiting.len() >= MAX_CALLS {
            return Err(ErrorCode::Busy);
        }
        self.waiting.push_back((id, call));
        Ok(self.next())
    }

    /// The call to run next, when nothing is running.
    fn next(&mut self) -> Option<(u64, LibraryCall)> {
        if self.running.is_some() {
            return None;
        }
        let (id, call) = self.waiting.pop_front()?;
        self.running = Some(id);
        Some((id, call))
    }

    /// The running call `re` is done: the messages to send, and the call to
    /// run next. A result for a call that isn't running is dropped.
    pub(crate) fn finished(
        &mut self,
        re: u64,
        result: Result<Vec<u8>, ErrorCode>,
    ) -> (Vec<Message>, Option<(u64, LibraryCall)>) {
        if self.running != Some(re) {
            return (Vec::new(), None);
        }
        self.running = None;
        let queued: usize = self.outgoing.iter().map(|o| o.packed.len() - o.sent).sum();
        let mut messages = Vec::new();
        match result {
            Ok(packed) if packed.len() > MAX_PACKED => messages.push(Message::Error {
                re: Some(re),
                code: ErrorCode::TooLarge,
            }),
            Ok(packed) if queued + packed.len() > MAX_QUEUED => messages.push(Message::Error {
                re: Some(re),
                code: ErrorCode::Busy,
            }),
            Ok(packed) => {
                self.outgoing.push_back(Outgoing {
                    re,
                    packed,
                    sent: 0,
                    seq: 0,
                });
                self.fill(&mut messages);
            }
            Err(code) => messages.push(Message::Error { re: Some(re), code }),
        }
        (messages, self.next())
    }

    /// Whether `message` is the acknowledgement of the oldest piece out.
    pub(crate) fn expects(&self, message: &Message) -> bool {
        matches!(message, Message::LibraryAck { re, seq } if self.unacked.front() == Some(&(*re, *seq)))
    }

    /// The controller acknowledged a piece. Returns the pieces that can go
    /// out now, or `None` for an acknowledgement of no piece out.
    pub(crate) fn acked(&mut self, re: u64, seq: u32) -> Option<Vec<Message>> {
        if self.unacked.front() != Some(&(re, seq)) {
            return None;
        }
        self.unacked.pop_front();
        let mut messages = Vec::new();
        self.fill(&mut messages);
        Some(messages)
    }

    /// Sends pieces until [`WINDOW`] are out or nothing is left.
    fn fill(&mut self, messages: &mut Vec<Message>) {
        while self.unacked.len() < WINDOW {
            let Some(out) = self.outgoing.front_mut() else {
                return;
            };
            let end = (out.sent + PIECE_BYTES).min(out.packed.len());
            let last = end == out.packed.len();
            messages.push(Message::LibraryData {
                re: out.re,
                seq: out.seq,
                last,
                size: (out.seq == 0).then_some(out.packed.len() as u64),
                data: BASE64.encode(&out.packed[out.sent..end]),
            });
            self.unacked.push_back((out.re, out.seq));
            out.sent = end;
            out.seq += 1;
            if last {
                self.outgoing.pop_front();
            }
        }
    }
}

/// An answer coming in, on the controller.
#[derive(Default)]
pub(crate) struct Incoming {
    packed: Vec<u8>,
    seq: u32,
    /// The whole answer's length, as its first piece gave it.
    size: Option<u64>,
}

/// What a piece did to the answer it's part of.
#[derive(Debug, PartialEq)]
pub(crate) enum Piece {
    /// More is coming. `received` bytes came so far, of `size` when the
    /// target said.
    More { received: u64, size: Option<u64> },
    /// That was the last piece: here's the whole answer, still packed.
    Done(Vec<u8>),
    /// Out of order, not base64, or too big. The answer is lost.
    Broken,
}

impl Incoming {
    /// Adds the piece `seq`. `size` counts only on the first piece.
    pub(crate) fn add(&mut self, seq: u32, last: bool, size: Option<u64>, data: &str) -> Piece {
        if seq != self.seq {
            return Piece::Broken;
        }
        let Ok(bytes) = BASE64.decode(data) else {
            return Piece::Broken;
        };
        if bytes.len() > PIECE_BYTES || self.packed.len() + bytes.len() > MAX_PACKED {
            return Piece::Broken;
        }
        if seq == 0 {
            self.size = size;
        }
        self.packed.extend_from_slice(&bytes);
        self.seq += 1;
        if last {
            Piece::Done(std::mem::take(&mut self.packed))
        } else {
            Piece::More {
                received: self.packed.len() as u64,
                size: self.size,
            }
        }
    }
}

#[cfg(test)]
mod tests;
