// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! DNS-SD on macOS through Bonjour's `dns_sd.h` in libSystem.
//!
//! One thread, started on first use, owns every `DNSServiceRef`. It waits in
//! `poll` on their sockets and on a pipe that wakes it for new commands, and
//! calls `DNSServiceProcessResult` for each socket that's ready. Every
//! callback runs inside that call on the same thread, so the state they
//! change lives in a thread-local and needs no lock.
//!
//! A browse reports instance names. For each one the thread keeps a
//! `DNSServiceResolve` running for its host, port and TXT, and a
//! `DNSServiceGetAddrInfo` for the host's addresses. Both are long-lived, so
//! a changed TXT or address comes through as it happens.

use super::{DiscoveryError, Registration, Tracker};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::os::fd::RawFd;
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

type DNSServiceRef = *mut c_void;
type DNSServiceFlags = u32;
type DNSServiceErrorType = i32;
type DNSServiceProtocol = u32;

const FLAGS_ADD: DNSServiceFlags = 0x2;
const PROTOCOL_IPV4: DNSServiceProtocol = 0x1;
const PROTOCOL_IPV6: DNSServiceProtocol = 0x2;
const NO_ERROR: DNSServiceErrorType = 0;

type BrowseReply = unsafe extern "C" fn(
    DNSServiceRef,
    DNSServiceFlags,
    u32,
    DNSServiceErrorType,
    *const c_char,
    *const c_char,
    *const c_char,
    *mut c_void,
);
type ResolveReply = unsafe extern "C" fn(
    DNSServiceRef,
    DNSServiceFlags,
    u32,
    DNSServiceErrorType,
    *const c_char,
    *const c_char,
    u16,
    u16,
    *const u8,
    *mut c_void,
);
type AddrInfoReply = unsafe extern "C" fn(
    DNSServiceRef,
    DNSServiceFlags,
    u32,
    DNSServiceErrorType,
    *const c_char,
    *const libc::sockaddr,
    u32,
    *mut c_void,
);
type RegisterReply = unsafe extern "C" fn(
    DNSServiceRef,
    DNSServiceFlags,
    DNSServiceErrorType,
    *const c_char,
    *const c_char,
    *const c_char,
    *mut c_void,
);

// libSystem, which every macOS binary links.
unsafe extern "C" {
    fn DNSServiceRefSockFD(sd: DNSServiceRef) -> c_int;
    fn DNSServiceProcessResult(sd: DNSServiceRef) -> DNSServiceErrorType;
    fn DNSServiceRefDeallocate(sd: DNSServiceRef);
    fn DNSServiceBrowse(
        sd: *mut DNSServiceRef,
        flags: DNSServiceFlags,
        interface: u32,
        regtype: *const c_char,
        domain: *const c_char,
        callback: BrowseReply,
        context: *mut c_void,
    ) -> DNSServiceErrorType;
    fn DNSServiceResolve(
        sd: *mut DNSServiceRef,
        flags: DNSServiceFlags,
        interface: u32,
        name: *const c_char,
        regtype: *const c_char,
        domain: *const c_char,
        callback: ResolveReply,
        context: *mut c_void,
    ) -> DNSServiceErrorType;
    fn DNSServiceGetAddrInfo(
        sd: *mut DNSServiceRef,
        flags: DNSServiceFlags,
        interface: u32,
        protocol: DNSServiceProtocol,
        hostname: *const c_char,
        callback: AddrInfoReply,
        context: *mut c_void,
    ) -> DNSServiceErrorType;
    fn DNSServiceRegister(
        sd: *mut DNSServiceRef,
        flags: DNSServiceFlags,
        interface: u32,
        name: *const c_char,
        regtype: *const c_char,
        domain: *const c_char,
        host: *const c_char,
        port: u16,
        txt_len: u16,
        txt: *const c_void,
        callback: RegisterReply,
        context: *mut c_void,
    ) -> DNSServiceErrorType;
}

/// How long to wait before starting a browse again after Bonjour failed it,
/// for example because mDNSResponder restarted.
const RETRY_AFTER: Duration = Duration::from_secs(5);

/// What a callback's context points at, so it can find its state.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Key {
    Browse(u64),
    Resolve(u64, String),
    Addr(u64, String),
    Register(u64),
}

/// A `DNSServiceRef` and the context its callbacks get.
struct Ref {
    sd: DNSServiceRef,
    key: *mut Key,
}

