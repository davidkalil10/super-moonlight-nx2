use moonlight_nx2_secure::{
    ANSWER_BYTES, Error, Established, HELLO_BYTES, Hello, Initiator, MAX_PLAINTEXT, MAX_RECORD,
    Mode, Opener, Random, Status, code_ok, new_code, refuse,
};

const CONSOLE: [u8; 16] = [0xc0; 16];
const HELPER: [u8; 16] = [0x4e; 16];
const CODE: &[u8] = b"12345678";

/// A fixed stream per seed: the tests need repeatable handshakes, not secrecy.
fn random(seed: u64) -> Random<impl FnMut(&mut [u8])> {
    let mut state = seed;
    Random(move |bytes: &mut [u8]| {
        for byte in bytes {
            state = state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            *byte = (state >> 56) as u8;
        }
    })
}

fn connect(
    mode: Mode,
    console_secret: &[u8],
    helper_secret: &[u8],
) -> Result<(Established, Established), Error> {
    let (initiator, hello) = Initiator::start(mode, CONSOLE, console_secret, random(1));
    let (pending, answer) = Hello::parse(&hello)?.answer(HELPER, helper_secret, random(2))?;
    let (console, proof) = initiator.finish(&answer)?;
    Ok((console, pending.finish(&proof)?))
}

fn send(from: &mut Established, to: &mut Established, text: &[u8]) -> Result<Vec<u8>, Error> {
    let mut record = [0; MAX_RECORD];
    let size = from.sealer.seal(text, &mut record)?;
    let body = Opener::body_bytes([record[0], record[1]])?;
    assert_eq!(size, 2 + body);
    let opened = to.opener.open(&mut record[2..size])?;
    Ok(record[2..2 + opened].to_vec())
}

#[test]
fn pairing_yields_one_key_and_that_key_opens_sessions() {
    let (mut console, mut helper) = connect(Mode::Pair, CODE, CODE).unwrap();
    assert_eq!((console.peer, helper.peer), (HELPER, CONSOLE));
    let key = console.pairing_key.unwrap();
    assert_eq!(helper.pairing_key, Some(key));
    assert_eq!(send(&mut console, &mut helper, b"list").unwrap(), b"list");
    assert_eq!(send(&mut helper, &mut console, b"apps").unwrap(), b"apps");

    let (mut console, mut helper) = connect(Mode::Session, &key, &key).unwrap();
    assert_eq!((console.pairing_key, helper.pairing_key), (None, None));
    let large = vec![7; MAX_PLAINTEXT];
    assert_eq!(send(&mut console, &mut helper, &large).unwrap(), large);
}

#[test]
fn a_wrong_code_or_key_is_caught_by_the_console_before_it_proves_anything() {
    assert!(matches!(
        connect(Mode::Pair, CODE, b"12345679"),
        Err(Error::Confirm)
    ));
    assert!(matches!(
        connect(Mode::Session, &[1; 32], &[2; 32]),
        Err(Error::Confirm)
    ));
}

#[test]
fn the_helper_rejects_a_console_that_cannot_prove_the_secret() {
    let (_, hello) = Initiator::start(Mode::Pair, CONSOLE, b"00000000", random(1));
    let (pending, answer) = Hello::parse(&hello)
        .unwrap()
        .answer(HELPER, CODE, random(2))
        .unwrap();
    let guessed = Initiator::start(Mode::Pair, CONSOLE, b"00000000", random(1)).0;
    assert!(matches!(guessed.finish(&answer), Err(Error::Confirm)));
    assert!(matches!(pending.finish(&[0; 32]), Err(Error::Confirm)));
}

#[test]
fn any_changed_handshake_byte_fails() {
    let (initiator, hello) = Initiator::start(Mode::Session, CONSOLE, &[9; 32], random(1));
    let (_, answer) = Hello::parse(&hello)
        .unwrap()
        .answer(HELPER, &[9; 32], random(2))
        .unwrap();
    for index in [6, 21, 22, 54, 55, ANSWER_BYTES - 1] {
        let mut changed = answer;
        changed[index] ^= 1;
        let (again, _) = Initiator::start(Mode::Session, CONSOLE, &[9; 32], random(1));
        assert!(again.finish(&changed).is_err(), "answer byte {index}");
    }
    let (console, proof) = initiator.finish(&answer).unwrap();
    drop(console);
    for index in [6, 21, 22, HELLO_BYTES - 1] {
        let mut changed = hello;
        changed[index] ^= 1;
        let outcome = Hello::parse(&changed)
            .and_then(|hello| hello.answer(HELPER, &[9; 32], random(2)))
            .and_then(|(pending, _)| pending.finish(&proof));
        assert!(outcome.is_err(), "hello byte {index}");
    }
}

