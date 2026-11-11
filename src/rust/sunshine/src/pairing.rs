//! The GameStream PIN pairing as Sunshine runs it for generation 7 hosts: four HTTP steps
//! with AES-128-ECB and SHA-256, then one pinned HTTPS step. Sans-IO: the caller sends each
//! request and hands back the body.

use alloc::{format, string::String, vec::Vec};

use aes::{
    Aes128,
    cipher::{BlockCipherDecrypt, BlockCipherEncrypt, KeyInit},
};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::Zeroize;

use crate::{
    hex,
    identity::{Identity, PeerCert},
    random::Random,
    xml,
};

pub const PIN_DIGITS: usize = 4;
const BLOCK: usize = 16;
const HASH: usize = 32;
const SIGNATURE_MAX: usize = 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Error {
    /// Sunshine said no: another pairing is running or the PIN was refused.
    Refused,
    /// The server's proof does not match: the PIN typed differs, or someone is in between.
    WrongPin,
    /// The server's pairing secret is not signed by the certificate it sent.
    Untrusted,
    Malformed,
    Random,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Stage {
    ServerCert,
    ClientChallenge,
    ServerChallengeResponse,
    ClientPairingSecret,
    PairChallenge,
    Done,
}

/// Where the next request goes: `/pair?` plus the common arguments plus this query.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Request {
    Http(String),
    Https(String),
}

pub struct Pairing {
    stage: Stage,
    key: Aes128,
    challenge: [u8; BLOCK],
    client_secret: [u8; BLOCK],
    server_challenge: [u8; BLOCK],
    server_response: [u8; HASH],
    salt: [u8; BLOCK],
    server: Option<PeerCert>,
    random: Random,
}

impl Drop for Pairing {
    fn drop(&mut self) {
        self.challenge.zeroize();
        self.client_secret.zeroize();
        self.server_challenge.zeroize();
        self.server_response.zeroize();
    }
}

/// The AES key both sides derive from the salt and the PIN.
pub fn key_of(salt: &[u8; BLOCK], pin: &[u8; PIN_DIGITS]) -> [u8; BLOCK] {
    let digest = Sha256::new().chain_update(salt).chain_update(pin).finalize();
    let mut key = [0; BLOCK];
    key.copy_from_slice(&digest[..BLOCK]);
    key
}

fn ecb(key: &Aes128, data: &[u8], encrypt: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    for chunk in data.chunks(BLOCK) {
        let mut block = aes::Block::default();
        block[..chunk.len()].copy_from_slice(chunk);
        if encrypt {
            key.encrypt_block(&mut block);
        } else {
            key.decrypt_block(&mut block);
        }
        out.extend_from_slice(&block);
    }
    out
}

/// A random four-digit PIN.
pub fn new_pin(random: Random) -> Result<[u8; PIN_DIGITS], Error> {
    let mut pin = [0; PIN_DIGITS];
    for digit in &mut pin {
        loop {
            let [byte] = random.array::<1>().map_err(|_| Error::Random)?;
            if byte < 250 {
                *digit = b'0' + byte % 10;
                break;
            }
        }
    }
    Ok(pin)
}

/// The `<paired>1</paired>` every successful step answers with, and the body's status.
fn paired(body: &str) -> Result<(), Error> {
    match xml::root_status(body) {
        Some((200, _)) => {}
        Some(_) => return Err(Error::Refused),
        None => return Err(Error::Malformed),
    }
    match xml::text(body, "paired").as_deref().map(str::trim) {
        Some("1") => Ok(()),
        Some(_) => Err(Error::Refused),
        None => Err(Error::Malformed),
    }
}

fn hex_field(body: &str, tag: &str) -> Result<Vec<u8>, Error> {
    let text = xml::text(body, tag).ok_or(Error::Malformed)?;
    hex::decode(&text).ok_or(Error::Malformed)
}

