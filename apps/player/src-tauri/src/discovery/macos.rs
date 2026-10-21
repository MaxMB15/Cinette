// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! DNS-SD on macOS and iOS through Bonjour's `dns_sd.h` in libSystem. On
//! iOS it needs the service types in `NSBonjourServices`.
//!
//! One thread, started on first use, owns every `DNSServiceRef`. They all
//! share one connection to mDNSResponder, made with
//! `DNSServiceCreateConnection`, so the app holds one socket however many
//! instances a browse finds. The thread waits in `poll` on that socket and on
//! a pipe that wakes it for new commands, and calls `DNSServiceProcessResult`
//! when the socket is ready. Every callback runs inside that call on the same
//! thread, so the state they change lives in a thread-local and needs no
//! lock.
//!
//! A browse reports instance names. For each one the thread runs a
//! `DNSServiceResolve` for its host, port and TXT, and stops it once it
//! answers, as `dns_sd.h` advises. Queries for the instance's TXT and SRV
//! records keep running, so a changed TXT comes through as it happens and a
//! changed host or port starts a new resolve. A `DNSServiceGetAddrInfo`
//! follows the host's addresses.
//!
//! Whatever Bonjour fails is started again after [`RETRY_AFTER`]. When the
//! connection breaks, as when mDNSResponder restarts, everything starts again
//! on a new one. A refusal of local network access is retried the same way,
//! since the user can allow it at any time, and [`local_network_denied`]
//! says while it lasts.

use super::bonjour::{self, Access, Failure, RETRY_AFTER};
use super::{DiscoveryError, Registration, Tracker, Txt};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::os::fd::RawFd;
use std::rc::Rc;
use std::sync::mpsc;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::Instant;

type DNSServiceRef = *mut c_void;
type DNSServiceFlags = u32;
type DNSServiceErrorType = i32;
type DNSServiceProtocol = u32;

const FLAGS_ADD: DNSServiceFlags = 0x2;
const FLAGS_SHARE_CONNECTION: DNSServiceFlags = 0x4000;
const PROTOCOL_IPV4: DNSServiceProtocol = 0x1;
const PROTOCOL_IPV6: DNSServiceProtocol = 0x2;
const NO_ERROR: DNSServiceErrorType = 0;
/// `kDNSServiceErr_Unknown`, for a call that failed without saying why.
const UNKNOWN: DNSServiceErrorType = -65537;
const TYPE_TXT: u16 = 16;
const TYPE_SRV: u16 = 33;
const CLASS_IN: u16 = 1;

/// Browses and advertisements stay in `local.`, out of any wide-area domain
/// the Mac is set up for.
const DOMAIN: &CStr = c"local.";