impl Ref {
    /// Runs one of the `DNSService*` calls that make a ref, with a new
    /// context for `key`.
    fn start(
        key: Key,
        make: impl FnOnce(*mut DNSServiceRef, *mut c_void) -> DNSServiceErrorType,
    ) -> Result<Self, DNSServiceErrorType> {
        let key = Box::into_raw(Box::new(key));
        let mut sd: DNSServiceRef = std::ptr::null_mut();
        let err = make(&mut sd, key.cast());
        if err != NO_ERROR || sd.is_null() {
            // SAFETY: `key` came from Box::into_raw above, and Bonjour made
            // no ref that could still use it.
            drop(unsafe { Box::from_raw(key) });
            return Err(err);
        }
        Ok(Self { sd, key })
    }

    fn fd(&self) -> RawFd {
        // SAFETY: `sd` is a live ref until this Ref is dropped.
        unsafe { DNSServiceRefSockFD(self.sd) }
    }
}

impl Drop for Ref {
    fn drop(&mut self) {
        // SAFETY: `sd` is live and dropped only here. Deallocating it means
        // no callback can run with `key` any more, so the box can go too.
        unsafe {
            DNSServiceRefDeallocate(self.sd);
            drop(Box::from_raw(self.key));
        }
    }
}

struct Instance {
    interfaces: HashSet<u32>,
    resolve: Option<Ref>,
    host: Option<String>,
    port: u16,
    txt: super::Txt,
    addr: Option<Ref>,
    addrs: HashSet<IpAddr>,
}

struct Browse {
    service_type: CString,
    sd: Option<Ref>,
    retry_at: Option<Instant>,
    tracker: Tracker,
    instances: HashMap<String, Instance>,
}

#[derive(Default)]
struct State {
    browses: HashMap<u64, Browse>,
    adverts: HashMap<u64, Ref>,
    /// Refs to deallocate once the current callback has returned, since a
    /// ref can't be freed from inside its own callback.
    dead: Vec<Ref>,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::default();
}

enum Command {
    Browse {
        id: u64,
        service_type: String,
        tracker: Tracker,
        reply: mpsc::Sender<Result<(), DiscoveryError>>,
    },
    StopBrowse(u64),
    Register {
        id: u64,
        registration: Registration,
        reply: mpsc::Sender<Result<(), DiscoveryError>>,
    },
    Unregister(u64),
}

struct Thread {
    commands: mpsc::Sender<Command>,
    wake: RawFd,
    next_id: u64,
}

fn thread() -> Result<&'static Mutex<Thread>, DiscoveryError> {
    static THREAD: OnceLock<Result<Mutex<Thread>, DiscoveryError>> = OnceLock::new();
    THREAD
        .get_or_init(|| {
            let mut fds = [0 as c_int; 2];
            // SAFETY: `fds` has room for the two descriptors pipe writes.
            if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
                return Err(DiscoveryError("couldn't make a pipe for Bonjour".into()));
            }
            let [read, write] = fds;
            // SAFETY: both are descriptors this function just made.
            unsafe {
                libc::fcntl(read, libc::F_SETFL, libc::O_NONBLOCK);
                libc::fcntl(write, libc::F_SETFL, libc::O_NONBLOCK);
            }
            let (commands, inbox) = mpsc::channel();
            std::thread::Builder::new()
                .name("bonjour".into())
                .spawn(move || run(read, inbox))
                .map_err(|e| DiscoveryError(format!("couldn't start the Bonjour thread: {e}")))?;
            Ok(Mutex::new(Thread {
                commands,
                wake: write,
                next_id: 0,
            }))
        })
        .as_ref()
        .map_err(Clone::clone)
}

/// Sends a command to the Bonjour thread and wakes it. Returns its id.
fn send(make: impl FnOnce(u64) -> Command) -> Result<u64, DiscoveryError> {
    let mut thread = thread()?.lock().unwrap_or_else(|e| e.into_inner());
    thread.next_id += 1;
    let id = thread.next_id;
    thread
        .commands
        .send(make(id))
        .map_err(|_| DiscoveryError("the Bonjour thread stopped".into()))?;
    // SAFETY: `wake` is the pipe's write end, open for the process's life.
    // A full pipe already means a wake is pending, so a failed write is fine.
    unsafe { libc::write(thread.wake, [1u8].as_ptr().cast(), 1) };
    Ok(id)
}