impl Pairing {
    pub fn new(pin: &[u8; PIN_DIGITS], random: Random) -> Result<Self, Error> {
        let salt = random.array().map_err(|_| Error::Random)?;
        let challenge = random.array().map_err(|_| Error::Random)?;
        let client_secret = random.array().map_err(|_| Error::Random)?;
        let mut key = key_of(&salt, pin);
        let cipher = Aes128::new(&key.into());
        key.zeroize();
        Ok(Self {
            stage: Stage::ServerCert,
            key: cipher,
            challenge,
            client_secret,
            server_challenge: [0; BLOCK],
            server_response: [0; HASH],
            salt,
            server: None,
            random,
        })
    }

    pub fn stage(&self) -> Stage {
        self.stage
    }

    /// The query of the next request, after the common `uniqueid`, `uuid` and device name.
    pub fn request(&self, identity: &Identity) -> Option<Request> {
        let request = match self.stage {
            Stage::ServerCert => Request::Http(format!(
                "phrase=getservercert&salt={}&clientcert={}",
                hex::encode(&self.salt),
                hex::encode(identity.cert_pem().as_bytes())
            )),
            Stage::ClientChallenge => Request::Http(format!(
                "clientchallenge={}",
                hex::encode(&ecb(&self.key, &self.challenge, true))
            )),
            Stage::ServerChallengeResponse => {
                let mut hash = Sha256::new()
                    .chain_update(self.server_challenge)
                    .chain_update(identity.cert_signature())
                    .chain_update(self.client_secret)
                    .finalize();
                let encrypted = ecb(&self.key, &hash, true);
                hash.zeroize();
                Request::Http(format!("serverchallengeresp={}", hex::encode(&encrypted)))
            }
            Stage::ClientPairingSecret => {
                let mut secret = Vec::from(self.client_secret);
                secret.extend_from_slice(&identity.sign(&self.client_secret));
                let text = hex::encode(&secret);
                secret.zeroize();
                Request::Http(format!("clientpairingsecret={text}"))
            }
            Stage::PairChallenge => Request::Https(String::from("phrase=pairchallenge")),
            Stage::Done => return None,
        };
        Some(request)
    }

    /// The server's certificate, known after the first step; the HTTPS step pins it.
    pub fn server_cert(&self) -> Option<&[u8]> {
        self.server.as_ref().map(|server| server.der.as_slice())
    }

    /// Takes the body of the current step's reply.
    pub fn accept(&mut self, body: &str) -> Result<Stage, Error> {
        paired(body)?;
        self.stage = match self.stage {
            Stage::ServerCert => {
                let pem = hex_field(body, "plaincert")?;
                self.server = Some(PeerCert::from_pem(&pem).ok_or(Error::Malformed)?);
                Stage::ClientChallenge
            }
            Stage::ClientChallenge => {
                let encrypted = hex_field(body, "challengeresponse")?;
                if encrypted.len() != HASH + BLOCK {
                    return Err(Error::Malformed);
                }
                let mut plain = ecb(&self.key, &encrypted, false);
                self.server_response.copy_from_slice(&plain[..HASH]);
                self.server_challenge
                    .copy_from_slice(&plain[HASH..HASH + BLOCK]);
                plain.zeroize();
                Stage::ServerChallengeResponse
            }
            Stage::ServerChallengeResponse => {
                self.check_server_secret(&hex_field(body, "pairingsecret")?)?;
                Stage::ClientPairingSecret
            }
            Stage::ClientPairingSecret => Stage::PairChallenge,
            Stage::PairChallenge => Stage::Done,
            Stage::Done => return Err(Error::Malformed),
        };
        Ok(self.stage)
    }

    fn check_server_secret(&self, secret: &[u8]) -> Result<(), Error> {
        let server = self.server.as_ref().ok_or(Error::Malformed)?;
        if secret.len() <= BLOCK || secret.len() > BLOCK + SIGNATURE_MAX {
            return Err(Error::Malformed);
        }
        let (server_secret, signature) = secret.split_at(BLOCK);
        if !server.verifies(server_secret, signature) {
            return Err(Error::Untrusted);
        }

        let expected = Sha256::new()
            .chain_update(self.challenge)
            .chain_update(&server.signature)
            .chain_update(server_secret)
            .finalize();
        if !bool::from(expected.as_slice().ct_eq(&self.server_response)) {
            return Err(Error::WrongPin);
        }
        Ok(())
    }

    pub fn random(&self) -> Random {
        self.random
    }
}
