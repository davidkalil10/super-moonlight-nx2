//! TLS 1.3 to Sunshine with rustls and a small RustCrypto provider: AES-128-GCM, SHA-256,
//! X25519 and RSA-PSS. The server certificate is pinned to the one pairing returned, and
//! the console presents its own certificate.

use alloc::{boxed::Box, sync::Arc, vec, vec::Vec};
use core::time::Duration;

use ::hmac::{Hmac as HmacOf, KeyInit as HmacKeyInit, Mac};
use aes_gcm::{Aes128Gcm, KeyInit, aead::AeadInOut};
use once_cell::race::OnceBox;
use rsa::{
    pss,
    signature::{RandomizedSigner, SignatureEncoding, Verifier},
};
use rustls::{
    CipherSuite, ClientConfig, ContentType, DigitallySignedStruct, Error, NamedGroup,
    ProtocolVersion, SignatureAlgorithm, SignatureScheme, SupportedCipherSuite, Tls13CipherSuite,
    client::{
        ResolvesClientCert,
        danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    },
    crypto::{
        ActiveKeyExchange, CipherSuiteCommon, CryptoProvider, GetRandomFailed, KeyProvider,
        SecureRandom, SharedSecret, SupportedKxGroup, WebPkiSupportedAlgorithms,
        cipher::{
            AeadKey, InboundOpaqueMessage, InboundPlainMessage, Iv, MessageDecrypter,
            MessageEncrypter, Nonce, OutboundOpaqueMessage, OutboundPlainMessage, PrefixedPayload,
            Tls13AeadAlgorithm, UnsupportedOperationError, make_tls13_aad,
        },
        hash::{self, HashAlgorithm},
        hmac,
        tls13::HkdfUsingHmac,
    },
    pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime},
    sign::{CertifiedKey, Signer, SigningKey},
    time_provider::TimeProvider,
    version::TLS13,
};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{
    identity::{Identity, PeerCert},
    random::Random,
};

const TAG_BYTES: usize = 16;

#[derive(Debug)]
struct Rng(Random);

impl SecureRandom for Rng {
    fn fill(&self, bytes: &mut [u8]) -> Result<(), GetRandomFailed> {
        self.0.fill(bytes).map_err(|_| GetRandomFailed)
    }
}

struct Sha256Hash;

struct Sha256Context(Sha256);

impl hash::Hash for Sha256Hash {
    fn start(&self) -> Box<dyn hash::Context> {
        Box::new(Sha256Context(Sha256::new()))
    }

    fn hash(&self, data: &[u8]) -> hash::Output {
        hash::Output::new(&Sha256::digest(data))
    }

    fn output_len(&self) -> usize {
        32
    }

    fn algorithm(&self) -> HashAlgorithm {
        HashAlgorithm::SHA256
    }
}

impl hash::Context for Sha256Context {
    fn fork_finish(&self) -> hash::Output {
        hash::Output::new(&self.0.clone().finalize())
    }

    fn fork(&self) -> Box<dyn hash::Context> {
        Box::new(Sha256Context(self.0.clone()))
    }

    fn finish(self: Box<Self>) -> hash::Output {
        hash::Output::new(&self.0.finalize())
    }

    fn update(&mut self, data: &[u8]) {
        self.0.update(data);
    }
}

struct Sha256Hmac;

struct Sha256HmacKey(HmacOf<Sha256>);

impl hmac::Hmac for Sha256Hmac {
    fn with_key(&self, key: &[u8]) -> Box<dyn hmac::Key> {
        let mac = <HmacOf<Sha256> as HmacKeyInit>::new_from_slice(key).expect("any length");
        Box::new(Sha256HmacKey(mac))
    }

    fn hash_output_len(&self) -> usize {
        32
    }
}

impl hmac::Key for Sha256HmacKey {
    fn sign_concat(&self, first: &[u8], middle: &[&[u8]], last: &[u8]) -> hmac::Tag {
        let mut mac = self.0.clone();
        mac.update(first);
        for part in middle {
            mac.update(part);
        }
        mac.update(last);
        hmac::Tag::new(&mac.finalize().into_bytes())
    }

    fn tag_len(&self) -> usize {
        32
    }
}

struct Aes128GcmTls13;

struct GcmCrypter {
    cipher: Aes128Gcm,
    iv: Iv,
}

impl Tls13AeadAlgorithm for Aes128GcmTls13 {
    fn encrypter(&self, key: AeadKey, iv: Iv) -> Box<dyn MessageEncrypter> {
        Box::new(GcmCrypter::new(&key, iv))
    }

    fn decrypter(&self, key: AeadKey, iv: Iv) -> Box<dyn MessageDecrypter> {
        Box::new(GcmCrypter::new(&key, iv))
    }

    fn key_len(&self) -> usize {
        16
    }

    fn extract_keys(
        &self,
        _: AeadKey,
        _: Iv,
    ) -> Result<rustls::ConnectionTrafficSecrets, UnsupportedOperationError> {
        Err(UnsupportedOperationError)
    }
}