fn wait_reply(reply: mpsc::Receiver<Result<(), DiscoveryError>>) -> Result<(), DiscoveryError> {
    reply
        .recv()
        .map_err(|_| DiscoveryError("the Bonjour thread stopped".into()))?
}

pub struct BrowseHandle(u64);

impl Drop for BrowseHandle {
    fn drop(&mut self) {
        let id = self.0;
        let _ = send(|_| Command::StopBrowse(id));
    }
}

pub fn browse(service_type: &str, tracker: Tracker) -> Result<BrowseHandle, DiscoveryError> {
    let (reply, answer) = mpsc::channel();
    let service_type = service_type.to_owned();
    let id = send(|id| Command::Browse {
        id,
        service_type,
        tracker,
        reply,
    })?;
    let handle = BrowseHandle(id);
    wait_reply(answer)?;
    Ok(handle)
}

pub struct AdvertiseHandle(u64);

impl Drop for AdvertiseHandle {
    fn drop(&mut self) {
        let id = self.0;
        let _ = send(|_| Command::Unregister(id));
    }
}

pub fn advertise(registration: &Registration) -> Result<AdvertiseHandle, DiscoveryError> {
    let (reply, answer) = mpsc::channel();
    let registration = registration.clone();
    let id = send(|id| Command::Register {
        id,
        registration,
        reply,
    })?;
    let handle = AdvertiseHandle(id);
    wait_reply(answer)?;
    Ok(handle)
}

/// The Bonjour thread.
fn run(wake: RawFd, inbox: mpsc::Receiver<Command>) {
    loop {
        // Drain the wake pipe, then every command waiting.
        let mut buf = [0u8; 64];
        // SAFETY: `wake` is the pipe's read end, non-blocking, and `buf` is
        // large enough for what's asked.
        while unsafe { libc::read(wake, buf.as_mut_ptr().cast(), buf.len()) } > 0 {}
        while let Ok(command) = inbox.try_recv() {
            handle(command);
        }
        retry_browses();

        let (mut fds, timeout) = STATE.with_borrow(|state| {
            let mut fds = vec![libc::pollfd {
                fd: wake,
                events: libc::POLLIN,
                revents: 0,
            }];
            for r in live_refs(state) {
                fds.push(libc::pollfd {
                    fd: r.fd(),
                    events: libc::POLLIN,
                    revents: 0,
                });
            }
            let timeout = state
                .browses
                .values()
                .filter_map(|b| b.retry_at)
                .min()
                .map_or(-1, |at| {
                    let ms = at.saturating_duration_since(Instant::now()).as_millis();
                    c_int::try_from(ms).unwrap_or(c_int::MAX)
                });
            (fds, timeout)
        });
        // SAFETY: `fds` is a valid array of pollfd of the length given.
        let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) };
        if ready <= 0 {
            continue;
        }
        for pfd in &fds[1..] {
            if pfd.revents == 0 {
                continue;
            }
            process(pfd.fd);
            STATE.with_borrow_mut(|state| state.dead.clear());
        }
    }
}

/// Every ref whose socket the thread waits on.
fn live_refs(state: &State) -> impl Iterator<Item = &Ref> {
    let browses = state.browses.values().flat_map(|b| {
        b.sd.iter().chain(
            b.instances
                .values()
                .flat_map(|i| i.resolve.iter().chain(i.addr.iter())),
        )
    });
    browses.chain(state.adverts.values())
}

/// Calls `DNSServiceProcessResult` for the ref with this socket, if it's
/// still live. No borrow of the state is held across the call, since the
/// callbacks borrow it.
fn process(fd: RawFd) {
    let found = STATE.with_borrow(|state| {
        live_refs(state)
            .find(|r| r.fd() == fd)
            // SAFETY: the key lives as long as the ref does.
            .map(|r| (r.sd, unsafe { (*r.key).clone() }))
    });
    let Some((sd, key)) = found else {
        return;
    };
    // A callback before this one may have freed a ref and made one that got
    // the same descriptor, which isn't ready. ProcessResult would block on
    // it, so check it's readable first.
    let mut check = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: one valid pollfd, and no wait.
    if unsafe { libc::poll(&mut check, 1, 0) } <= 0 {
        return;
    }
    // SAFETY: `sd` is live: refs are only freed outside this call, from
    // `dead`, or by a command, which runs between polls.
    let err = unsafe { DNSServiceProcessResult(sd) };
    if err != NO_ERROR {
        failed(&key, err);
    }
}