/// The interface every operation runs on: 0 for all of them. The tests use
/// `kDNSServiceInterfaceIndexLocalOnly`, so nothing they advertise or look
/// for leaves the Mac.
#[cfg(not(test))]
const INTERFACE: u32 = 0;
#[cfg(test)]
const INTERFACE: u32 = 0xFFFF_FFFF;

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
type QueryReply = unsafe extern "C" fn(
    DNSServiceRef,
    DNSServiceFlags,
    u32,
    DNSServiceErrorType,
    *const c_char,
    u16,
    u16,
    u16,
    *const c_void,
    u32,
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

// libSystem, which every macOS and iOS binary links.
unsafe extern "C" {
    fn DNSServiceCreateConnection(sd: *mut DNSServiceRef) -> DNSServiceErrorType;
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
    fn DNSServiceQueryRecord(
        sd: *mut DNSServiceRef,
        flags: DNSServiceFlags,
        interface: u32,
        fullname: *const c_char,
        rrtype: u16,
        rrclass: u16,
        callback: QueryReply,
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

/// What Bonjour has said about local network access. Any thread may ask.
static ACCESS: Mutex<Access> = Mutex::new(Access::new());

fn access() -> MutexGuard<'static, Access> {
    ACCESS.lock().unwrap_or_else(|e| e.into_inner())
}

/// Whether macOS or iOS refused the app access to the local network, so
/// browses and advertisements can't work until the user allows it under
/// Privacy & Security, then Local Network, in System Settings or Settings.
/// They keep trying meanwhile and pick up once it's allowed. The system may
/// also refuse while its alert asking the user is still up, and stops once
/// they allow it. Bonjour gives
/// no other sign, so this follows what it answers.
pub fn local_network_denied() -> bool {
    access().denied(Instant::now())
}

/// The connection to mDNSResponder that every [`Ref`] shares: the primary
/// ref, in `dns_sd.h`'s terms.
struct Conn(DNSServiceRef);

impl Conn {
    fn new() -> Result<Self, DNSServiceErrorType> {
        let mut sd: DNSServiceRef = std::ptr::null_mut();
        // SAFETY: `sd` is somewhere to write the new ref.
        let err = unsafe { DNSServiceCreateConnection(&mut sd) };
        match err {
            NO_ERROR if !sd.is_null() => Ok(Self(sd)),
            NO_ERROR => Err(UNKNOWN),
            err => Err(err),
        }
    }

    fn fd(&self) -> RawFd {
        // SAFETY: the ref is live until this Conn is dropped.
        unsafe { DNSServiceRefSockFD(self.0) }
    }
}

impl Drop for Conn {
    fn drop(&mut self) {
        // SAFETY: the ref is live and freed only here. Every Ref holds this
        // Conn, so none is left to free after it, which dns_sd.h forbids.
        unsafe { DNSServiceRefDeallocate(self.0) }
    }
}

/// What a callback's context points at, so it can find its state.
#[derive(Debug, Clone)]
enum Key {
    Browse(u64),
    Register(u64),
    Resolve(u64, String),
    Txt(u64, String),
    Srv(u64, String),
    Addr(u64, String),
}

impl Key {
    /// What kind of operation this is, for a log line. Instance names come
    /// from the network, so they stay out of the logs.
    fn kind(&self) -> &'static str {
        match self {
            Self::Browse(_) => "a browse",
            Self::Register(_) => "an advertisement",
            Self::Resolve(..) => "a resolve",
            Self::Txt(..) => "a TXT query",
            Self::Srv(..) => "an SRV query",
            Self::Addr(..) => "an address lookup",
        }
    }
}

/// An operation on the shared connection, and the context its callbacks
/// get.
struct Ref {
    sd: DNSServiceRef,
    key: *mut Key,
    // Dropped after `sd` is freed, so the connection outlives it.
    _conn: Rc<Conn>,
}

impl Ref {
    /// Runs one of the `DNSService*` calls that start an operation, on
    /// `conn` and with a new context for `key`.
    fn start(
        conn: &Rc<Conn>,
        key: Key,
        make: impl FnOnce(*mut DNSServiceRef, *mut c_void) -> DNSServiceErrorType,
    ) -> Result<Self, DNSServiceErrorType> {
        let key = Box::into_raw(Box::new(key));
        // With kDNSServiceFlagsShareConnection, Bonjour reads the connection
        // from here and writes the new ref over it.
        let mut sd = conn.0;
        let err = make(&mut sd, key.cast());
        if err != NO_ERROR || sd.is_null() || sd == conn.0 {
            // SAFETY: `key` came from Box::into_raw above, and Bonjour made
            // no ref that could still use it.
            drop(unsafe { Box::from_raw(key) });
            return Err(if err == NO_ERROR { UNKNOWN } else { err });
        }
        Ok(Self {
            sd,
            key,
            _conn: Rc::clone(conn),
        })
    }
}

impl Drop for Ref {
    fn drop(&mut self) {
        // SAFETY: `sd` is live, since the connection is, and freed only
        // here. Once it's freed no callback can run with `key`, so the box
        // can go too.
        unsafe {
            DNSServiceRefDeallocate(self.sd);
            drop(Box::from_raw(self.key));
        }
    }
}

/// An instance a browse found.
struct Instance {
    /// The interfaces the browse sees it on. It's gone once there are none.
    interfaces: HashSet<u32>,
    /// Its name, type and domain as the browse gave them, to resolve it.
    name: CString,
    regtype: CString,
    domain: CString,
    resolve: Option<Ref>,
    txt_query: Option<Ref>,
    srv_query: Option<Ref>,
    addr: Option<Ref>,
    /// The SRV record the query last reported.
    srv: Option<Vec<u8>>,
    host: Option<String>,
    port: u16,
    txt: Txt,
    addrs: HashSet<IpAddr>,
    /// When to resolve it again, after Bonjour failed one of its operations.
    retry_at: Option<Instant>,
}

impl Instance {
    fn new(name: &CStr, regtype: &CStr, domain: &CStr) -> Self {
        Self {
            interfaces: HashSet::new(),
            name: name.to_owned(),
            regtype: regtype.to_owned(),
            domain: domain.to_owned(),
            resolve: None,
            txt_query: None,
            srv_query: None,
            addr: None,
            srv: None,
            host: None,
            port: 0,
            txt: Txt::default(),
            addrs: HashSet::new(),
            retry_at: None,
        }
    }

    /// Stops its operations and forgets what they found, so it all starts
    /// again from a resolve.
    fn forget(&mut self, dead: &mut Vec<Ref>) {
        dead.extend(self.resolve.take());
        dead.extend(self.txt_query.take());
        dead.extend(self.srv_query.take());
        dead.extend(self.addr.take());
        self.srv = None;
        self.host = None;
        self.port = 0;
        self.txt = Txt::default();
        self.addrs.clear();
    }
}

struct Browse {
    service_type: CString,
    sd: Option<Ref>,
    /// When to start the browse again, after Bonjour failed it.
    retry_at: Option<Instant>,
    tracker: Tracker,
    instances: HashMap<String, Instance>,
}

impl Browse {
    /// Stops the browse and everything it found, and reports each instance
    /// removed.
    fn stop(&mut self, dead: &mut Vec<Ref>) {
        dead.extend(self.sd.take());
        for (name, mut instance) in self.instances.drain() {
            instance.forget(dead);
            self.tracker.removed(&name);
        }
    }
}

/// An advertisement, kept whole so it can be registered again.
struct Advert {
    name: CString,
    regtype: CString,
    port: u16,
    txt: Vec<u8>,
    sd: Option<Ref>,
    /// When to register it again, after Bonjour failed it.
    retry_at: Option<Instant>,
}

#[derive(Default)]
struct State {
    /// The connection every ref shares, made when first needed and again
    /// after it broke.
    conn: Option<Rc<Conn>>,
    /// The connection broke. Everything starts again once the callbacks
    /// running now have returned.
    broken: bool,
    browses: HashMap<u64, Browse>,
    adverts: HashMap<u64, Advert>,
    /// Refs to free once the callbacks running now have returned, since a
    /// ref can't be freed from inside its own callback.
    dead: Vec<Ref>,
}

impl State {
    /// The shared connection, made now if there's none.
    fn conn(&mut self) -> Result<Rc<Conn>, DNSServiceErrorType> {
        if self.broken {
            return Err(bonjour::SERVICE_NOT_RUNNING);
        }
        if let Some(conn) = &self.conn {
            return Ok(Rc::clone(conn));
        }
        let conn = Rc::new(Conn::new()?);
        self.conn = Some(Rc::clone(&conn));
        Ok(conn)
    }

    /// When something that failed is due to start again.
    fn deadlines(&self) -> impl Iterator<Item = Instant> + '_ {
        let browses = self.browses.values().flat_map(|b| {
            b.retry_at
                .into_iter()
                .chain(b.instances.values().filter_map(|i| i.retry_at))
        });
        browses.chain(self.adverts.values().filter_map(|a| a.retry_at))
    }
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
        retry_due(Instant::now());
        repair();

        let (conn_fd, timeout) = STATE.with_borrow(|state| {
            (
                state.conn.as_ref().map_or(-1, |c| c.fd()),
                bonjour::poll_timeout(Instant::now(), state.deadlines()),
            )
        });
        // poll skips an entry whose descriptor is negative.
        let mut fds = [wake, conn_fd].map(|fd| libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        });
        // SAFETY: `fds` is a valid array of pollfd of the length given.
        let ready = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) };
        if ready > 0 && fds[1].revents != 0 {
            process();
        }
    }
}