impl GcmCrypter {
    fn new(key: &AeadKey, iv: Iv) -> Self {
        let cipher = Aes128Gcm::new_from_slice(key.as_ref()).expect("16-byte key");
        Self { cipher, iv }
    }

    fn nonce(&self, sequence: u64) -> aes_gcm::Nonce<aes_gcm::aead::consts::U12> {
        Nonce::new(&self.iv, sequence).0.into()
    }
}

impl MessageEncrypter for GcmCrypter {
    fn encrypt(
        &mut self,
        message: OutboundPlainMessage<'_>,
        sequence: u64,
    ) -> Result<OutboundOpaqueMessage, Error> {
        let total = self.encrypted_payload_len(message.payload.len());
        let mut payload = PrefixedPayload::with_capacity(total);
        payload.extend_from_chunks(&message.payload);
        payload.extend_from_slice(&message.typ.to_array());

        let aad = make_tls13_aad(total);
        let tag = self
            .cipher
            .encrypt_inout_detached(&self.nonce(sequence), &aad, payload.as_mut().into())
            .map_err(|_| Error::EncryptError)?;
        payload.extend_from_slice(&tag);
        Ok(OutboundOpaqueMessage::new(
            ContentType::ApplicationData,
            ProtocolVersion::TLSv1_2,
            payload,
        ))
    }

    fn encrypted_payload_len(&self, payload_len: usize) -> usize {
        payload_len + 1 + TAG_BYTES
    }
}

impl MessageDecrypter for GcmCrypter {
    fn decrypt<'a>(
        &mut self,
        mut message: InboundOpaqueMessage<'a>,
        sequence: u64,
    ) -> Result<InboundPlainMessage<'a>, Error> {
        let payload = &mut message.payload;
        let Some(plain) = payload.len().checked_sub(TAG_BYTES) else {
            return Err(Error::DecryptError);
        };

        let aad = make_tls13_aad(payload.len());
        let (body, tag) = payload.split_at_mut(plain);
        let tag = aes_gcm::Tag::try_from(&*tag).map_err(|_| Error::DecryptError)?;
        self.cipher
            .decrypt_inout_detached(&self.nonce(sequence), &aad, body.into(), &tag)
            .map_err(|_| Error::DecryptError)?;
        payload.truncate(plain);
        message.into_tls13_unpadded_message()
    }
}

static TLS13_AES_128_GCM_SHA256: Tls13CipherSuite = Tls13CipherSuite {
    common: CipherSuiteCommon {
        suite: CipherSuite::TLS13_AES_128_GCM_SHA256,
        hash_provider: &Sha256Hash,
        confidentiality_limit: 1 << 24,
    },
    hkdf_provider: &HkdfUsingHmac(&Sha256Hmac),
    aead_alg: &Aes128GcmTls13,
    quic: None,
};

#[derive(Debug)]
struct X25519(Random);

struct X25519Exchange {
    secret: [u8; 32],
    public: [u8; 32],
}

impl SupportedKxGroup for X25519 {
    fn start(&self) -> Result<Box<dyn ActiveKeyExchange>, Error> {
        let secret = self
            .0
            .array::<32>()
            .map_err(|_| Error::FailedToGetRandomBytes)?;
        let public = x25519_dalek::x25519(secret, x25519_dalek::X25519_BASEPOINT_BYTES);
        Ok(Box::new(X25519Exchange { secret, public }))
    }

    fn name(&self) -> NamedGroup {
        NamedGroup::X25519
    }
}

impl ActiveKeyExchange for X25519Exchange {
    fn complete(self: Box<Self>, peer: &[u8]) -> Result<SharedSecret, Error> {
        let peer: [u8; 32] = peer
            .try_into()
            .map_err(|_| Error::from(rustls::PeerMisbehaved::InvalidKeyShare))?;
        let shared = x25519_dalek::x25519(self.secret, peer);
        if bool::from(shared.ct_eq(&[0; 32])) {
            return Err(rustls::PeerMisbehaved::InvalidKeyShare.into());
        }
        Ok(SharedSecret::from(&shared[..]))
    }

    fn pub_key(&self) -> &[u8] {
        &self.public
    }

    fn group(&self) -> NamedGroup {
        NamedGroup::X25519
    }
}

impl Drop for X25519Exchange {
    fn drop(&mut self) {
        zeroize::Zeroize::zeroize(&mut self.secret);
    }
}

#[derive(Debug)]
struct NoKeys;

impl KeyProvider for NoKeys {
    fn load_private_key(&self, _: PrivateKeyDer<'static>) -> Result<Arc<dyn SigningKey>, Error> {
        Err(Error::General("keys come from the console identity".into()))
    }
}

#[derive(Debug)]
struct TimeOfPairing;

impl TimeProvider for TimeOfPairing {
    fn current_time(&self) -> Option<UnixTime> {
        Some(UnixTime::since_unix_epoch(Duration::from_secs(
            1_790_000_000,
        )))
    }
}

