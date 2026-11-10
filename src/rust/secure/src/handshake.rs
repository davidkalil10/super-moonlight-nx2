extern crate alloc;

use crate::{
    ANSWER_BYTES, Error, FINISH_BYTES, HELLO_BYTES, ID_BYTES, Id, Key, MAGIC, Mode, Opener, Sealer,
    Status, VERSION,
};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand_core::{CryptoRng, RngCore};
use sha2::{Digest, Sha256};
use spake2::{Ed25519Group, Identity, Password, Spake2};
use subtle::ConstantTimeEq;
use zeroize::Zeroize;

const ELEMENT_BYTES: usize = 33;
const CONSOLE: &[u8] = b"moonlight-nx2-console";
const HELPER: &[u8] = b"moonlight-nx2-host";

type Element = [u8; ELEMENT_BYTES];
type Proof = [u8; FINISH_BYTES];

fn password(mode: Mode, secret: &[u8]) -> Password {
    let label: &[u8] = match mode {
        Mode::Pair => b"pair:",
        Mode::Session => b"session:",
    };
    let mut bytes = alloc::vec::Vec::with_capacity(label.len() + secret.len());
    bytes.extend_from_slice(label);
    bytes.extend_from_slice(secret);
    let password = Password::new(&bytes);
    bytes.zeroize();
    password
}

fn transcript(mode: Mode, console: &Id, helper: &Id, x: &Element, y: &Element) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(b"moonlight-nx2 MNS1");
    hash.update([VERSION, mode as u8]);
    hash.update(console);
    hash.update(helper);
    hash.update(x);
    hash.update(y);
    hash.finalize().into()
}

struct Keys {
    proof_console: Proof,
    proof_helper: Proof,
    console_to_helper: Key,
    helper_to_console: Key,
    pairing: Key,
}

impl Drop for Keys {
    fn drop(&mut self) {
        self.console_to_helper.zeroize();
        self.helper_to_console.zeroize();
        self.pairing.zeroize();
    }
}

fn derive(shared: &[u8], transcript: &[u8; 32]) -> Keys {
    let kdf = Hkdf::<Sha256>::new(Some(transcript), shared);
    let expand = |label: &[u8]| {
        let mut key = [0; 32];
        kdf.expand(label, &mut key)
            .expect("32 bytes fit HKDF-SHA256");
        key
    };
    let prove = |label: &[u8]| {
        let mut key = expand(label);
        let mut mac = Hmac::<Sha256>::new_from_slice(&key).expect("any key length");
        mac.update(transcript);
        key.zeroize();
        mac.finalize().into_bytes().into()
    };
    Keys {
        proof_console: prove(b"confirm console"),
        proof_helper: prove(b"confirm helper"),
        console_to_helper: expand(b"records console to helper"),
        helper_to_console: expand(b"records helper to console"),
        pairing: expand(b"pairing key"),
    }
}

/// The two ends of an open connection. `pairing_key` is set after a pairing: store it, it is
/// the password of every later session.
pub struct Established {
    pub mode: Mode,
    pub peer: Id,
    pub pairing_key: Option<Key>,
    pub sealer: Sealer,
    pub opener: Opener,
}

impl Drop for Established {
    fn drop(&mut self) {
        self.pairing_key.zeroize();
    }
}

/// The console's first message, as the helper reads it.
#[derive(Clone, Copy)]
pub struct Hello {
    pub mode: Mode,
    pub console: Id,
    element: Element,
}

impl Hello {
    pub fn parse(bytes: &[u8; HELLO_BYTES]) -> Result<Self, Error> {
        if bytes[..4] != MAGIC {
            return Err(Error::Malformed);
        }
        if bytes[4] != VERSION {
            return Err(Error::Version);
        }
        let mode = match bytes[5] {
            1 => Mode::Pair,
            2 => Mode::Session,
            _ => return Err(Error::Malformed),
        };
        Ok(Self {
            mode,
            console: bytes[6..6 + ID_BYTES].try_into().expect("id"),
            element: bytes[6 + ID_BYTES..].try_into().expect("element"),
        })
    }

