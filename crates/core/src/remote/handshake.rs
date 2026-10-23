// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The handshake that starts every connection, and the verification code.
//!
//! The controller and the target run Noise `XX_25519_ChaChaPoly_BLAKE2s`, so
//! each proves it holds its device key. The controller checks the target's
//! key against the device id it meant to reach.
//!
//! Then both work out a 6-digit code from the handshake and a nonce from each
//! side, and the user compares the codes on both screens. Someone in the
//! middle has to run a separate handshake with each side and make the two
//! codes match.
//!
//! The controller commits to its nonce before it sees the target's, so a
//! device posing as the target can't steer the code the controller shows.
//! A device posing as a controller can't steer the target's code either, but
//! it learns that code as soon as the target's nonce arrives, before the
//! target shows anything. It could hang up and try again until a code
//! matches the one on the real controller's screen. The handshake alone
//! doesn't stop that. Two limits around it do:
//!
//! - [`Target`](super::target::Target) sends at most
//!   [`NONCE_BURST`](super::target::NONCE_BURST) nonces at once and one a
//!   second after that, across all connections. It checks through
//!   [`TargetHandshake::read_admitting`].
//! - A [`Controller`](super::controller::Controller) gives up on a target
//!   that hasn't let it in after
//!   [`GIVE_UP_AFTER`](super::controller::GIVE_UP_AFTER), whatever the target
//!   says.
//!
//! An unanswered handshake also ends after
//! [`HANDSHAKE_TIMEOUT`](super::target::HANDSHAKE_TIMEOUT). So each time the
//! user connects, a device in the middle gets about 55 of the million codes,
//! a chance of about 1 in 18,000.

use super::channel::{self, Channel};
use super::identity::{DeviceId, DeviceKey};
use super::message::{
    self, CloseReason, ControllerHello, DeviceType, Feature, Hello, Message, MAX_FRAME,
};
use super::settings;
use blake2::{Blake2s256, Digest};
use std::fmt;

const NOISE_PARAMS: &str = "Noise_XX_25519_ChaChaPoly_BLAKE2s";
/// Mixed into the handshake, so a connection from another protocol fails.
pub const PROLOGUE: &[u8] = b"cinette-remote/1";
const NONCE_LEN: usize = 32;

/// The 6-digit number both screens show.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct VerificationCode(u32);

impl VerificationCode {
    pub fn value(self) -> u32 {
        self.0
    }

    #[cfg(test)]
    pub(crate) const fn for_tests(value: u32) -> Self {
        Self(value)
    }
}

impl fmt::Display for VerificationCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:06}", self.0)
    }
}

impl fmt::Debug for VerificationCode {
    // Kept out of logs.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("VerificationCode(..)")
    }
}

/// The other device, as the handshake proved it.
#[derive(Debug, Clone, PartialEq)]
pub struct Peer {
    /// Worked out from the key the other side proved it holds.
    pub id: DeviceId,
    pub name: String,
    pub device_type: DeviceType,
    pub features: Vec<Feature>,
}

impl Peer {
    /// Takes the name the device sent in a rename, cleaned like its hello's.
    /// True when it changed.
    pub fn rename(&mut self, name: &str) -> bool {
        let name = settings::shown_name(name, self.device_type);
        let changed = self.name != name;
        self.name = name;
        changed
    }
}

/// A finished handshake.
pub struct Established {
    pub channel: Channel,
    pub peer: Peer,
    pub code: VerificationCode,
    /// The protocol version both sides speak.
    pub version: u32,
}

impl fmt::Debug for Established {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Established")
            .field("peer", &self.peer)
            .field("version", &self.version)
            .finish_non_exhaustive()
    }
}

/// A handshake that failed. `send`, when set, tells the other side why, and
/// goes out before the connection closes.
#[derive(Debug)]
pub struct Failure {
    pub reason: CloseReason,
    pub send: Option<Vec<u8>>,
}

