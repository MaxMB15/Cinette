// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! DNS-SD on the local network: browsing for a service type and advertising
//! one, on macOS, Linux and Android.
//!
//! macOS uses Bonjour through `dns_sd.h` in libSystem. Linux and Android use
//! the `mdns-sd` crate, which needs no Avahi daemon and runs beside one. Both
//! give the same [`Event`]s, so callers don't know which one runs.
//!
//! Nothing is advertised until [`advertise`] is called, and dropping the
//! [`Advertisement`] withdraws it. Several browses of different service types
//! can run at once.

// The macOS backend's decisions, which the tests on Linux check too.
#[cfg(any(target_os = "macos", test))]
mod bonjour;
#[cfg(any(target_os = "linux", target_os = "android"))]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(any(target_os = "linux", target_os = "android"))]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::net::IpAddr;
use std::sync::{Mutex, MutexGuard, OnceLock};
use tokio::sync::mpsc;

/// Something a browse found out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// A service instance was found, or its address, port or TXT changed.
    Found {
        instance: String,
        /// The host name from the SRV record, such as `living-room.local.`.
        host: String,
        /// IPv4 addresses first, then IPv6, each in order.
        addrs: Vec<IpAddr>,
        port: u16,
        txt: Txt,
    },
    /// The instance said goodbye, or its record expired.
    Removed { instance: String },
}

/// A TXT record's entries. Keys are matched without regard to case, as
/// RFC 6763 section 6.4 says. Values are raw bytes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Txt(Vec<(String, Vec<u8>)>);

impl Txt {
    /// Builds it from entries, keeping the first of any repeated key, as
    /// RFC 6763 section 6.4 says. A key with no `=` has an empty value.
    pub fn new<K: AsRef<str>, V: AsRef<[u8]>>(entries: impl IntoIterator<Item = (K, V)>) -> Self {
        let mut out: Vec<(String, Vec<u8>)> = Vec::new();
        for (key, value) in entries {
            let key = key.as_ref().to_ascii_lowercase();
            if key.is_empty() || out.iter().any(|(k, _)| *k == key) {
                continue;
            }
            out.push((key, value.as_ref().to_vec()));
        }
        Self(out)
    }

    /// Reads a TXT record in wire format: each entry is a length byte, then
    /// `key=value`. An entry that runs past the end is dropped.
    pub fn parse(mut bytes: &[u8]) -> Self {
        let mut entries = Vec::new();
        while let Some((&len, rest)) = bytes.split_first() {
            let len = usize::from(len);
            if rest.len() < len {
                break;
            }
            let (entry, rest) = rest.split_at(len);
            bytes = rest;
            let (key, value) = match entry.iter().position(|&b| b == b'=') {
                Some(eq) => (&entry[..eq], &entry[eq + 1..]),
                None => (entry, &[][..]),
            };
            if let Ok(key) = std::str::from_utf8(key) {
                entries.push((key.to_owned(), value.to_vec()));
            }
        }
        Self::new(entries)
    }

    /// The TXT record in wire format. Entries longer than 255 bytes, and keys
    /// that aren't printable ASCII without `=`, are refused.
    pub fn encode(&self) -> Result<Vec<u8>, DiscoveryError> {
        let mut out = Vec::new();
        for (key, value) in &self.0 {
            if !key.bytes().all(|b| (0x20..=0x7e).contains(&b) && b != b'=') {
                return Err(DiscoveryError(format!("TXT key {key:?} isn't allowed")));
            }
            let len = key.len() + 1 + value.len();
            let len = u8::try_from(len)
                .map_err(|_| DiscoveryError(format!("TXT entry {key:?} is {len} bytes")))?;
            out.push(len);
            out.extend_from_slice(key.as_bytes());
            out.push(b'=');
            out.extend_from_slice(value);
        }
        Ok(out)
    }

    /// The value of `key`, matched without regard to case.
    pub fn get(&self, key: &str) -> Option<&[u8]> {
        self.0
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.as_slice())
    }

    /// The value of `key` as UTF-8 text, if it is.
    pub fn get_str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(|v| std::str::from_utf8(v).ok())
    }

    /// The entries, with lowercase keys, in the order they came.
    pub fn entries(&self) -> &[(String, Vec<u8>)] {
        &self.0
    }
}

/// Discovery couldn't start, or a record couldn't be built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryError(pub String);