    /// Answers with the helper's half. `secret` is the code typed on the PC (pair) or the
    /// stored key of `self.console` (session).
    pub fn answer(
        &self,
        helper: Id,
        secret: &[u8],
        random: impl CryptoRng + RngCore,
    ) -> Result<(Pending, [u8; ANSWER_BYTES]), Error> {
        let (spake, element) = Spake2::<Ed25519Group>::start_b_with_rng(
            &password(self.mode, secret),
            &Identity::new(CONSOLE),
            &Identity::new(HELPER),
            random,
        );
        let element: Element = element
            .as_slice()
            .try_into()
            .map_err(|_| Error::Malformed)?;
        let mut shared = spake.finish(&self.element).map_err(|_| Error::Malformed)?;
        let transcript = transcript(self.mode, &self.console, &helper, &self.element, &element);
        let keys = derive(&shared, &transcript);
        shared.zeroize();
        let mut answer = head(Status::Ok, &helper);
        answer[22..55].copy_from_slice(&element);
        answer[55..].copy_from_slice(&keys.proof_helper);
        Ok((
            Pending {
                mode: self.mode,
                console: self.console,
                keys,
            },
            answer,
        ))
    }
}

fn head(status: Status, helper: &Id) -> [u8; ANSWER_BYTES] {
    let mut answer = [0; ANSWER_BYTES];
    answer[..4].copy_from_slice(&MAGIC);
    answer[4] = VERSION;
    answer[5] = status as u8;
    answer[6..22].copy_from_slice(helper);
    answer
}

/// The helper's answer when it will not go on.
pub fn refuse(status: Status, helper: Id) -> [u8; ANSWER_BYTES] {
    head(status, &helper)
}

/// The helper after its answer, waiting for the console's proof.
pub struct Pending {
    mode: Mode,
    console: Id,
    keys: Keys,
}

impl Pending {
    pub fn finish(self, proof: &[u8; FINISH_BYTES]) -> Result<Established, Error> {
        if !bool::from(self.keys.proof_console.ct_eq(proof)) {
            return Err(Error::Confirm);
        }
        Ok(Established {
            mode: self.mode,
            peer: self.console,
            pairing_key: (self.mode == Mode::Pair).then_some(self.keys.pairing),
            sealer: Sealer::new(self.keys.helper_to_console),
            opener: Opener::new(self.keys.console_to_helper),
        })
    }
}

/// The console's side of the handshake.
pub struct Initiator {
    mode: Mode,
    console: Id,
    element: Element,
    spake: Spake2<Ed25519Group>,
}

impl Initiator {
    /// `secret` is the code shown to the user (pair) or the stored key (session).
    pub fn start(
        mode: Mode,
        console: Id,
        secret: &[u8],
        random: impl CryptoRng + RngCore,
    ) -> (Self, [u8; HELLO_BYTES]) {
        let (spake, element) = Spake2::<Ed25519Group>::start_a_with_rng(
            &password(mode, secret),
            &Identity::new(CONSOLE),
            &Identity::new(HELPER),
            random,
        );
        let element: Element = element.as_slice().try_into().expect("SPAKE2 element");
        let mut hello = [0; HELLO_BYTES];
        hello[..4].copy_from_slice(&MAGIC);
        hello[4] = VERSION;
        hello[5] = mode as u8;
        hello[6..22].copy_from_slice(&console);
        hello[22..].copy_from_slice(&element);
        (
            Self {
                mode,
                console,
                element,
                spake,
            },
            hello,
        )
    }

    /// Checks the helper's answer and returns the open connection with the proof to send.
    pub fn finish(
        self,
        answer: &[u8; ANSWER_BYTES],
    ) -> Result<(Established, [u8; FINISH_BYTES]), Error> {
        if answer[..4] != MAGIC {
            return Err(Error::Malformed);
        }
        if answer[4] != VERSION {
            return Err(Error::Version);
        }
        match answer[5] {
            0 => {}
            1 => return Err(Error::Refused(Status::UnknownConsole)),
            2 => return Err(Error::Refused(Status::PairingUnavailable)),
            3 => return Err(Error::Refused(Status::Version)),
            _ => return Err(Error::Malformed),
        }
        let helper: Id = answer[6..22].try_into().expect("id");
        let element: Element = answer[22..55].try_into().expect("element");
        let mut shared = self.spake.finish(&element).map_err(|_| Error::Malformed)?;
        let transcript = transcript(self.mode, &self.console, &helper, &self.element, &element);
        let keys = derive(&shared, &transcript);
        shared.zeroize();
        if !bool::from(keys.proof_helper.ct_eq(&answer[55..])) {
            return Err(Error::Confirm);
        }
        Ok((
            Established {
                mode: self.mode,
                peer: helper,
                pairing_key: (self.mode == Mode::Pair).then_some(keys.pairing),
                sealer: Sealer::new(keys.console_to_helper),
                opener: Opener::new(keys.helper_to_console),
            },
            keys.proof_console,
        ))
    }
}
