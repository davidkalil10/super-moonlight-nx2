//! The helper's identity and the consoles it is paired with, under `helper/` in the config
//! directory. Files are private to the user and replaced whole.

use moonlight_nx2_secure::{ID_BYTES, Id, KEY_BYTES, Key};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

pub const MAX_CONSOLES: usize = 16;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Console {
    pub id: Id,
    pub key: Key,
    /// Seconds since the Unix epoch.
    pub paired_at: u64,
    pub address: String,
}

#[derive(Serialize, Deserialize)]
struct Saved {
    id: String,
    key: String,
    paired_at: u64,
    address: String,
}

#[derive(Serialize, Deserialize)]
struct File {
    version: u32,
    consoles: Vec<Saved>,
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn unhex<const N: usize>(text: &str) -> Option<[u8; N]> {
    let text = text.as_bytes();
    if text.len() != N * 2 {
        return None;
    }
    let digit = |byte: u8| match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    };
    let mut bytes = [0; N];
    for (out, pair) in bytes.iter_mut().zip(text.chunks_exact(2)) {
        *out = digit(pair[0])? << 4 | digit(pair[1])?;
    }
    Some(bytes)
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

pub struct Store {
    directory: PathBuf,
}

impl Store {
    /// Opens the directory, creating it private to the user.
    pub fn open(directory: &Path) -> io::Result<Self> {
        if !directory.is_dir() {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(directory)?;
        }
        fs::set_permissions(directory, fs::Permissions::from_mode(0o700))?;
        Ok(Self {
            directory: directory.to_path_buf(),
        })
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    fn write(&self, name: &str, bytes: &[u8]) -> io::Result<()> {
        let temporary = self.directory.join(format!("{name}.new"));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(temporary, self.directory.join(name))
    }

    /// This helper's identity, made on first use from `random`.
    pub fn identity(&self, random: impl FnOnce(&mut [u8])) -> io::Result<Id> {
        let path = self.directory.join("identity");
        match fs::read_to_string(&path) {
            Ok(text) => unhex::<ID_BYTES>(text.trim()).ok_or(invalid("helper identity")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let mut id = [0; ID_BYTES];
                random(&mut id);
                self.write("identity", format!("{}\n", hex(&id)).as_bytes())?;
                Ok(id)
            }
            Err(error) => Err(error),
        }
    }

    pub fn consoles(&self) -> io::Result<Vec<Console>> {
        let text = match fs::read(self.directory.join("consoles.json")) {
            Ok(text) => text,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let file: File = serde_json::from_slice(&text).map_err(|_| invalid("consoles.json"))?;
        if file.version != 1 || file.consoles.len() > MAX_CONSOLES {
            return Err(invalid("consoles.json"));
        }
        file.consoles
            .into_iter()
            .map(|saved| {
                Some(Console {
                    id: unhex::<ID_BYTES>(&saved.id)?,
                    key: unhex::<KEY_BYTES>(&saved.key)?,
                    paired_at: saved.paired_at,
                    address: saved.address,
                })
            })
            .collect::<Option<Vec<_>>>()
            .ok_or(invalid("consoles.json"))
    }

    pub fn find(&self, id: &Id) -> io::Result<Option<Console>> {
        Ok(self
            .consoles()?
            .into_iter()
            .find(|console| console.id == *id))
    }

    fn save(&self, consoles: &[Console]) -> io::Result<()> {
        let file = File {
            version: 1,
            consoles: consoles
                .iter()
                .map(|console| Saved {
                    id: hex(&console.id),
                    key: hex(&console.key),
                    paired_at: console.paired_at,
                    address: console.address.clone(),
                })
                .collect(),
        };
        let mut text = serde_json::to_vec_pretty(&file).map_err(|_| invalid("consoles.json"))?;
        text.push(b'\n');
        self.write("consoles.json", &text)
    }

    /// Adds a console, replacing an earlier pairing of the same console. The oldest pairing
    /// makes room when the list is full.
    pub fn add(&self, console: Console) -> io::Result<()> {
        let mut consoles = self.consoles()?;
        consoles.retain(|known| known.id != console.id);
        if consoles.len() == MAX_CONSOLES {
            consoles.remove(0);
        }
        consoles.push(console);
        self.save(&consoles)
    }

    /// Forgets every console whose id starts with `prefix` (hex); all of them for "all".
    pub fn remove(&self, prefix: &str) -> io::Result<usize> {
        let mut consoles = self.consoles()?;
        let before = consoles.len();
        consoles.retain(|console| prefix != "all" && !hex(&console.id).starts_with(prefix));
        if consoles.len() != before {
            self.save(&consoles)?;
        }
        Ok(before - consoles.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("moonlight-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        path
    }

    fn console(id: u8) -> Console {
        Console {
            id: [id; ID_BYTES],
            key: [id ^ 0xff; KEY_BYTES],
            paired_at: u64::from(id),
            address: format!("192.0.2.{id}"),
        }
    }

    #[test]
    fn pairings_survive_a_reload_and_files_are_private() {
        let directory = scratch("reload");
        let store = Store::open(&directory).unwrap();
        let identity = store.identity(|bytes| bytes.fill(7)).unwrap();
        store.add(console(1)).unwrap();
        store.add(console(2)).unwrap();

        let again = Store::open(&directory).unwrap();
        assert_eq!(
            again.identity(|_| panic!("already made")).unwrap(),
            identity
        );
        assert_eq!(again.consoles().unwrap(), [console(1), console(2)]);
        assert_eq!(again.find(&[2; ID_BYTES]).unwrap(), Some(console(2)));
        let mode = |name: &str| {
            fs::metadata(directory.join(name))
                .unwrap()
                .permissions()
                .mode()
                & 0o777
        };
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!((mode("identity"), mode("consoles.json")), (0o600, 0o600));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn pairing_again_replaces_the_key_and_unpair_matches_a_prefix() {
        let directory = scratch("replace");
        let store = Store::open(&directory).unwrap();
        store.add(console(1)).unwrap();
        store.add(console(0x2a)).unwrap();
        let mut renewed = console(1);
        renewed.key = [9; KEY_BYTES];
        store.add(renewed.clone()).unwrap();
        assert_eq!(store.consoles().unwrap(), [console(0x2a), renewed]);

        assert_eq!(store.remove("ffff").unwrap(), 0);
        assert_eq!(store.remove("2a2a").unwrap(), 1);
        assert_eq!(store.find(&[0x2a; ID_BYTES]).unwrap(), None);
        assert_eq!(store.remove("all").unwrap(), 1);
        assert!(store.consoles().unwrap().is_empty());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_damaged_file_is_an_error_not_an_empty_list() {
        let directory = scratch("damaged");
        let store = Store::open(&directory).unwrap();
        fs::write(
            directory.join("consoles.json"),
            b"{\"version\":1,\"consoles\":[{\"id\":\"zz\"",
        )
        .unwrap();
        assert!(store.consoles().is_err());
        fs::write(
            directory.join("consoles.json"),
            b"{\"version\":2,\"consoles\":[]}",
        )
        .unwrap();
        assert!(store.consoles().is_err());
        fs::remove_dir_all(directory).unwrap();
    }
}
