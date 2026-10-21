// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The TLS connection to a Cast receiver's port 8009.
//!
//! Receivers present a certificate their maker signed, with no host name a
//! sender could check, so a new cast accepts any certificate, as every
//! open-source sender does. Receivers change theirs from time to time, after
//! a few days or a restart, so its bytes are pinned only while that cast
//! lasts: a connection made for it must present the same one. The
//! handshake's own signatures are still checked, so the receiver must hold
//! the certificate's key.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio::net::TcpStream;
use tokio_rustls::client::TlsStream;
use tokio_rustls::TlsConnector;

/// How long connecting and the handshake get together.
pub const CONNECT_LIMIT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum TlsError {
    #[error("couldn't reach the receiver")]
    Unreachable,
    #[error("the receiver's TLS handshake failed")]
    Handshake,
    /// Something at the receiver's address presented another certificate
    /// than it did before.
    #[error("the receiver presented a different certificate")]
    NotPinned,
}

/// Accepts any certificate, and checks the handshake's signatures with it.
#[derive(Debug)]
struct AcceptAny(Arc<CryptoProvider>);

impl ServerCertVerifier for AcceptAny {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(
            message,
            cert,
            dss,
            &self.0.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn connector() -> TlsConnector {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("ring supports the default TLS versions")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAny(provider)))
        .with_no_client_auth();
    TlsConnector::from(Arc::new(config))
}

/// Connects to the receiver at `addr`. With `pin`, the receiver must
/// present that certificate. Returns the stream and the certificate it
/// presented, to pin for the next time.
pub async fn connect(
    addr: IpAddr,
    port: u16,
    pin: Option<&[u8]>,
) -> Result<(TlsStream<TcpStream>, Vec<u8>), TlsError> {
    let handshake = async {
        let tcp = TcpStream::connect(SocketAddr::new(addr, port))
            .await
            .map_err(|_| TlsError::Unreachable)?;
        let _ = tcp.set_nodelay(true);
        connector()
            .connect(ServerName::IpAddress(addr.into()), tcp)
            .await
            .map_err(|_| TlsError::Handshake)
    };
    let stream = tokio::time::timeout(CONNECT_LIMIT, handshake)
        .await
        .map_err(|_| TlsError::Unreachable)??;
    let presented = stream
        .get_ref()
        .1
        .peer_certificates()
        .and_then(|certs| certs.first())
        .map(|cert| cert.to_vec())
        .ok_or(TlsError::Handshake)?;
    if pin.is_some_and(|pin| pin != presented.as_slice()) {
        return Err(TlsError::NotPinned);
    }
    Ok((stream, presented))
}