impl Failure {
    fn new(reason: CloseReason) -> Self {
        Self { reason, send: None }
    }
}

/// What reading one handshake frame led to.
pub enum Next<H> {
    /// The handshake goes on.
    Continue(H),
    Done(Box<Established>),
}

/// One handshake frame read: what to send back, and what comes next.
pub type Step<H> = Result<(Option<Vec<u8>>, Next<H>), Failure>;

fn builder(key: &DeviceKey) -> Result<snow::Builder<'_>, Failure> {
    let params = NOISE_PARAMS
        .parse()
        .expect("the Noise parameters are valid");
    snow::Builder::new(params)
        .local_private_key(key.private_bytes())
        .and_then(|b| b.prologue(PROLOGUE))
        .map_err(|_| Failure::new(CloseReason::Protocol))
}

fn write(state: &mut snow::HandshakeState, payload: &[u8]) -> Result<Vec<u8>, Failure> {
    let mut out = vec![0u8; MAX_FRAME];
    let len = state
        .write_message(payload, &mut out)
        .map_err(|_| Failure::new(CloseReason::Protocol))?;
    Ok(channel::frame(&out[..len]))
}

fn read(state: &mut snow::HandshakeState, frame: &[u8]) -> Result<Vec<u8>, Failure> {
    let mut out = vec![0u8; frame.len()];
    let len = state
        .read_message(frame, &mut out)
        .map_err(|_| Failure::new(CloseReason::Protocol))?;
    out.truncate(len);
    Ok(out)
}

/// The peer the other side's hello and key describe. The id comes from the
/// key, and a hello that names another id fails.
fn peer_from(state: &snow::HandshakeState, hello: &Hello) -> Result<Peer, Failure> {
    let key = state
        .get_remote_static()
        .ok_or_else(|| Failure::new(CloseReason::Protocol))?;
    let id = DeviceId::from_public_key(key);
    if id != hello.id {
        return Err(Failure::new(CloseReason::IdentityMismatch));
    }
    Ok(Peer {
        id,
        name: settings::shown_name(&hello.name, hello.device_type),
        device_type: hello.device_type,
        features: hello.features.clone(),
    })
}

fn handshake_hash(state: &snow::HandshakeState) -> [u8; 32] {
    state
        .get_handshake_hash()
        .try_into()
        .expect("BLAKE2s hashes are 32 bytes")
}

fn commitment(hash: &[u8; 32], nonce: &[u8; NONCE_LEN]) -> [u8; 32] {
    Blake2s256::new()
        .chain_update(b"cinette-commit")
        .chain_update(hash)
        .chain_update(nonce)
        .finalize()
        .into()
}

fn code(
    hash: &[u8; 32],
    controller: &[u8; NONCE_LEN],
    target: &[u8; NONCE_LEN],
) -> VerificationCode {
    let digest = Blake2s256::new()
        .chain_update(b"cinette-code")
        .chain_update(hash)
        .chain_update(controller)
        .chain_update(target)
        .finalize();
    let n = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]);
    VerificationCode(n % 1_000_000)
}

/// A failed handshake that tells the controller why over the new channel.
fn refuse(channel: &mut Channel, reason: CloseReason) -> Failure {
    Failure {
        reason,
        send: channel.seal(&Message::Closed { reason }).ok(),
    }
}

/// Reads the one message expected at this point of the handshake.
fn open_message(channel: &mut Channel, frame: &[u8]) -> Result<Message, Failure> {
    let plain = channel
        .open(frame)
        .map_err(|_| Failure::new(CloseReason::Protocol))?;
    message::decode(&plain).map_err(|_| Failure::new(CloseReason::Protocol))
}

/// The controller's side of the handshake.
pub struct ControllerHandshake {
    stage: ControllerStage,
    versions: Vec<u32>,
}