#[test]
fn the_mode_cannot_be_switched_in_flight() {
    let key = [5; 32];
    let (initiator, mut hello) = Initiator::start(Mode::Session, CONSOLE, &key, random(1));
    hello[5] = Mode::Pair as u8;
    let (_, answer) = Hello::parse(&hello)
        .unwrap()
        .answer(HELPER, &key, random(2))
        .unwrap();
    assert!(matches!(initiator.finish(&answer), Err(Error::Confirm)));
}

#[test]
fn a_replayed_hello_gets_an_answer_the_old_proof_does_not_fit() {
    let key = [5; 32];
    let (initiator, hello) = Initiator::start(Mode::Session, CONSOLE, &key, random(1));
    let parsed = Hello::parse(&hello).unwrap();
    let (_, first) = parsed.answer(HELPER, &key, random(2)).unwrap();
    let (_, proof) = initiator.finish(&first).unwrap();
    let (replayed, second) = parsed.answer(HELPER, &key, random(3)).unwrap();
    assert_ne!(first, second);
    assert!(matches!(replayed.finish(&proof), Err(Error::Confirm)));
}

#[test]
fn records_cannot_be_changed_replayed_reordered_or_crossed() {
    let key = [5; 32];
    let (mut console, mut helper) = connect(Mode::Session, &key, &key).unwrap();
    let mut first = [0; MAX_RECORD];
    let mut second = [0; MAX_RECORD];
    let first_size = console.sealer.seal(b"start", &mut first).unwrap();
    let second_size = console.sealer.seal(b"stop", &mut second).unwrap();

    let mut changed = first;
    changed[3] ^= 1;
    assert_eq!(
        helper.opener.open(&mut changed[2..first_size]),
        Err(Error::Record)
    );
    let mut early = second;
    assert_eq!(
        helper.opener.open(&mut early[2..second_size]),
        Err(Error::Record)
    );
    let mut own = first;
    assert_eq!(
        console.opener.open(&mut own[2..first_size]),
        Err(Error::Record)
    );

    let mut body = first;
    assert_eq!(helper.opener.open(&mut body[2..first_size]), Ok(5));
    let mut replayed = first;
    assert_eq!(
        helper.opener.open(&mut replayed[2..first_size]),
        Err(Error::Record)
    );
    assert_eq!(helper.opener.open(&mut second[2..second_size]), Ok(4));
}

#[test]
fn record_sizes_are_bounded() {
    let key = [5; 32];
    let (mut console, _) = connect(Mode::Session, &key, &key).unwrap();
    let mut out = [0; MAX_RECORD + 16];
    assert_eq!(console.sealer.seal(&[], &mut out), Err(Error::Record));
    assert_eq!(
        console.sealer.seal(&[0; MAX_PLAINTEXT + 1], &mut out),
        Err(Error::Record)
    );
    assert_eq!(
        console.sealer.seal(b"x", &mut out[..18]),
        Err(Error::Record)
    );
    assert_eq!(Opener::body_bytes(16u16.to_le_bytes()), Err(Error::Record));
    assert_eq!(
        Opener::body_bytes((MAX_PLAINTEXT as u16 + 17).to_le_bytes()),
        Err(Error::Record)
    );
}

#[test]
fn refusals_and_foreign_versions_end_the_attempt() {
    for status in [
        Status::UnknownConsole,
        Status::PairingUnavailable,
        Status::Version,
    ] {
        let (initiator, _) = Initiator::start(Mode::Session, CONSOLE, &[5; 32], random(1));
        assert_eq!(
            initiator.finish(&refuse(status, HELPER)).err(),
            Some(Error::Refused(status))
        );
    }
    let (initiator, mut hello) = Initiator::start(Mode::Session, CONSOLE, &[5; 32], random(1));
    hello[4] = 2;
    assert_eq!(Hello::parse(&hello).err(), Some(Error::Version));
    hello[4] = 1;
    hello[0] = b'X';
    assert_eq!(Hello::parse(&hello).err(), Some(Error::Malformed));
    let mut answer = refuse(Status::Ok, HELPER);
    answer[4] = 2;
    assert_eq!(initiator.finish(&answer).err(), Some(Error::Version));
}

#[test]
fn codes_are_eight_digits() {
    let mut source = random(7);
    for _ in 0..1000 {
        assert!(code_ok(&new_code(&mut source)));
    }
    assert!(!code_ok(b"1234567"));
    assert!(!code_ok(b"1234567a"));
}