/// Lets Bonjour read what mDNSResponder sent and run the callbacks. No
/// borrow of the state is held across the call, since the callbacks borrow
/// it.
fn process() {
    // The clone keeps the connection open through the call, whatever the
    // callbacks do.
    let Some(conn) = STATE.with_borrow(|state| state.conn.clone()) else {
        return;
    };
    // SAFETY: `conn` is live, and poll just said its socket is readable, so
    // the call doesn't block.
    let err = unsafe { DNSServiceProcessResult(conn.0) };
    STATE.with_borrow_mut(|state| {
        if err != NO_ERROR {
            // Bonjour can't read the connection, so nothing more comes on it.
            tracing::debug!("[discovery] Bonjour error {err} reading the connection");
            state.broken = true;
        }
        state.dead.clear();
    });
    repair();
    drop(conn);
}

/// Starts everything again on a new connection, after [`RETRY_AFTER`], if
/// the connection broke.
fn repair() {
    STATE.with_borrow_mut(|state| {
        if !state.broken {
            return;
        }
        if state.conn.is_some() {
            tracing::warn!("[discovery] lost the connection to mDNSResponder; starting again");
        } else {
            tracing::debug!("[discovery] couldn't connect to mDNSResponder");
        }
        let retry_at = Instant::now() + RETRY_AFTER;
        let State {
            conn,
            broken,
            browses,
            adverts,
            dead,
        } = state;
        for browse in browses.values_mut() {
            browse.stop(dead);
            browse.retry_at = Some(retry_at);
        }
        for advert in adverts.values_mut() {
            dead.extend(advert.sd.take());
            advert.retry_at = Some(retry_at);
        }
        // Every ref on the connection goes before the connection itself, as
        // dns_sd.h requires. Each holds the connection, which only closes
        // once the last of them is gone.
        dead.clear();
        *conn = None;
        *broken = false;
    });
}