enum ControllerStage {
    /// Sent the first message; waiting for the target's key and hello.
    SentFirst {
        state: Box<snow::HandshakeState>,
        hello: Hello,
        expected: DeviceId,
    },
    /// Sent its key, hello and commitment; waiting for the target's nonce.
    Committed {
        channel: Channel,
        peer: Peer,
        version: u32,
        hash: [u8; 32],
        nonce: [u8; NONCE_LEN],
    },
}

impl ControllerHandshake {
    /// Starts a handshake with the device whose id is `expected`. Returns the
    /// first frame to send.
    pub fn start(
        key: &DeviceKey,
        hello: Hello,
        expected: DeviceId,
    ) -> Result<(Self, Vec<u8>), Failure> {
        let mut state = builder(key)?
            .build_initiator()
            .map_err(|_| Failure::new(CloseReason::Protocol))?;
        let first = write(&mut state, &[])?;
        let versions = hello.versions.clone();
        Ok((
            Self {
                stage: ControllerStage::SentFirst {
                    state: Box::new(state),
                    hello,
                    expected,
                },
                versions,
            },
            first,
        ))
    }

    pub fn read(self, frame: &[u8]) -> Step<Self> {
        match self.stage {
            ControllerStage::SentFirst {
                mut state,
                hello,
                expected,
            } => {
                let payload = read(&mut state, frame)?;
                let target: Hello = message::decode_payload(&payload)
                    .map_err(|_| Failure::new(CloseReason::Protocol))?;
                let peer = peer_from(&state, &target)?;
                if peer.id != expected {
                    return Err(Failure::new(CloseReason::IdentityMismatch));
                }
                let version = message::common_version(&self.versions, &target.versions)
                    .ok_or_else(|| Failure::new(CloseReason::Version))?;
                let nonce = super::random_bytes::<NONCE_LEN>();
                // The commitment goes inside the last handshake message, so
                // it's made over the hash from before that message, which
                // the target knows too.
                let commit = commitment(&handshake_hash(&state), &nonce);
                let send = write(
                    &mut state,
                    &message::encode(&ControllerHello {
                        hello,
                        commit: super::to_hex(&commit),
                    }),
                )?;
                let hash = handshake_hash(&state);
                let transport = state
                    .into_transport_mode()
                    .map_err(|_| Failure::new(CloseReason::Protocol))?;
                Ok((
                    Some(send),
                    Next::Continue(Self {
                        stage: ControllerStage::Committed {
                            channel: Channel::new(transport),
                            peer,
                            version,
                            hash,
                            nonce,
                        },
                        versions: self.versions,
                    }),
                ))
            }
            ControllerStage::Committed {
                mut channel,
                peer,
                version,
                hash,
                nonce,
            } => {
                let target_nonce = match open_message(&mut channel, frame)? {
                    Message::Nonce { nonce } => super::from_hex::<NONCE_LEN>(&nonce)
                        .ok_or_else(|| Failure::new(CloseReason::Protocol))?,
                    Message::Closed { reason } => return Err(Failure::new(reason)),
                    _ => return Err(Failure::new(CloseReason::Protocol)),
                };
                let reveal = channel
                    .seal(&Message::Reveal {
                        nonce: super::to_hex(&nonce),
                    })
                    .map_err(|_| Failure::new(CloseReason::Protocol))?;
                Ok((
                    Some(reveal),
                    Next::Done(Box::new(Established {
                        channel,
                        peer,
                        code: code(&hash, &nonce, &target_nonce),
                        version,
                    })),
                ))
            }
        }
    }
}

/// The target's side of the handshake.
pub struct TargetHandshake {
    stage: TargetStage,
}

enum TargetStage {
    /// Waiting for the controller's first message.
    Started {
        state: Box<snow::HandshakeState>,
        hello: Hello,
    },
    /// Sent its key and hello; waiting for the controller's.
    SentHello {
        state: Box<snow::HandshakeState>,
        versions: Vec<u32>,
    },
    /// Sent its nonce; waiting for the controller's.
    SentNonce {
        channel: Channel,
        peer: Peer,
        version: u32,
        hash: [u8; 32],
        /// The handshake hash the controller made its commitment over.
        committed_over: [u8; 32],
        commit: [u8; 32],
        nonce: [u8; NONCE_LEN],
    },
}