fn handle(command: Command) {
    match command {
        Command::Browse {
            id,
            service_type,
            tracker,
            reply,
        } => {
            let result = CString::new(service_type)
                .map_err(|_| DiscoveryError("the service type has a NUL byte".into()))
                .and_then(|service_type| {
                    let sd = start_browse(id, &service_type)?;
                    STATE.with_borrow_mut(|state| {
                        state.browses.insert(
                            id,
                            Browse {
                                service_type,
                                sd: Some(sd),
                                retry_at: None,
                                tracker,
                                instances: HashMap::new(),
                            },
                        )
                    });
                    Ok(())
                });
            let _ = reply.send(result);
        }
        Command::StopBrowse(id) => {
            STATE.with_borrow_mut(|state| state.browses.remove(&id));
        }
        Command::Register {
            id,
            registration,
            reply,
        } => {
            let result = start_register(id, &registration).map(|sd| {
                STATE.with_borrow_mut(|state| state.adverts.insert(id, sd));
            });
            let _ = reply.send(result);
        }
        Command::Unregister(id) => {
            // Deallocating the ref withdraws the record with a goodbye.
            STATE.with_borrow_mut(|state| state.adverts.remove(&id));
        }
    }
}

fn start_browse(id: u64, service_type: &CStr) -> Result<Ref, DiscoveryError> {
    Ref::start(Key::Browse(id), |sd, ctx| {
        // SAFETY: the strings outlive the call, and `ctx` outlives the ref.
        unsafe {
            DNSServiceBrowse(
                sd,
                0,
                0,
                service_type.as_ptr(),
                std::ptr::null(),
                on_browse,
                ctx,
            )
        }
    })
    .map_err(|e| DiscoveryError(format!("Bonjour couldn't browse: error {e}")))
}

fn start_register(id: u64, registration: &Registration) -> Result<Ref, DiscoveryError> {
    let name = CString::new(registration.instance.as_str())
        .map_err(|_| DiscoveryError("the instance name has a NUL byte".into()))?;
    let regtype = CString::new(registration.service_type.as_str())
        .map_err(|_| DiscoveryError("the service type has a NUL byte".into()))?;
    let txt = registration.txt.encode()?;
    let txt_len = u16::try_from(txt.len())
        .map_err(|_| DiscoveryError("the TXT record is too long".into()))?;
    Ref::start(Key::Register(id), |sd, ctx| {
        // SAFETY: the strings and the TXT bytes outlive the call, which
        // copies them, and `ctx` outlives the ref. A NULL host is the Mac's
        // own Bonjour host name; the port goes in network byte order.
        unsafe {
            DNSServiceRegister(
                sd,
                0,
                0,
                name.as_ptr(),
                regtype.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                registration.port.to_be(),
                txt_len,
                txt.as_ptr().cast(),
                on_register,
                ctx,
            )
        }
    })
    .map_err(|e| DiscoveryError(format!("Bonjour couldn't advertise: error {e}")))
}

/// Something Bonjour reported failed. A browse is dropped and started again
/// after [`RETRY_AFTER`]; its instances are reported removed. A failed
/// resolve or address lookup drops just that one, until the browse sees the
/// instance again.
fn failed(key: &Key, err: DNSServiceErrorType) {
    tracing::warn!("[discovery] Bonjour error {err} for {key:?}");
    STATE.with_borrow_mut(|state| match key {
        Key::Browse(id) => {
            if let Some(browse) = state.browses.get_mut(id) {
                if let Some(sd) = browse.sd.take() {
                    state.dead.push(sd);
                }
                for (name, instance) in browse.instances.drain() {
                    state.dead.extend(instance.resolve);
                    state.dead.extend(instance.addr);
                    browse.tracker.removed(&name);
                }
                browse.retry_at = Some(Instant::now() + RETRY_AFTER);
            }
        }
        Key::Resolve(id, name) | Key::Addr(id, name) => {
            if let Some(instance) = state
                .browses
                .get_mut(id)
                .and_then(|b| b.instances.get_mut(name))
            {
                state.dead.extend(instance.resolve.take());
                state.dead.extend(instance.addr.take());
            }
        }
        Key::Register(id) => {
            state.adverts.remove(id);
        }
    });
}

