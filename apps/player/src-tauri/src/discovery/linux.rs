// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! DNS-SD on Linux with the `mdns-sd` crate. One daemon serves every browse
//! and advertisement. It shares port 5353 with Avahi when Avahi runs.

use super::{instance_name, DiscoveryError, Registration, Tracker, Txt};
use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo, TxtProperty};
use std::sync::OnceLock;

/// The daemon, started on first use. `None` when it couldn't start.
fn daemon() -> Result<ServiceDaemon, DiscoveryError> {
    static DAEMON: OnceLock<Result<ServiceDaemon, DiscoveryError>> = OnceLock::new();
    DAEMON
        .get_or_init(|| {
            ServiceDaemon::new().map_err(|e| DiscoveryError(format!("couldn't start mDNS: {e}")))
        })
        .clone()
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