/// Logs a Bonjour error, and notes what it says about the connection and
/// local network access. Returns what it means.
fn note(broken: &mut bool, err: DNSServiceErrorType, kind: &str) -> Failure {
    let failure = Failure::of(err);
    match failure {
        Failure::Connection => *broken = true,
        Failure::Denied => {
            if access().refused(Instant::now()) {
                tracing::warn!(
                    "[discovery] the system refused local network access, so Bonjour can't browse or \
                     advertise until it's allowed in System Settings > Privacy & Security > \
                     Local Network"
                );
            }
        }
        Failure::Other => tracing::debug!("[discovery] Bonjour error {err} on {kind}"),
    }
    failure
}

fn handle(command: Command) {
    let now = Instant::now();
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
                    STATE.with_borrow_mut(|state| {
                        let started = state
                            .conn()
                            .and_then(|conn| start_browse(&conn, id, &service_type));
                        let (sd, retry_at) = match started {
                            Ok(sd) => (Some(sd), None),
                            Err(err) => {
                                if !note(&mut state.broken, err, "a browse").passes() {
                                    return Err(DiscoveryError(format!(
                                        "Bonjour couldn't browse: error {err}"
                                    )));
                                }
                                (None, Some(now + RETRY_AFTER))
                            }
                        };
                        state.browses.insert(
                            id,
                            Browse {
                                service_type,
                                sd,
                                retry_at,
                                tracker,
                                instances: HashMap::new(),
                            },
                        );
                        Ok(())
                    })
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
            let result = advert(&registration).and_then(|mut advert| {
                STATE.with_borrow_mut(|state| {
                    let started = state
                        .conn()
                        .and_then(|conn| start_register(&conn, id, &advert));
                    match started {
                        Ok(sd) => advert.sd = Some(sd),
                        Err(err) => {
                            if !note(&mut state.broken, err, "an advertisement").passes() {
                                return Err(DiscoveryError(format!(
                                    "Bonjour couldn't advertise: error {err}"
                                )));
                            }
                            advert.retry_at = Some(now + RETRY_AFTER);
                        }
                    }
                    state.adverts.insert(id, advert);
                    Ok(())
                })
            });
            let _ = reply.send(result);
        }
        Command::Unregister(id) => {
            // Freeing the ref withdraws the record with a goodbye.
            STATE.with_borrow_mut(|state| state.adverts.remove(&id));
        }
    }
}

