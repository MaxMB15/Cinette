// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The messages two devices exchange, and how they're written.
//!
//! Every message is a JSON object with the format version in `v` and the
//! message type in `type`. Unknown fields are ignored, so a later version
//! can add fields. A message of an unknown type is answered with
//! [`ErrorCode::Unsupported`] rather than ending the connection.

use super::catalog::{CatalogItem, CatalogQuery};
use super::identity::DeviceId;
use super::transfer::chunks::Chunk;
use super::transfer::flow::{Direction, ProviderName, ProviderResult, ProviderSettings};
use super::transfer::merge::Report;
use super::transfer::{Counts, What};
use serde::{Deserialize, Serialize};

/// The protocol version this build speaks.
pub const PROTOCOL_VERSION: u32 = 1;
/// The message format version, in each message's `v`.
pub const FORMAT_VERSION: u32 = 1;
/// The largest encrypted frame. Noise messages are at most 65535 bytes.
pub const MAX_FRAME: usize = 65535;
/// Noise adds a 16-byte tag to each encrypted message.
pub const TAG_LEN: usize = 16;
/// The largest message before encryption.
pub const MAX_MESSAGE: usize = MAX_FRAME - TAG_LEN;

/// What kind of device an app runs on, for its default name and its icon in
/// the device picker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeviceType {
    Mac,
    LinuxPc,
    WindowsPc,
    Iphone,
    Ipad,
    AndroidPhone,
    AndroidTablet,
    AndroidTv,
    FireTv,
    /// A type from a newer version of Cinette.
    #[serde(other)]
    Other,
}

impl DeviceType {
    pub const ALL: [DeviceType; 9] = [
        DeviceType::Mac,
        DeviceType::LinuxPc,
        DeviceType::WindowsPc,
        DeviceType::Iphone,
        DeviceType::Ipad,
        DeviceType::AndroidPhone,
        DeviceType::AndroidTablet,
        DeviceType::AndroidTv,
        DeviceType::FireTv,
    ];

    /// The value in the discovery record's `t` entry.
    pub fn as_str(self) -> &'static str {
        match self {
            DeviceType::Mac => "mac",
            DeviceType::LinuxPc => "linux-pc",
            DeviceType::WindowsPc => "windows-pc",
            DeviceType::Iphone => "iphone",
            DeviceType::Ipad => "ipad",
            DeviceType::AndroidPhone => "android-phone",
            DeviceType::AndroidTablet => "android-tablet",
            DeviceType::AndroidTv => "android-tv",
            DeviceType::FireTv => "fire-tv",
            DeviceType::Other => "other",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|t| t.as_str() == text)
    }
}

/// What a connection can be used for, beyond the handshake.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Feature {
    Control,
    Catalog,
    /// Copying history and favorites between devices, spec 5.
    History,
    /// Sending providers to the target, answer 4 to spec 5.
    Providers,
    /// A feature from a newer version of Cinette, which this one ignores.
    #[serde(other)]
    Unknown,
}

/// Who a device says it is, sent inside the handshake.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    pub id: DeviceId,
    pub name: String,
    pub device_type: DeviceType,
    pub versions: Vec<u32>,
    #[serde(default)]
    pub features: Vec<Feature>,
}

/// The controller's last handshake message: its hello and the commitment to
/// its half of the verification code.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerHello {
    #[serde(flatten)]
    pub hello: Hello,
    pub commit: String,
}

/// What a controller asks a target for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RequestKind {
    Control,
    /// Copying history one way or the other, spec 5, inside a session. It
    /// always needs its own consent, whatever the control setting.
    History,
    /// Sending providers, with their logins, to the target, inside a
    /// session. It always needs its own consent, separate from history.
    Providers,
}

/// Why a connection or a session ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseReason {
    /// The two devices share no protocol version.
    Version,
    /// The target isn't discoverable, so it takes no new connections.
    NotDiscoverable,
    /// The target's remote control is set to Never allow.
    NotAllowed,
    /// The user on the target said no.
    Denied,
    /// No one answered the request in time.
    Expired,
    /// The controller stopped asking, or the request was replaced.
    Cancelled,
    /// The target ended the session.
    Revoked,
    /// The controller left.
    Left,
    /// The target already has as many controllers or requests as it takes.
    Busy,
    /// The key behind the connection isn't the device it claims to be.
    IdentityMismatch,
    /// The other side broke the protocol.
    Protocol,
    /// Nothing arrived for too long.
    Timeout,
    /// The app is quitting, or reset its identity.
    Shutdown,
    /// A reason from a newer version of Cinette.
    #[serde(other)]
    Unknown,
}