/// The console's key, signing CertificateVerify with RSA-PSS as TLS 1.3 requires.
struct ConsoleKey {
    key: pss::SigningKey<Sha256>,
    random: Random,
}

impl core::fmt::Debug for ConsoleKey {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("ConsoleKey")
    }
}

impl SigningKey for ConsoleKey {
    fn choose_scheme(&self, offered: &[SignatureScheme]) -> Option<Box<dyn Signer>> {
        offered
            .contains(&SignatureScheme::RSA_PSS_SHA256)
            .then(|| Box::new(ConsoleSigner(self.key.clone(), self.random)) as Box<dyn Signer>)
    }

    fn algorithm(&self) -> SignatureAlgorithm {
        SignatureAlgorithm::RSA
    }
}

struct ConsoleSigner(pss::SigningKey<Sha256>, Random);

impl core::fmt::Debug for ConsoleSigner {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("ConsoleSigner")
    }
}

impl Signer for ConsoleSigner {
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, Error> {
        let mut random = self.1;
        self.0
            .try_sign_with_rng(&mut random, message)
            .map(|signature| signature.to_vec())
            .map_err(|_| Error::General("signing failed".into()))
    }

    fn scheme(&self) -> SignatureScheme {
        SignatureScheme::RSA_PSS_SHA256
    }
}

/// Accepts exactly the certificate pairing pinned, and checks its handshake signature.
#[derive(Debug)]
struct Pinned(Vec<u8>);

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _: &[CertificateDer<'_>],
        _: &ServerName<'_>,
        _: &[u8],
        _: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        let same = end_entity.as_ref().len() == self.0.len()
            && bool::from(end_entity.as_ref().ct_eq(&self.0));
        if same {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(Error::InvalidCertificate(
                rustls::CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        _: &[u8],
        _: &CertificateDer<'_>,
        _: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(Error::PeerIncompatible(
            rustls::PeerIncompatible::Tls13RequiredForQuic,
        ))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signed: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        let bad = || Error::InvalidCertificate(rustls::CertificateError::BadSignature);
        if signed.scheme != SignatureScheme::RSA_PSS_SHA256 {
            return Err(Error::PeerMisbehaved(
                rustls::PeerMisbehaved::SignedHandshakeWithUnadvertisedSigScheme,
            ));
        }
        let peer = PeerCert::from_der(cert.as_ref()).ok_or_else(bad)?;
        let signature = pss::Signature::try_from(signed.signature()).map_err(|_| bad())?;
        pss::VerifyingKey::<Sha256>::new(peer.key)
            .verify(message, &signature)
            .map_err(|_| bad())?;
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::RSA_PSS_SHA256]
    }
}

#[derive(Debug)]
struct ConsoleCert(Arc<CertifiedKey>);

impl ResolvesClientCert for ConsoleCert {
    fn resolve(&self, _: &[&[u8]], schemes: &[SignatureScheme]) -> Option<Arc<CertifiedKey>> {
        schemes
            .contains(&SignatureScheme::RSA_PSS_SHA256)
            .then(|| self.0.clone())
    }

    fn has_certs(&self) -> bool {
        true
    }
}

static PROVIDER: OnceBox<Arc<CryptoProvider>> = OnceBox::new();

/// The provider, made once per process with the first random source given.
pub fn provider(random: Random) -> Arc<CryptoProvider> {
    PROVIDER
        .get_or_init(|| {
            let rng: &'static Rng = Box::leak(Box::new(Rng(random)));
            let kx: &'static X25519 = Box::leak(Box::new(X25519(random)));
            Box::new(Arc::new(CryptoProvider {
                cipher_suites: vec![SupportedCipherSuite::Tls13(&TLS13_AES_128_GCM_SHA256)],
                kx_groups: vec![kx],
                signature_verification_algorithms: WebPkiSupportedAlgorithms {
                    all: &[],
                    mapping: &[],
                },
                secure_random: rng,
                key_provider: &NoKeys,
            }))
        })
        .clone()
}

/// A client config that presents `identity` and trusts only `server_cert`.
pub fn config(
    identity: &Identity,
    server_cert: &[u8],
    random: Random,
) -> Result<Arc<ClientConfig>, Error> {
    let key = ConsoleKey {
        key: pss::SigningKey::<Sha256>::new(identity.key().clone()),
        random,
    };
    let chain = vec![CertificateDer::from(identity.cert_der().to_vec())];
    let certified = Arc::new(CertifiedKey::new(chain, Arc::new(key)));

    let mut config = ClientConfig::builder_with_details(provider(random), Arc::new(TimeOfPairing))
        .with_protocol_versions(&[&TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned(server_cert.to_vec())))
        .with_client_cert_resolver(Arc::new(ConsoleCert(certified)));
    config.resumption = rustls::client::Resumption::disabled();
    config.enable_sni = false;
    Ok(Arc::new(config))
}