fn retry_browses() {
    let now = Instant::now();
    let due: Vec<(u64, CString)> = STATE.with_borrow(|state| {
        state
            .browses
            .iter()
            .filter(|(_, b)| b.retry_at.is_some_and(|at| at <= now))
            .map(|(&id, b)| (id, b.service_type.clone()))
            .collect()
    });
    for (id, service_type) in due {
        let started = start_browse(id, &service_type);
        STATE.with_borrow_mut(|state| {
            if let Some(browse) = state.browses.get_mut(&id) {
                match started {
                    Ok(sd) => {
                        browse.sd = Some(sd);
                        browse.retry_at = None;
                    }
                    Err(_) => browse.retry_at = Some(now + RETRY_AFTER),
                }
            }
        });
    }
}

/// Reads the `Key` a callback's context points at.
///
/// # Safety
///
/// `context` must be the key of a live [`Ref`].
unsafe fn key<'a>(context: *mut c_void) -> &'a Key {
    // SAFETY: as the caller promises.
    unsafe { &*context.cast::<Key>() }
}

/// # Safety
///
/// `text` is NULL or a NUL-terminated string.
unsafe fn text(text: *const c_char) -> Option<String> {
    // SAFETY: as the caller promises.
    (!text.is_null()).then(|| {
        unsafe { CStr::from_ptr(text) }
            .to_string_lossy()
            .into_owned()
    })
}

unsafe extern "C" fn on_browse(
    _sd: DNSServiceRef,
    flags: DNSServiceFlags,
    interface: u32,
    err: DNSServiceErrorType,
    name: *const c_char,
    regtype: *const c_char,
    domain: *const c_char,
    context: *mut c_void,
) {
    // SAFETY: Bonjour passes back the context of a live browse ref.
    let key = unsafe { key(context) }.clone();
    let Key::Browse(id) = key else { return };
    if err != NO_ERROR {
        failed(&key, err);
        return;
    }
    // SAFETY: Bonjour passes NUL-terminated strings.
    let Some(instance) = (unsafe { text(name) }) else {
        return;
    };
    let added = flags & FLAGS_ADD != 0;
    STATE.with_borrow_mut(|state| {
        let State { browses, dead, .. } = state;
        let Some(browse) = browses.get_mut(&id) else {
            return;
        };
        if added {
            let entry = browse
                .instances
                .entry(instance.clone())
                .or_insert_with(|| Instance {
                    interfaces: HashSet::new(),
                    resolve: None,
                    host: None,
                    port: 0,
                    txt: super::Txt::default(),
                    addr: None,
                    addrs: HashSet::new(),
                });
            entry.interfaces.insert(interface);
            if entry.resolve.is_none() {
                let resolve_key = Key::Resolve(id, instance.clone());
                entry.resolve = Ref::start(resolve_key, |sd, ctx| {
                    // SAFETY: the strings come from this callback and outlive
                    // the call, which copies them; `ctx` outlives the ref.
                    // Interface 0 resolves on every interface at once.
                    unsafe { DNSServiceResolve(sd, 0, 0, name, regtype, domain, on_resolve, ctx) }
                })
                .ok();
            }
        } else if let Some(entry) = browse.instances.get_mut(&instance) {
            entry.interfaces.remove(&interface);
            if entry.interfaces.is_empty() {
                if let Some(gone) = browse.instances.remove(&instance) {
                    dead.extend(gone.resolve);
                    dead.extend(gone.addr);
                }
                browse.tracker.removed(&instance);
            }
        }
    });
}