/// Why a single command or query failed. The session goes on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    Invalid,
    Unsupported,
    NotFound,
    /// The command was about an item that is no longer playing.
    StaleItem,
    RateLimited,
    /// The target couldn't carry it out, for example because its player failed.
    Failed,
    /// The user on the target said no to a transfer.
    Denied,
    /// No one answered in time, or a transfer stalled.
    Expired,
    /// The target is already asking about, or running, another transfer.
    Busy,
    /// Either side stopped a transfer.
    Cancelled,
    /// A transfer is larger than the other side takes.
    TooLarge,
    /// A code from a newer version of Cinette.
    #[serde(other)]
    Unknown,
}

/// What the target is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackStatus {
    #[default]
    Idle,
    Opening,
    Playing,
    Paused,
    Buffering,
    Ended,
    Error,
}

/// Why the target's player stopped with an error. Only a code goes out, never
/// the player's own message, which can hold a stream's address or login.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaybackError {
    /// The stream stopped before it ever played.
    OpenFailed,
    /// Reconnecting ran out of tries.
    LoadFailed,
    /// The provider refused the stream, so its login may have expired.
    Refused,
    /// Anything else.
    Failed,
    /// A code from a newer version of Cinette.
    #[serde(other)]
    Unknown,
}

/// A subtitle or audio track.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
}

/// What the target's player can do right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Capabilities {
    pub pause: bool,
    pub seek: bool,
    pub volume: bool,
    pub subtitles: bool,
    pub audio_tracks: bool,
    pub resume_at: bool,
}

/// The target's playback, as controllers see it.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PlaybackSnapshot {
    pub status: PlaybackStatus,
    pub item: Option<CatalogItem>,
    /// Seconds, when the state was sent.
    pub position: f64,
    /// Seconds. 0 for live channels.
    pub duration: f64,
    /// 0 to 100, or `None` when the target can't set its volume.
    pub volume: Option<u8>,
    pub subtitles: Vec<Track>,
    pub subtitle_id: Option<String>,
    pub audio: Vec<Track>,
    pub audio_id: Option<String>,
    pub capabilities: Capabilities,
    /// Set when `status` is [`PlaybackStatus::Error`].
    pub error: Option<PlaybackError>,
}

/// The target's state with its version. A controller keeps the newest one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionedState {
    /// Random for each start of the target app.
    pub epoch: String,
    /// One more on every state the target sends.
    pub version: u64,
    pub state: PlaybackSnapshot,
}

/// A playback command from a controller.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Command {
    /// Plays one of the target's catalog items. Never a URL.
    Load {
        item_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        start_at: Option<f64>,
    },
    Play {
        item_id: String,
    },
    Pause {
        item_id: String,
    },
    /// Moves to `to` seconds, or by `by` seconds from where the target is
    /// when the command arrives. Exactly one is set.
    Seek {
        item_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        to: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        by: Option<f64>,
    },
    Volume {
        value: u8,
    },
    /// `None` turns subtitles off.
    Subtitle {
        item_id: String,
        track_id: Option<String>,
    },
    Audio {
        item_id: String,
        track_id: String,
    },
    Stop,
}

/// Every message after the handshake.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Message {
    /// The target's half of the verification code.
    Nonce {
        nonce: String,
    },
    /// The controller's half, which must match its commitment.
    Reveal {
        nonce: String,
    },
    /// Asks for control, or to resume the session with this id. Inside a
    /// session, asks for a transfer: history with `direction` and `what`
    /// (and the controller's `counts` when it sends), or the `providers`
    /// named. A transfer request has an `id` its answers name.
    Request {
        kind: RequestKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resume: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        id: Option<u64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        direction: Option<Direction>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        what: Option<What>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        counts: Option<Counts>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        providers: Option<Vec<ProviderName>>,
    },
    /// The target is asking its user. The request ends after this many
    /// seconds. `re` names a transfer request.
    Pending {
        expires_in: u32,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        re: Option<u64>,
    },
    /// The controller stops asking.
    Cancel,
    /// The request was granted. The target's current state comes with it.
    Accepted {
        session_id: String,
        state: VersionedState,
    },
    /// The connection ends, for this reason.
    Closed {
        reason: CloseReason,
    },
    State(VersionedState),
    Command {
        id: u64,
        command: Command,
    },
    Catalog {
        id: u64,
        query: CatalogQuery,
    },
    CatalogPage {
        re: u64,
        items: Vec<CatalogItem>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        next: Option<String>,
    },
    Ok {
        re: u64,
        version: u64,
    },
    Error {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        re: Option<u64>,
        code: ErrorCode,
    },
    Ping,
    Pong,
    /// A transfer request was allowed. `transfer` names it from now on. A
    /// history transfer has the `salt` for account tags, and an import the
    /// target's `counts` for the preview.
    Granted {
        re: u64,
        transfer: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        salt: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        counts: Option<Counts>,
    },
    /// The controller confirmed the import's preview.
    TransferStart {
        transfer: String,
    },
    TransferChunk {
        transfer: String,
        chunk: Chunk,
    },
    TransferAck {
        transfer: String,
        seq: u32,
    },
    /// The side that wrote the history says what it did.
    TransferDone {
        transfer: String,
        report: Report,
    },
    /// The transfer stopped, and nothing was written.
    TransferError {
        transfer: String,
        code: ErrorCode,
    },
    TransferCancel {
        transfer: String,
    },
    /// The settings of the providers a grant named, logins included.
    ProvidersSend {
        grant: String,
        part: u32,
        #[serde(default)]
        last: bool,
        providers: Vec<ProviderSettings>,
    },
    ProvidersAdded {
        grant: String,
        results: Vec<ProviderResult>,
    },
}

