// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! DNS-SD on Linux with the `mdns-sd` crate. One daemon serves every browse
//! and advertisement. It shares port 5353 with Avahi when Avahi runs.

use super::{instance_name, DiscoveryError, Registration, Tracker, Txt};
use mdns_sd::{DaemonEvent, ServiceDaemon, ServiceEvent, ServiceInfo, TxtProperty};
use std::sync::{Mutex, MutexGuard};

/// The daemon while it runs. Its watcher clears this once the daemon's
/// thread has stopped, so the next browse or advertisement starts another.
static DAEMON: Mutex<Option<ServiceDaemon>> = Mutex::new(None);

fn slot() -> MutexGuard<'static, Option<ServiceDaemon>> {
    DAEMON.lock().unwrap_or_else(|e| e.into_inner())
}

/// The daemon, started on first use. When it can't start, the next call
/// tries again.
fn daemon() -> Result<ServiceDaemon, DiscoveryError> {
    let mut running = slot();
    if let Some(daemon) = &*running {
        return Ok(daemon.clone());
    }
    let daemon = start().map_err(|e| DiscoveryError(format!("couldn't start mDNS: {e}")))?;
    let watched = daemon.monitor().and_then(|events| {
        std::thread::Builder::new()
            .name("mdns monitor".into())
            .spawn(move || {
                watch(events);
                // The daemon's thread stopped, which closed the channel.
                *slot() = None;
            })
            .map_err(|e| mdns_sd::Error::Msg(e.to_string()))
    });
    if let Err(e) = watched {
        let _ = daemon.shutdown();
        return Err(DiscoveryError(format!("couldn't watch mDNS: {e}")));
    }
    *running = Some(daemon.clone());
    Ok(daemon)
}

/// The daemon for real use: every interface, on port 5353.
#[cfg(not(test))]
fn start() -> mdns_sd::Result<ServiceDaemon> {
    ServiceDaemon::new()
}

/// The daemon for the tests, which keeps to the loopback interface.
#[cfg(test)]
fn start() -> mdns_sd::Result<ServiceDaemon> {
    super::tests::loopback_daemon()
}

/// Logs the daemon's errors until it stops: the first as a warning, and
/// every one when debugging, since an error that keeps happening, such as an
/// interface that can't send, comes back on every packet. Returns how many
/// there were.
pub(super) fn watch(events: impl IntoIterator<Item = DaemonEvent>) -> usize {
    let mut first = true;
    let mut errors = 0;
    for event in events {
        if let DaemonEvent::Error(e) = event {
            errors += 1;
            if std::mem::take(&mut first) {
                tracing::warn!("[discovery] mDNS reported an error; the details are logged when debugging");
            }
            tracing::debug!("[discovery] mDNS error: {e}");
        }
    }
    errors
}

/// Whether the system refused the app local network access, which only
/// macOS does. Always false here.
pub fn local_network_denied() -> bool {
    false
}

fn domain(service_type: &str) -> String {
    format!("{service_type}.local.")
}

pub struct BrowseHandle {
    daemon: ServiceDaemon,
    service_type: String,
}

impl Drop for BrowseHandle {
    // mutants: skip FnValue: Without it mdns-sd keeps querying the network, which no test sees. The forwarding thread still ends at its next event, once the Browser is gone.
    fn drop(&mut self) {
        // The forwarding thread ends when the daemon reports SearchStopped.
        let _ = self.daemon.stop_browse(&domain(&self.service_type));
    }
}

pub fn browse(service_type: &str, mut tracker: Tracker) -> Result<BrowseHandle, DiscoveryError> {
    let daemon = daemon()?;
    let handle = BrowseHandle {
        daemon: daemon.clone(),
        service_type: service_type.to_owned(),
    };
    let receiver = daemon
        .browse(&domain(service_type))
        .map_err(|e| DiscoveryError(format!("couldn't browse {service_type}: {e}")))?;
    let service_type = service_type.to_owned();
    std::thread::Builder::new()
        .name(format!("mdns {service_type}"))
        .spawn(move || {
            while let Ok(event) = receiver.recv() {
                let open = match event {
                    ServiceEvent::ServiceResolved(service) => {
                        match instance_name(&service.fullname, &service_type) {
                            Some(instance) => tracker.resolved(
                                &instance,
                                &service.host,
                                service.addresses.iter().map(|a| a.to_ip_addr()),
                                service.port,
                                Txt::new(service.txt_properties.iter().map(|p| {
                                    (p.key().to_owned(), p.val().unwrap_or_default().to_vec())
                                })),
                            ),
                            None => true,
                        }
                    }
                    ServiceEvent::ServiceRemoved(_, fullname) => {
                        match instance_name(&fullname, &service_type) {
                            Some(instance) => tracker.removed(&instance),
                            None => true,
                        }
                    }
                    // mutants: skip MatchArm: mdns-sd drops its sender after SearchStopped, so recv fails next and the loop ends either way.
                    ServiceEvent::SearchStopped(_) => false,
                    _ => true,
                };
                if !open {
                    break;
                }
            }
        })
        .map_err(|e| DiscoveryError(format!("couldn't start the browse thread: {e}")))?;
    Ok(handle)
}

pub struct AdvertiseHandle {
    daemon: ServiceDaemon,
    fullname: String,
}

impl Drop for AdvertiseHandle {
    fn drop(&mut self) {
        // Sends the goodbye packet.
        let _ = self.daemon.unregister(&self.fullname);
    }
}

pub fn advertise(registration: &Registration) -> Result<AdvertiseHandle, DiscoveryError> {
    let daemon = daemon()?;
    let properties: Vec<TxtProperty> = registration
        .txt
        .entries()
        .iter()
        .map(|(k, v)| TxtProperty::from((k.as_str(), v.as_slice())))
        .collect();
    // No addresses: enable_addr_auto fills them in from the interfaces and
    // keeps them up to date as the network changes.
    let info = ServiceInfo::new(
        &domain(&registration.service_type),
        &registration.instance,
        &format!("{}.local.", registration.host_label),
        "",
        registration.port,
        properties,
    )
    .map_err(|e| DiscoveryError(format!("couldn't build the record: {e}")))?
    .enable_addr_auto();
    let fullname = info.get_fullname().to_owned();
    daemon
        .register(info)
        .map_err(|e| DiscoveryError(format!("couldn't advertise: {e}")))?;
    Ok(AdvertiseHandle { daemon, fullname })
}