impl TargetHandshake {
    pub fn new(key: &DeviceKey, hello: Hello) -> Result<Self, Failure> {
        let state = builder(key)?
            .build_responder()
            .map_err(|_| Failure::new(CloseReason::Protocol))?;
        Ok(Self {
            stage: TargetStage::Started {
                state: Box::new(state),
                hello,
            },
        })
    }

    /// Reads the next frame. Lets in every controller the handshake proves,
    /// so code that takes connections from the network uses
    /// [`TargetHandshake::read_admitting`].
    pub fn read(self, frame: &[u8]) -> Step<Self> {
        self.read_admitting(frame, |_| Ok(()))
    }

    /// Reads the next frame. Once the handshake has proved who the
    /// controller is, and before the target sends its nonce, `admit` decides
    /// whether to go on. A refusal tells the controller why and fails the
    /// handshake with that reason. `admit` is called at most once.
    pub fn read_admitting(
        self,
        frame: &[u8],
        admit: impl FnOnce(&Peer) -> Result<(), CloseReason>,
    ) -> Step<Self> {
        match self.stage {
            TargetStage::Started { mut state, hello } => {
                read(&mut state, frame)?;
                let send = write(&mut state, &message::encode(&hello))?;
                Ok((
                    Some(send),
                    Next::Continue(Self {
                        stage: TargetStage::SentHello {
                            state,
                            versions: hello.versions,
                        },
                    }),
                ))
            }
            TargetStage::SentHello {
                mut state,
                versions,
            } => {
                let before = handshake_hash(&state);
                let payload = read(&mut state, frame)?;
                let controller: ControllerHello = message::decode_payload(&payload)
                    .map_err(|_| Failure::new(CloseReason::Protocol))?;
                let commit = super::from_hex::<32>(&controller.commit)
                    .ok_or_else(|| Failure::new(CloseReason::Protocol))?;
                let peer = peer_from(&state, &controller.hello)?;
                let hash = handshake_hash(&state);
                let mut channel = Channel::new(
                    state
                        .into_transport_mode()
                        .map_err(|_| Failure::new(CloseReason::Protocol))?,
                );
                let Some(version) = message::common_version(&versions, &controller.hello.versions)
                else {
                    return Err(refuse(&mut channel, CloseReason::Version));
                };
                admit(&peer).map_err(|reason| refuse(&mut channel, reason))?;
                let nonce = super::random_bytes::<NONCE_LEN>();
                let send = channel
                    .seal(&Message::Nonce {
                        nonce: super::to_hex(&nonce),
                    })
                    .map_err(|_| Failure::new(CloseReason::Protocol))?;
                Ok((
                    Some(send),
                    Next::Continue(Self {
                        stage: TargetStage::SentNonce {
                            channel,
                            peer,
                            version,
                            hash,
                            committed_over: before,
                            commit,
                            nonce,
                        },
                    }),
                ))
            }
            TargetStage::SentNonce {
                mut channel,
                peer,
                version,
                hash,
                committed_over,
                commit,
                nonce,
            } => {
                let controller_nonce = match open_message(&mut channel, frame)? {
                    Message::Reveal { nonce } => super::from_hex::<NONCE_LEN>(&nonce)
                        .ok_or_else(|| Failure::new(CloseReason::Protocol))?,
                    _ => return Err(Failure::new(CloseReason::Protocol)),
                };
                if commitment(&committed_over, &controller_nonce) != commit {
                    return Err(Failure::new(CloseReason::Protocol));
                }
                Ok((
                    None,
                    Next::Done(Box::new(Established {
                        channel,
                        peer,
                        code: code(&hash, &controller_nonce, &nonce),
                        version,
                    })),
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests;