unsafe extern "C" fn on_resolve(
    _sd: DNSServiceRef,
    _flags: DNSServiceFlags,
    _interface: u32,
    err: DNSServiceErrorType,
    _fullname: *const c_char,
    host: *const c_char,
    port: u16,
    txt_len: u16,
    txt: *const u8,
    context: *mut c_void,
) {
    // SAFETY: Bonjour passes back the context of a live resolve ref.
    let key = unsafe { key(context) }.clone();
    let Key::Resolve(id, ref instance) = key else {
        return;
    };
    if err != NO_ERROR {
        failed(&key, err);
        return;
    }
    // SAFETY: Bonjour passes a NUL-terminated host name.
    let Some(host_name) = (unsafe { text(host) }) else {
        return;
    };
    let txt = if txt.is_null() {
        super::Txt::default()
    } else {
        // SAFETY: Bonjour passes `txt_len` bytes at `txt`.
        super::Txt::parse(unsafe { std::slice::from_raw_parts(txt, usize::from(txt_len)) })
    };
    STATE.with_borrow_mut(|state| {
        let State { browses, dead, .. } = state;
        let Some(browse) = browses.get_mut(&id) else {
            return;
        };
        let Some(entry) = browse.instances.get_mut(instance) else {
            return;
        };
        entry.port = u16::from_be(port);
        entry.txt = txt;
        if entry.host.as_deref() != Some(host_name.as_str()) {
            entry.host = Some(host_name.clone());
            entry.addrs.clear();
            dead.extend(entry.addr.take());
            if let Ok(c_host) = CString::new(host_name) {
                let addr_key = Key::Addr(id, instance.clone());
                entry.addr = Ref::start(addr_key, |sd, ctx| {
                    // SAFETY: `c_host` outlives the call, which copies it;
                    // `ctx` outlives the ref.
                    unsafe {
                        DNSServiceGetAddrInfo(
                            sd,
                            0,
                            0,
                            PROTOCOL_IPV4 | PROTOCOL_IPV6,
                            c_host.as_ptr(),
                            on_addr,
                            ctx,
                        )
                    }
                })
                .ok();
            }
        }
        report(browse, instance);
    });
}

unsafe extern "C" fn on_addr(
    _sd: DNSServiceRef,
    flags: DNSServiceFlags,
    _interface: u32,
    err: DNSServiceErrorType,
    _host: *const c_char,
    address: *const libc::sockaddr,
    _ttl: u32,
    context: *mut c_void,
) {
    // SAFETY: Bonjour passes back the context of a live address ref.
    let key = unsafe { key(context) }.clone();
    let Key::Addr(id, ref instance) = key else {
        return;
    };
    if err != NO_ERROR {
        failed(&key, err);
        return;
    }
    // SAFETY: Bonjour passes a sockaddr of the family it names, or NULL.
    let Some(addr) = (unsafe { ip(address) }) else {
        return;
    };
    STATE.with_borrow_mut(|state| {
        let Some(browse) = state.browses.get_mut(&id) else {
            return;
        };
        let Some(entry) = browse.instances.get_mut(instance) else {
            return;
        };
        if flags & FLAGS_ADD != 0 {
            entry.addrs.insert(addr);
        } else {
            entry.addrs.remove(&addr);
        }
        report(browse, instance);
    });
}

unsafe extern "C" fn on_register(
    _sd: DNSServiceRef,
    _flags: DNSServiceFlags,
    err: DNSServiceErrorType,
    name: *const c_char,
    _regtype: *const c_char,
    _domain: *const c_char,
    context: *mut c_void,
) {
    // SAFETY: Bonjour passes back the context of a live register ref.
    let key = unsafe { key(context) }.clone();
    if err != NO_ERROR {
        failed(&key, err);
        return;
    }
    // SAFETY: Bonjour passes a NUL-terminated name.
    if let Some(name) = unsafe { text(name) } {
        tracing::info!("[discovery] advertising as {name:?}");
    }
}

/// Tells the tracker what's known of an instance now.
fn report(browse: &mut Browse, instance: &str) {
    let Some(entry) = browse.instances.get(instance) else {
        return;
    };
    let Some(host) = &entry.host else {
        return;
    };
    browse.tracker.resolved(
        instance,
        host,
        entry.addrs.iter().copied(),
        entry.port,
        entry.txt.clone(),
    );
}

/// The address in a `sockaddr` from Bonjour.
///
/// # Safety
///
/// `address` is NULL, or points at a `sockaddr_in` or `sockaddr_in6` as its
/// family says.
unsafe fn ip(address: *const libc::sockaddr) -> Option<IpAddr> {
    if address.is_null() {
        return None;
    }
    // SAFETY: as the caller promises.
    unsafe {
        match c_int::from((*address).sa_family) {
            libc::AF_INET => {
                let v4 = &*address.cast::<libc::sockaddr_in>();
                Some(IpAddr::V4(Ipv4Addr::from(u32::from_be(v4.sin_addr.s_addr))))
            }
            libc::AF_INET6 => {
                let v6 = &*address.cast::<libc::sockaddr_in6>();
                Some(IpAddr::V6(Ipv6Addr::from(v6.sin6_addr.s6_addr)))
            }
            _ => None,
        }
    }
}