impl fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for DiscoveryError {}

// Whether macOS refused the app local network access. Each platform's
// function has the details.
pub use platform::local_network_denied;

/// A running browse. Dropping it stops the browse.
pub struct Browser {
    events: mpsc::UnboundedReceiver<Event>,
    // Stops the platform's browse before the type is let go.
    _handle: platform::BrowseHandle,
    _guard: BrowseGuard,
}

/// The service types being browsed, so a second browse of one is refused
/// rather than taking over the first one's events.
fn browsing() -> MutexGuard<'static, HashSet<String>> {
    static BROWSING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    // The set stays whole even if a thread panicked holding it.
    BROWSING
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Holds a service type in [`browsing`] until it's dropped.
struct BrowseGuard(String);

impl BrowseGuard {
    fn take(service_type: &str) -> Result<Self, DiscoveryError> {
        if browsing().insert(service_type.to_owned()) {
            Ok(Self(service_type.to_owned()))
        } else {
            Err(DiscoveryError(format!(
                "{service_type} is already being browsed"
            )))
        }
    }
}

impl Drop for BrowseGuard {
    fn drop(&mut self) {
        browsing().remove(&self.0);
    }
}

impl Browser {
    /// The next event, or `None` once discovery stopped for good.
    pub async fn next(&mut self) -> Option<Event> {
        self.events.recv().await
    }
}

/// Starts browsing `service_type`, such as `_cinette._tcp` or
/// `_googlecast._tcp`. Only one browse of a type runs at a time; a second one
/// fails while the first is alive.
pub fn browse(service_type: &str) -> Result<Browser, DiscoveryError> {
    check_service_type(service_type)?;
    let guard = BrowseGuard::take(service_type)?;
    let (tx, events) = mpsc::unbounded_channel();
    let handle = platform::browse(service_type, Tracker::new(tx))?;
    Ok(Browser {
        events,
        _handle: handle,
        _guard: guard,
    })
}

/// What to advertise.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Registration {
    /// Such as `_cinette._tcp`.
    pub service_type: String,
    /// The instance name others see. Bonjour and mdns-sd rename it if
    /// another device on the network already has it.
    pub instance: String,
    /// The host label for the SRV record on Linux, such as a device id, so
    /// the machine's own host name, which often has the owner's name in it,
    /// isn't published. macOS always uses the Mac's Bonjour host name, which
    /// it advertises anyway.
    pub host_label: String,
    pub port: u16,
    pub txt: Txt,
}

/// An advertised service. Dropping it withdraws the record with a goodbye.
pub struct Advertisement {
    _handle: platform::AdvertiseHandle,
}

/// Starts advertising a service.
pub fn advertise(registration: &Registration) -> Result<Advertisement, DiscoveryError> {
    check_registration(registration)?;
    Ok(Advertisement {
        _handle: platform::advertise(registration)?,
    })
}

/// Refuses a record either platform would refuse, so both refuse the same.
fn check_registration(registration: &Registration) -> Result<(), DiscoveryError> {
    check_service_type(&registration.service_type)?;
    if registration.instance.is_empty() || registration.instance.len() > 63 {
        return Err(DiscoveryError(
            "the instance name must be 1 to 63 bytes".into(),
        ));
    }
    let label_ok = !registration.host_label.is_empty()
        && registration.host_label.len() <= 63
        && registration
            .host_label
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-');
    if !label_ok {
        return Err(DiscoveryError(format!(
            "host label {:?} isn't a DNS label",
            registration.host_label
        )));
    }
    registration.txt.encode().map(drop)
}

/// A service type is `_name._tcp` or `_name._udp`.
fn check_service_type(service_type: &str) -> Result<(), DiscoveryError> {
    let ok = service_type
        .strip_suffix("._tcp")
        .or_else(|| service_type.strip_suffix("._udp"))
        .and_then(|name| name.strip_prefix('_'))
        .is_some_and(|name| {
            (1..=15).contains(&name.len())
                && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        });
    if ok {
        Ok(())
    } else {
        Err(DiscoveryError(format!(
            "{service_type:?} isn't a service type like _name._tcp"
        )))
    }
}

/// One instance as last reported.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Seen {
    host: String,
    addrs: Vec<IpAddr>,
    port: u16,
    txt: Txt,
}