fn advert(registration: &Registration) -> Result<Advert, DiscoveryError> {
    let name = CString::new(registration.instance.as_str())
        .map_err(|_| DiscoveryError("the instance name has a NUL byte".into()))?;
    let regtype = CString::new(registration.service_type.as_str())
        .map_err(|_| DiscoveryError("the service type has a NUL byte".into()))?;
    let txt = registration.txt.encode()?;
    if u16::try_from(txt.len()).is_err() {
        return Err(DiscoveryError("the TXT record is too long".into()));
    }
    Ok(Advert {
        name,
        regtype,
        port: registration.port,
        txt,
        sd: None,
        retry_at: None,
    })
}

/// Starts again whatever is due to.
fn retry_due(now: Instant) {
    STATE.with_borrow_mut(|state| {
        if !state.deadlines().any(|at| at <= now) {
            return;
        }
        let conn = state.conn();
        let State {
            browses,
            adverts,
            broken,
            ..
        } = state;
        let later = Some(now + RETRY_AFTER);
        for (&id, browse) in browses.iter_mut() {
            if bonjour::due(browse.retry_at, now) {
                browse.retry_at = None;
                match conn
                    .clone()
                    .and_then(|conn| start_browse(&conn, id, &browse.service_type))
                {
                    Ok(sd) => browse.sd = Some(sd),
                    Err(err) => {
                        note(broken, err, "a browse");
                        browse.retry_at = later;
                    }
                }
            }
            for (name, instance) in browse.instances.iter_mut() {
                if bonjour::due(instance.retry_at, now) {
                    instance.retry_at = None;
                    match conn
                        .clone()
                        .and_then(|conn| start_resolve(&conn, id, name, instance))
                    {
                        Ok(sd) => instance.resolve = Some(sd),
                        Err(err) => {
                            note(broken, err, "a resolve");
                            instance.retry_at = later;
                        }
                    }
                }
            }
        }
        for (&id, advert) in adverts.iter_mut() {
            if bonjour::due(advert.retry_at, now) {
                advert.retry_at = None;
                match conn
                    .clone()
                    .and_then(|conn| start_register(&conn, id, advert))
                {
                    Ok(sd) => advert.sd = Some(sd),
                    Err(err) => {
                        note(broken, err, "an advertisement");
                        advert.retry_at = later;
                    }
                }
            }
        }
    });
}

fn start_browse(conn: &Rc<Conn>, id: u64, service_type: &CStr) -> Result<Ref, DNSServiceErrorType> {
    Ref::start(conn, Key::Browse(id), |sd, ctx| {
        // SAFETY: the strings outlive the call, and `ctx` outlives the ref.
        unsafe {
            DNSServiceBrowse(
                sd,
                FLAGS_SHARE_CONNECTION,
                INTERFACE,
                service_type.as_ptr(),
                DOMAIN.as_ptr(),
                on_browse,
                ctx,
            )
        }
    })
}

fn start_register(conn: &Rc<Conn>, id: u64, advert: &Advert) -> Result<Ref, DNSServiceErrorType> {
    // `advert` checked that the length fits.
    let txt_len = u16::try_from(advert.txt.len()).map_err(|_| UNKNOWN)?;
    Ref::start(conn, Key::Register(id), |sd, ctx| {
        // SAFETY: the strings and the TXT bytes outlive the call, which
        // copies them, and `ctx` outlives the ref. A NULL host is the Mac's
        // own Bonjour host name; the port goes in network byte order.
        unsafe {
            DNSServiceRegister(
                sd,
                FLAGS_SHARE_CONNECTION,
                INTERFACE,
                advert.name.as_ptr(),
                advert.regtype.as_ptr(),
                DOMAIN.as_ptr(),
                std::ptr::null(),
                advert.port.to_be(),
                txt_len,
                advert.txt.as_ptr().cast(),
                on_register,
                ctx,
            )
        }
    })
}

