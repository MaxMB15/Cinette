// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 Max Boksem. See NOTICE for additional terms under GPLv3 section 7.

//! The TLS connection to a Cast receiver's port 8009.
//!
//! Receivers present a certificate their maker signed, with no host name a
//! sender could check, so any certificate is accepted, as every open-source
//! sender does. Nothing is pinned: receivers change theirs after a few days
//! or a restart, and a cast makes one connection, which ends the cast when
//! it drops. The handshake's own signatures are still checked, so the
//! receiver must hold the certificate's key.

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

/// Connects to the receiver at `addr`. Returns the stream and the
/// certificate the receiver presented.
pub async fn connect(addr: IpAddr, port: u16) -> Result<(TlsStream<TcpStream>, Vec<u8>), TlsError> {
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
    Ok((stream, presented))
}