impl Message {
    /// Asks for control, or to resume the session `resume`.
    pub fn control_request(resume: Option<String>) -> Self {
        Message::Request {
            kind: RequestKind::Control,
            resume,
            id: None,
            direction: None,
            what: None,
            counts: None,
            providers: None,
        }
    }
}

/// The `type` of every message this version knows.
pub(crate) const KNOWN_TYPES: &[&str] = &[
    "nonce",
    "reveal",
    "request",
    "pending",
    "cancel",
    "accepted",
    "closed",
    "state",
    "command",
    "catalog",
    "catalogPage",
    "ok",
    "error",
    "ping",
    "pong",
    "granted",
    "transferStart",
    "transferChunk",
    "transferAck",
    "transferDone",
    "transferError",
    "transferCancel",
    "providersSend",
    "providersAdded",
];

/// Why a message couldn't be read.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum DecodeError {
    /// Not JSON, or not an object with a known `v`.
    #[error("not a message")]
    Malformed,
    /// A newer format than this build reads.
    #[error("message format {0} is newer than this build")]
    Version(u32),
    /// A type this build doesn't know. The id is the request id, if it had one.
    #[error("unknown message type")]
    UnknownType { id: Option<u64> },
    /// A known type with fields that don't fit it.
    #[error("invalid message")]
    Invalid { id: Option<u64> },
}

/// Writes a message with its format version.
pub fn encode<T: Serialize>(message: &T) -> Vec<u8> {
    let mut value = serde_json::to_value(message).expect("messages always serialize");
    if let serde_json::Value::Object(map) = &mut value {
        map.insert("v".into(), FORMAT_VERSION.into());
    }
    serde_json::to_vec(&value).expect("messages always serialize")
}

/// Reads a message after the handshake.
pub fn decode(bytes: &[u8]) -> Result<Message, DecodeError> {
    let value = versioned_object(bytes)?;
    let kind = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let id = value.get("id").and_then(|id| id.as_u64());
    if !KNOWN_TYPES.contains(&kind) {
        return Err(DecodeError::UnknownType { id });
    }
    serde_json::from_value(value).map_err(|_| DecodeError::Invalid { id })
}

/// Reads a handshake payload.
pub fn decode_payload<T: serde::de::DeserializeOwned>(bytes: &[u8]) -> Result<T, DecodeError> {
    let value = versioned_object(bytes)?;
    serde_json::from_value(value).map_err(|_| DecodeError::Invalid { id: None })
}

fn versioned_object(bytes: &[u8]) -> Result<serde_json::Value, DecodeError> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| DecodeError::Malformed)?;
    let v = value
        .as_object()
        .and_then(|map| map.get("v"))
        .and_then(|v| v.as_u64())
        .ok_or(DecodeError::Malformed)?;
    let v = u32::try_from(v).unwrap_or(u32::MAX);
    if v > FORMAT_VERSION {
        return Err(DecodeError::Version(v));
    }
    if v == 0 {
        return Err(DecodeError::Malformed);
    }
    Ok(value)
}

/// The highest protocol version both sides speak.
pub fn common_version(ours: &[u32], theirs: &[u32]) -> Option<u32> {
    ours.iter().copied().filter(|v| theirs.contains(v)).max()
}

#[cfg(test)]
mod tests;