fn start_resolve(
    conn: &Rc<Conn>,
    id: u64,
    name: &str,
    instance: &Instance,
) -> Result<Ref, DNSServiceErrorType> {
    Ref::start(conn, Key::Resolve(id, name.to_owned()), |sd, ctx| {
        // SAFETY: the strings outlive the call, which copies them, and `ctx`
        // outlives the ref.
        unsafe {
            DNSServiceResolve(
                sd,
                FLAGS_SHARE_CONNECTION,
                INTERFACE,
                instance.name.as_ptr(),
                instance.regtype.as_ptr(),
                instance.domain.as_ptr(),
                on_resolve,
                ctx,
            )
        }
    })
}

fn start_query(
    conn: &Rc<Conn>,
    key: Key,
    fullname: &CStr,
    rrtype: u16,
) -> Result<Ref, DNSServiceErrorType> {
    Ref::start(conn, key, |sd, ctx| {
        // SAFETY: `fullname` outlives the call, which copies it, and `ctx`
        // outlives the ref.
        unsafe {
            DNSServiceQueryRecord(
                sd,
                FLAGS_SHARE_CONNECTION,
                INTERFACE,
                fullname.as_ptr(),
                rrtype,
                CLASS_IN,
                on_query,
                ctx,
            )
        }
    })
}

fn start_addr(
    conn: &Rc<Conn>,
    id: u64,
    name: &str,
    host: &CStr,
) -> Result<Ref, DNSServiceErrorType> {
    Ref::start(conn, Key::Addr(id, name.to_owned()), |sd, ctx| {
        // SAFETY: `host` outlives the call, which copies it, and `ctx`
        // outlives the ref.
        unsafe {
            DNSServiceGetAddrInfo(
                sd,
                FLAGS_SHARE_CONNECTION,
                INTERFACE,
                PROTOCOL_IPV4 | PROTOCOL_IPV6,
                host.as_ptr(),
                on_addr,
                ctx,
            )
        }
    })
}

/// Something Bonjour started failed. A browse or advertisement starts again
/// after [`RETRY_AFTER`], and a browse's instances are reported removed
/// meanwhile. When one of an instance's operations fails, they all stop, it's
/// reported removed and it's resolved again after [`RETRY_AFTER`], so a host
/// or address it had doesn't stay as though it still held.
fn failed(key: &Key, err: DNSServiceErrorType) {
    let now = Instant::now();
    STATE.with_borrow_mut(|state| {
        let State {
            browses,
            adverts,
            dead,
            broken,
            ..
        } = state;
        let failure = note(broken, err, key.kind());
        if failure == Failure::Connection {
            // `repair` starts everything again.
            return;
        }
        match key {
            Key::Browse(id) => {
                if let Some(browse) = browses.get_mut(id) {
                    if failure == Failure::Other {
                        tracing::warn!("[discovery] Bonjour error {err} on a browse; trying again");
                    }
                    browse.stop(dead);
                    browse.retry_at = Some(now + RETRY_AFTER);
                }
            }
            Key::Register(id) => {
                if let Some(advert) = adverts.get_mut(id) {
                    if failure == Failure::Other {
                        tracing::warn!(
                            "[discovery] Bonjour error {err} on an advertisement; trying again"
                        );
                    }
                    dead.extend(advert.sd.take());
                    advert.retry_at = Some(now + RETRY_AFTER);
                }
            }
            Key::Resolve(id, name)
            | Key::Txt(id, name)
            | Key::Srv(id, name)
            | Key::Addr(id, name) => {
                if let Some(browse) = browses.get_mut(id) {
                    instance_failed(browse, dead, name, now);
                }
            }
        }
    });
}

