//! The console's GameStream identity: an RSA-2048 key and a self-signed certificate, as
//! Moonlight makes them, plus the `uniqueid` every request carries.

use alloc::{string::String, vec::Vec};
use core::str::FromStr;

use der::{DateTime, Decode, Encode, referenced::OwnedToRef, pem::LineEnding};
use rsa::{
    PrivateKey, PublicKey,
    pkcs1v15::{Signature, SigningKey, VerifyingKey},
    pkcs8::{DecodePrivateKey, EncodePrivateKey, EncodePublicKey},
    signature::{SignatureEncoding, Signer, Verifier},
};
use sha2::Sha256;
use spki::{SubjectPublicKeyInfoOwned, SubjectPublicKeyInfoRef};
use x509_cert::{
    Certificate,
    builder::{Builder, CertificateBuilder, profile::BuilderProfile},
    ext::{Extension, ToExtension, pkix::BasicConstraints},
    name::Name,
    serial_number::SerialNumber,
    time::{Time, Validity},
};
use zeroize::Zeroizing;

use crate::{hex, random::Random};

pub const KEY_BITS: usize = 2048;
pub const SUBJECT: &str = "CN=NVIDIA GameStream Client";
pub const UNIQUEID_BYTES: usize = 16;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    Random,
    Key,
    Certificate,
}

pub struct Identity {
    key: PrivateKey,
    cert: Vec<u8>,
    signature: Vec<u8>,
    uniqueid: String,
}

/// Self-signed, no extensions: what Moonlight clients present.
struct GameStreamClient;

impl BuilderProfile for GameStreamClient {
    fn get_issuer(&self, subject: &Name) -> Name {
        subject.clone()
    }

    fn get_subject(&self) -> Name {
        Name::from_str(SUBJECT).expect("subject")
    }

    /// Only `CA:FALSE`, so the certificate is a v3 one that TLS stacks such as webpki accept.
    fn build_extensions(
        &self,
        _: SubjectPublicKeyInfoRef<'_>,
        _: SubjectPublicKeyInfoRef<'_>,
        tbs: &x509_cert::TbsCertificate,
    ) -> x509_cert::builder::Result<Vec<Extension>> {
        let leaf = BasicConstraints {
            ca: false,
            path_len_constraint: None,
        };
        Ok(alloc::vec![leaf.to_extension(tbs.subject(), &[])?])
    }
}

fn validity() -> Option<Validity> {
    let from = DateTime::new(2026, 1, 1, 0, 0, 0).ok()?;
    let until = DateTime::new(2046, 1, 1, 0, 0, 0).ok()?;
    Some(Validity::new(Time::from(from), Time::from(until)))
}

impl Identity {
    /// A new key and certificate. Key generation takes seconds on the console.
    pub fn generate(random: Random) -> Result<Self, Error> {
        let mut rng = random;
        let key = PrivateKey::new(&mut rng, KEY_BITS).map_err(|_| Error::Key)?;

        let mut serial = random.array::<8>().map_err(|_| Error::Random)?;
        serial[0] &= 0x7f;
        serial[0] |= 0x01;
        let serial = SerialNumber::new(&serial).map_err(|_| Error::Certificate)?;

        let public = key.to_public_key();
        let spki_der = public.to_public_key_der().map_err(|_| Error::Key)?;
        let spki = SubjectPublicKeyInfoOwned::from_der(spki_der.as_bytes())
            .map_err(|_| Error::Certificate)?;
        let validity = validity().ok_or(Error::Certificate)?;

        let signer = SigningKey::<Sha256>::new(key.clone());
        let builder = CertificateBuilder::new(GameStreamClient, serial, validity, spki)
            .map_err(|_| Error::Certificate)?;
        let cert = builder
            .build::<_, Signature>(&signer)
            .map_err(|_| Error::Certificate)?;
        let cert = cert.to_der().map_err(|_| Error::Certificate)?;

        let uniqueid = hex::encode_upper(&random.array::<8>().map_err(|_| Error::Random)?);
        Self::assemble(key, cert, uniqueid)
    }

    /// A stored identity: the PKCS#8 key, the certificate's DER and the uniqueid.
    pub fn from_der(key: &[u8], cert: &[u8], uniqueid: &str) -> Result<Self, Error> {
        let key = PrivateKey::from_pkcs8_der(key).map_err(|_| Error::Key)?;
        let uniqueid_ok = uniqueid.len() == UNIQUEID_BYTES
            && uniqueid.bytes().all(|byte| byte.is_ascii_hexdigit());
        if !uniqueid_ok {
            return Err(Error::Key);
        }
        Self::assemble(key, cert.to_vec(), String::from(uniqueid))
    }

    fn assemble(key: PrivateKey, cert: Vec<u8>, uniqueid: String) -> Result<Self, Error> {
        let parsed = Certificate::from_der(&cert).map_err(|_| Error::Certificate)?;
        let spki = parsed.tbs_certificate().subject_public_key_info();
        let public = PublicKey::try_from(spki.owned_to_ref()).map_err(|_| Error::Certificate)?;
        if public != key.to_public_key() {
            return Err(Error::Certificate);
        }

        let signature = parsed.signature().raw_bytes().to_vec();
        Ok(Self {
            key,
            cert,
            signature,
            uniqueid,
        })
    }

    pub fn key_der(&self) -> Option<Zeroizing<Vec<u8>>> {
        let document = self.key.to_pkcs8_der().ok()?;
        Some(Zeroizing::new(document.as_bytes().to_vec()))
    }

    pub fn cert_der(&self) -> &[u8] {
        &self.cert
    }

    pub fn cert_pem(&self) -> String {
        der::pem::encode_string("CERTIFICATE", LineEnding::LF, &self.cert).unwrap_or_default()
    }

    /// The certificate's signature bits, which the pairing hashes bind to.
    pub fn cert_signature(&self) -> &[u8] {
        &self.signature
    }

    pub fn uniqueid(&self) -> &str {
        &self.uniqueid
    }

    /// PKCS#1 v1.5 over SHA-256, as the pairing secrets are signed.
    pub fn sign(&self, data: &[u8]) -> Vec<u8> {
        let signer = SigningKey::<Sha256>::new(self.key.clone());
        signer.sign(data).to_vec()
    }

    pub(crate) fn key(&self) -> &PrivateKey {
        &self.key
    }
}

/// A peer certificate: its DER, signature bits and RSA key.
pub struct PeerCert {
    pub der: Vec<u8>,
    pub signature: Vec<u8>,
    pub key: PublicKey,
}

impl PeerCert {
    pub fn from_der(der: &[u8]) -> Option<Self> {
        let parsed = Certificate::from_der(der).ok()?;
        let spki = parsed.tbs_certificate().subject_public_key_info();
        let key = PublicKey::try_from(spki.owned_to_ref()).ok()?;
        Some(Self {
            der: der.to_vec(),
            signature: parsed.signature().raw_bytes().to_vec(),
            key,
        })
    }

    pub fn from_pem(pem: &[u8]) -> Option<Self> {
        let (label, der) = der::pem::decode_vec(pem).ok()?;
        (label == "CERTIFICATE").then_some(())?;
        Self::from_der(&der)
    }

    /// Checks a PKCS#1 v1.5 SHA-256 signature by this certificate's key.
    pub fn verifies(&self, data: &[u8], signature: &[u8]) -> bool {
        let Ok(signature) = Signature::try_from(signature) else {
            return false;
        };
        VerifyingKey::<Sha256>::new(self.key.clone())
            .verify(data, &signature)
            .is_ok()
    }
}