/// The most instances one browse keeps track of. Anything on the network can
/// advertise, so this stops a flood of made-up instances from using up
/// memory or, on macOS, Bonjour operations.
pub(crate) const MAX_INSTANCES: usize = 256;

/// Turns what a platform hears into [`Event`]s: a `Found` only when
/// something changed, and a `Removed` only for an instance that was found.
pub(crate) struct Tracker {
    tx: mpsc::UnboundedSender<Event>,
    seen: HashMap<String, Seen>,
    /// A new instance was turned away for want of room.
    full: bool,
}

impl Tracker {
    fn new(tx: mpsc::UnboundedSender<Event>) -> Self {
        Self {
            tx,
            seen: HashMap::new(),
            full: false,
        }
    }

    /// Whether a browse that keeps track of `count` instances may take on
    /// another, which it may below [`MAX_INSTANCES`]. The first time it may
    /// not is logged.
    pub(crate) fn has_room(&mut self, count: usize) -> bool {
        let room = count < MAX_INSTANCES;
        if !room && !self.full {
            self.full = true;
            tracing::warn!(
                "[discovery] a browse found more than {MAX_INSTANCES} instances and ignores the rest"
            );
        }
        room
    }

    /// An instance resolved. One with no address yet isn't reported, since
    /// nothing could connect to it, and nor is a new one past
    /// [`MAX_INSTANCES`]. Returns false once the browser is gone.
    pub(crate) fn resolved(
        &mut self,
        instance: &str,
        host: &str,
        addrs: impl IntoIterator<Item = IpAddr>,
        port: u16,
        txt: Txt,
    ) -> bool {
        // A link-local IPv6 address can't be dialed without its interface,
        // which an IpAddr doesn't carry.
        let mut addrs: Vec<IpAddr> = addrs
            .into_iter()
            .filter(|a| !matches!(a, IpAddr::V6(v6) if v6.is_unicast_link_local()))
            .collect();
        addrs.sort_by_key(|a| (a.is_ipv6(), *a));
        addrs.dedup();
        if addrs.is_empty() {
            return !self.tx.is_closed();
        }
        let seen = Seen {
            host: host.to_owned(),
            addrs,
            port,
            txt,
        };
        let known = match self.seen.get(instance) {
            Some(last) if *last == seen => return !self.tx.is_closed(),
            last => last.is_some(),
        };
        if !known && !self.has_room(self.seen.len()) {
            return !self.tx.is_closed();
        }
        self.seen.insert(instance.to_owned(), seen.clone());
        self.tx
            .send(Event::Found {
                instance: instance.to_owned(),
                host: seen.host,
                addrs: seen.addrs,
                port: seen.port,
                txt: seen.txt,
            })
            .is_ok()
    }

    /// An instance went away. Returns false once the browser is gone.
    pub(crate) fn removed(&mut self, instance: &str) -> bool {
        if self.seen.remove(instance).is_none() {
            return !self.tx.is_closed();
        }
        self.tx
            .send(Event::Removed {
                instance: instance.to_owned(),
            })
            .is_ok()
    }

    /// Whether the browser has been dropped.
    #[cfg(test)]
    pub(crate) fn is_closed(&self) -> bool {
        self.tx.is_closed()
    }
}

/// The instance name in a full service name such as
/// `Living\032Room._cinette._tcp.local.`, with DNS escapes undone: `\.`,
/// `\\` and `\DDD`.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub(crate) fn instance_name(fullname: &str, service_type: &str) -> Option<String> {
    let suffix = format!(".{service_type}.local.");
    let escaped = fullname.strip_suffix(&suffix)?;
    let mut bytes = Vec::with_capacity(escaped.len());
    let mut rest = escaped.as_bytes();
    while let Some((&b, tail)) = rest.split_first() {
        if b != b'\\' {
            bytes.push(b);
            rest = tail;
            continue;
        }
        match tail {
            [d1, d2, d3, more @ ..] if [d1, d2, d3].iter().all(|d| d.is_ascii_digit()) => {
                let value =
                    u32::from(d1 - b'0') * 100 + u32::from(d2 - b'0') * 10 + u32::from(d3 - b'0');
                bytes.push(u8::try_from(value).ok()?);
                rest = more;
            }
            [c, more @ ..] => {
                bytes.push(*c);
                rest = more;
            }
            [] => return None,
        }
    }
    let name = String::from_utf8(bytes).ok()?;
    (!name.is_empty()).then_some(name)
}