/// One of an instance's operations failed, or couldn't start. They all
/// stop, it's reported removed and it's resolved again after
/// [`RETRY_AFTER`].
fn instance_failed(browse: &mut Browse, dead: &mut Vec<Ref>, name: &str, now: Instant) {
    if let Some(instance) = browse.instances.get_mut(name) {
        instance.forget(dead);
        instance.retry_at = Some(now + RETRY_AFTER);
        browse.tracker.removed(name);
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
/// `text` is NULL or a NUL-terminated string that outlives `'a`.
unsafe fn c_str<'a>(text: *const c_char) -> Option<&'a CStr> {
    // SAFETY: as the caller promises.
    (!text.is_null()).then(|| unsafe { CStr::from_ptr(text) })
}

/// The text of a string from Bonjour, or `None` when it isn't UTF-8, which
/// no name it reports should be.
///
/// # Safety
///
/// `text` is NULL or a NUL-terminated string.
unsafe fn text(text: *const c_char) -> Option<String> {
    // SAFETY: as the caller promises.
    let text = unsafe { c_str(text) }?;
    text.to_str().ok().map(str::to_owned)
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
    access().answered();
    // SAFETY: Bonjour passes NUL-terminated strings, live for the call.
    let (Some(instance), Some(c_name), Some(regtype), Some(domain)) = (unsafe {
        (text(name), c_str(name), c_str(regtype), c_str(domain))
    }) else {
        return;
    };
    let now = Instant::now();
    STATE.with_borrow_mut(|state| {
        let conn = state.conn();
        let State {
            browses,
            dead,
            broken,
            ..
        } = state;
        let Some(browse) = browses.get_mut(&id) else {
            return;
        };
        if flags & FLAGS_ADD == 0 {
            if let Some(entry) = browse.instances.get_mut(&instance) {
                entry.interfaces.remove(&interface);
                if entry.interfaces.is_empty() {
                    if let Some(mut gone) = browse.instances.remove(&instance) {
                        gone.forget(dead);
                    }
                    browse.tracker.removed(&instance);
                }
            }
            return;
        }
        let count = browse.instances.len();
        if !browse.instances.contains_key(&instance) && !browse.tracker.has_room(count) {
            return;
        }
        let entry = browse
            .instances
            .entry(instance.clone())
            .or_insert_with(|| Instance::new(c_name, regtype, domain));
        entry.interfaces.insert(interface);
        // Another interface's sighting needs nothing more, nor does one that
        // fails and waits to resolve again.
        if entry.resolve.is_some() || entry.host.is_some() || entry.retry_at.is_some() {
            return;
        }
        match conn.and_then(|conn| start_resolve(&conn, id, &instance, entry)) {
            Ok(sd) => entry.resolve = Some(sd),
            Err(err) => {
                note(broken, err, "a resolve");
                instance_failed(browse, dead, &instance, now);
            }
        }
    });
}

unsafe extern "C" fn on_resolve(
    _sd: DNSServiceRef,
    _flags: DNSServiceFlags,
    _interface: u32,
    err: DNSServiceErrorType,
    fullname: *const c_char,
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
    access().answered();
    // SAFETY: Bonjour passes NUL-terminated names, live for the call.
    let (Some(fullname), Some(host)) = (unsafe { (c_str(fullname), c_str(host)) }) else {
        return;
    };
    if host.to_str().is_err() {
        return;
    }
    let txt = if txt.is_null() {
        Txt::default()
    } else {
        // SAFETY: Bonjour passes `txt_len` bytes at `txt`.
        Txt::parse(unsafe { std::slice::from_raw_parts(txt, usize::from(txt_len)) })
    };
    let now = Instant::now();
    STATE.with_borrow_mut(|state| {
        let conn = state.conn();
        let State {
            browses,
            dead,
            broken,
            ..
        } = state;
        let Some(browse) = browses.get_mut(&id) else {
            return;
        };
        let Some(entry) = browse.instances.get_mut(instance) else {
            return;
        };
        // One answer is all that's needed; the queries follow changes.
        dead.extend(entry.resolve.take());
        entry.port = u16::from_be(port);
        entry.txt = txt;
        let followed = conn.and_then(|conn| follow(&conn, id, instance, entry, fullname, host, dead));
        match followed {
            Ok(()) => report(browse, instance),
            Err(err) => {
                note(broken, err, "an instance's lookups");
                instance_failed(browse, dead, instance, now);
            }
        }
    });
}

/// Starts what follows a resolved instance: queries for its TXT and SRV
/// records, unless they're running, and an address lookup when its host is
/// new.
fn follow(
    conn: &Rc<Conn>,
    id: u64,
    name: &str,
    entry: &mut Instance,
    fullname: &CStr,
    host: &CStr,
    dead: &mut Vec<Ref>,
) -> Result<(), DNSServiceErrorType> {
    // `on_resolve` only passes a host name that's UTF-8.
    let host_name = host.to_str().map_err(|_| UNKNOWN)?;
    if entry.txt_query.is_none() {
        let key = Key::Txt(id, name.to_owned());
        entry.txt_query = Some(start_query(conn, key, fullname, TYPE_TXT)?);
    }
    if entry.srv_query.is_none() {
        let key = Key::Srv(id, name.to_owned());
        entry.srv_query = Some(start_query(conn, key, fullname, TYPE_SRV)?);
    }
    if entry.host.as_deref() != Some(host_name) {
        entry.addrs.clear();
        dead.extend(entry.addr.take());
        entry.addr = Some(start_addr(conn, id, name, host)?);
        entry.host = Some(host_name.to_owned());
    }
    Ok(())
}

unsafe extern "C" fn on_query(
    _sd: DNSServiceRef,
    flags: DNSServiceFlags,
    _interface: u32,
    err: DNSServiceErrorType,
    _fullname: *const c_char,
    _rrtype: u16,
    _rrclass: u16,
    rdlen: u16,
    rdata: *const c_void,
    _ttl: u32,
    context: *mut c_void,
) {
    // SAFETY: Bonjour passes back the context of a live query ref.
    let key = unsafe { key(context) }.clone();
    let (Key::Txt(id, instance) | Key::Srv(id, instance)) = &key else {
        return;
    };
    if err != NO_ERROR {
        failed(&key, err);
        return;
    }
    access().answered();
    // A record that went away is followed by the one in its place, if there
    // is one, so only additions matter. One with no data is no record.
    if flags & FLAGS_ADD == 0 || rdata.is_null() {
        return;
    }
    // SAFETY: Bonjour passes `rdlen` bytes at `rdata`.
    let rdata = unsafe { std::slice::from_raw_parts(rdata.cast::<u8>(), usize::from(rdlen)) };
    let now = Instant::now();
    STATE.with_borrow_mut(|state| {
        let conn = state.conn();
        let State {
            browses,
            dead,
            broken,
            ..
        } = state;
        let Some(browse) = browses.get_mut(id) else {
            return;
        };
        let Some(entry) = browse.instances.get_mut(instance) else {
            return;
        };
        if let Key::Txt(..) = key {
            entry.txt = Txt::parse(rdata);
            report(browse, instance);
            return;
        }
        let moved = bonjour::srv_moved(entry.srv.as_deref(), rdata, entry.port);
        entry.srv = Some(rdata.to_vec());
        if !moved || entry.resolve.is_some() {
            return;
        }
        match conn.and_then(|conn| start_resolve(&conn, *id, instance, entry)) {
            Ok(sd) => entry.resolve = Some(sd),
            Err(err) => {
                note(broken, err, "a resolve");
                instance_failed(browse, dead, instance, now);
            }
        }
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
    access().answered();
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
    access().answered();
    // SAFETY: Bonjour passes a NUL-terminated name. It's the device's name,
    // or Bonjour's rename of it, so it's only logged when debugging.
    if let Some(name) = unsafe { text(name) } {
        tracing::debug!("[discovery] advertising as {name:?}");
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
