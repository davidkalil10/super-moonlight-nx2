extern crate alloc;

use alloc::{ffi::CString, format, vec::Vec};
use core::{
    ffi::{CStr, c_char, c_int, c_void},
    ptr::NonNull,
};
use moonlight_nx2_ui::store::Files;

unsafe extern "C" {
    fn fopen(path: *const c_char, mode: *const c_char) -> *mut c_void;
    fn fread(data: *mut c_void, size: usize, count: usize, file: *mut c_void) -> usize;
    fn fwrite(data: *const c_void, size: usize, count: usize, file: *mut c_void) -> usize;
    fn ferror(file: *mut c_void) -> c_int;
    fn fflush(file: *mut c_void) -> c_int;
    fn fclose(file: *mut c_void) -> c_int;
    fn remove(path: *const c_char) -> c_int;
    fn rename(from: *const c_char, to: *const c_char) -> c_int;
}

struct File(Option<NonNull<c_void>>);

impl File {
    fn open(path: &CStr, mode: &CStr) -> Option<Self> {
        NonNull::new(unsafe { fopen(path.as_ptr(), mode.as_ptr()) }).map(|p| Self(Some(p)))
    }

    fn pointer(&self) -> *mut c_void {
        self.0.unwrap().as_ptr()
    }

    fn close(&mut self) -> bool {
        self.0
            .take()
            .is_none_or(|p| unsafe { fclose(p.as_ptr()) } == 0)
    }
}

impl Drop for File {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(target_os = "none")]
fn names(path: &CStr) -> Vec<alloc::string::String> {
    unsafe extern "C" {
        fn moonlightPlatformDirectoryNames(
            path: *const c_char,
            out: *mut c_char,
            size: usize,
        ) -> usize;
    }
    const NAMES_BYTES: usize = 16 * 1024;
    let mut list = alloc::vec![0u8; NAMES_BYTES];
    let length = unsafe {
        moonlightPlatformDirectoryNames(path.as_ptr(), list.as_mut_ptr().cast(), list.len())
    };
    list.truncate(length.min(NAMES_BYTES));
    list.split(|byte| *byte == b'\n')
        .filter_map(|name| core::str::from_utf8(name).ok())
        .map(alloc::string::String::from)
        .collect()
}

#[cfg(not(target_os = "none"))]
fn names(path: &CStr) -> Vec<alloc::string::String> {
    use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
    std::fs::read_dir(OsStr::from_bytes(path.to_bytes()))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().into_string().ok())
        .collect()
}

#[cfg(target_os = "none")]
fn status(path: &CStr) -> u32 {
    unsafe extern "C" {
        fn moonlightPlatformFileStatus(path: *const c_char) -> u32;
    }
    unsafe { moonlightPlatformFileStatus(path.as_ptr()) }
}

#[cfg(not(target_os = "none"))]
fn status(path: &CStr) -> u32 {
    use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
    match std::fs::metadata(OsStr::from_bytes(path.to_bytes())) {
        Ok(_) => 1,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
        Err(_) => 2,
    }
}

/// Copies the newest runtime log into the dated `logs` folder on the SD card.
#[cfg(target_os = "none")]
pub fn export_log() -> bool {
    unsafe extern "C" {
        fn moonlightPlatformExportLog() -> bool;
    }
    unsafe { moonlightPlatformExportLog() }
}

#[cfg(not(target_os = "none"))]
pub fn export_log() -> bool {
    false
}

#[derive(Clone)]
pub struct Directory {
    path: CString,
}

impl Directory {
    pub fn create(path: &CStr) -> Option<Self> {
        if path.to_bytes().len() >= 448 {
            return None;
        }
        #[cfg(target_os = "none")]
        let created = {
            unsafe extern "C" {
                fn moonlightPlatformDirectoryExclusive(path: *const c_char) -> bool;
            }
            unsafe { moonlightPlatformDirectoryExclusive(path.as_ptr()) }
        };
        #[cfg(not(target_os = "none"))]
        let created = {
            use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
            std::fs::create_dir(OsStr::from_bytes(path.to_bytes())).is_ok()
        };
        created.then(|| Self { path: path.into() })
    }

    pub fn open(path: &CStr) -> Option<Self> {
        #[cfg(target_os = "none")]
        let created = {
            unsafe extern "C" {
                fn moonlightPlatformDirectoryCreate(path: *const c_char) -> bool;
            }
            unsafe { moonlightPlatformDirectoryCreate(path.as_ptr()) }
        };
        #[cfg(not(target_os = "none"))]
        let created = {
            use std::{ffi::OsStr, os::unix::ffi::OsStrExt};
            std::fs::create_dir_all(OsStr::from_bytes(path.to_bytes())).is_ok()
        };
        (created && path.to_bytes().len() < 448).then(|| Self { path: path.into() })
    }

    fn path(&self, name: &str, suffix: &str) -> Option<CString> {
        let known = matches!(
            name,
            "hosts.json" | "settings.json" | "settings-0.json" | "settings-1.json" | "pairings"
        ) || name == moonlight_nx2_app::direct_keys::FILE;
        if !known {
            return None;
        }
        CString::new(format!("{}/{name}{suffix}", self.path.to_str().ok()?)).ok()
    }
}

/// Whether `name` is `<owner>-<app>.png`, or its `.part` file, for a numeric app id.
pub fn is_cover_of(name: &str, owner: &str) -> bool {
    let Some(rest) = name
        .strip_prefix(owner)
        .and_then(|rest| rest.strip_prefix('-'))
    else {
        return false;
    };
    let rest = rest.strip_suffix(".part").unwrap_or(rest);
    rest.strip_suffix(".png")
        .is_some_and(|app| !app.is_empty() && app.bytes().all(|byte| byte.is_ascii_digit()))
        && !owner.is_empty()
}

/// Private application cover cache, separate from settings and host persistence.
pub struct CoverDirectory(Directory);

impl CoverDirectory {
    pub fn open(path: &CStr) -> Option<Self> {
        Directory::open(path).map(Self)
    }

    fn path(
        &self,
        host: &moonlight_nx2_ui::model::Host,
        app: u32,
        suffix: &str,
    ) -> Option<CString> {
        let valid = |name: &str| {
            !name.is_empty()
                && name != "."
                && name != ".."
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        };
        let id = host.uniqueid.as_str();
        let id = if valid(id) { id } else { host.address.as_str() };
        if !valid(id) || app == 0 {
            return None;
        }
        CString::new(format!(
            "{}/{id}-{app}.png{suffix}",
            self.0.path.to_str().ok()?
        ))
        .ok()
    }

    /// Deletes every cached cover of the host and returns how many files went.
    pub fn forget(&self, host: &moonlight_nx2_ui::model::Host) -> usize {
        let Some(directory) = self.0.path.to_str().ok() else {
            return 0;
        };
        let Ok(listing) = CString::new(directory) else {
            return 0;
        };
        let owners = [host.uniqueid.as_str(), host.address.as_str()];
        let mut removed = 0;
        for name in names(&listing) {
            if !owners.iter().any(|owner| is_cover_of(&name, owner)) {
                continue;
            }
            if let Ok(path) = CString::new(format!("{directory}/{name}"))
                && unsafe { remove(path.as_ptr()) } == 0
            {
                removed += 1;
            }
        }
        removed
    }

    pub fn read(&self, host: &moonlight_nx2_ui::model::Host, app: u32) -> Option<Vec<u8>> {
        let path = self.path(host, app, "")?;
        let mut file = File::open(&path, c"rb")?;
        let limit = moonlight_nx2_app::covers::MAX_BYTES + 1;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(limit).ok()?;
        bytes.resize(limit, 0);
        let count = unsafe { fread(bytes.as_mut_ptr().cast(), 1, bytes.len(), file.pointer()) };
        let good =
            count > 0 && count < limit && unsafe { ferror(file.pointer()) } == 0 && file.close();
        if !good {
            return None;
        }
        bytes.truncate(count);
        Some(bytes)
    }

    pub fn write(&self, host: &moonlight_nx2_ui::model::Host, app: u32, bytes: &[u8]) -> bool {
        if bytes.is_empty() || bytes.len() > moonlight_nx2_app::covers::MAX_BYTES {
            return false;
        }
        let Some(path) = self.path(host, app, "") else {
            return false;
        };
        let Some(temporary) = self.path(host, app, ".part") else {
            return false;
        };
        let Some(mut file) = File::open(&temporary, c"wb") else {
            return false;
        };
        let written = unsafe { fwrite(bytes.as_ptr().cast(), 1, bytes.len(), file.pointer()) }
            == bytes.len()
            && unsafe { fflush(file.pointer()) } == 0;
        let closed = file.close();
        if written && closed && unsafe { rename(temporary.as_ptr(), path.as_ptr()) } == 0 {
            return true;
        }
        unsafe {
            remove(temporary.as_ptr());
        }
        false
    }
}

/// The largest settings-style file; the Sunshine key book holds an RSA key and certificates.
const MAX_FILE_BYTES: usize = moonlight_nx2_app::direct_keys::MAX_BYTES;

impl Files for Directory {
    fn read(&mut self, name: &str, buffer: &mut [u8]) -> Option<usize> {
        let mut path = self.path(name, "")?;
        if status(&path) == 0 {
            path = self.path(name, ".bak")?;
        }
        let mut file = File::open(&path, c"rb")?;
        let count = unsafe { fread(buffer.as_mut_ptr().cast(), 1, buffer.len(), file.pointer()) };
        let good = count < buffer.len() && unsafe { ferror(file.pointer()) } == 0;
        let closed = file.close();
        (good && closed).then_some(count)
    }

    fn write(&mut self, name: &str, bytes: &[u8]) -> bool {
        if bytes.len() > MAX_FILE_BYTES {
            return false;
        }
        let Some(path) = self.path(name, "") else {
            return false;
        };
        let Some(temporary) = self.path(name, ".part") else {
            return false;
        };
        let Some(backup) = self.path(name, ".bak") else {
            return false;
        };
        let Some(mut file) = File::open(&temporary, c"wb") else {
            return false;
        };
        let written = unsafe { fwrite(bytes.as_ptr().cast(), 1, bytes.len(), file.pointer()) }
            == bytes.len()
            && unsafe { fflush(file.pointer()) } == 0;
        let closed = file.close();
        if !written || !closed {
            unsafe {
                remove(temporary.as_ptr());
            }
            return false;
        }
        if unsafe { rename(temporary.as_ptr(), path.as_ptr()) } == 0 {
            return true;
        }
        if status(&path) != 1 {
            return false;
        }
        if status(&backup) != 0 && unsafe { remove(backup.as_ptr()) } != 0 {
            return false;
        }
        if unsafe { rename(path.as_ptr(), backup.as_ptr()) } != 0 {
            return false;
        }
        if unsafe { rename(temporary.as_ptr(), path.as_ptr()) } == 0 {
            return true;
        }
        unsafe {
            rename(backup.as_ptr(), path.as_ptr());
        }
        false
    }

    fn exists(&mut self, name: &str) -> bool {
        self.path(name, "").is_some_and(|path| status(&path) != 0)
            || self
                .path(name, ".bak")
                .is_some_and(|path| status(&path) != 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use moonlight_nx2_ui::model::{Address, Host, Name};

    fn host(address: &str, uniqueid: &str) -> Host {
        Host {
            name: Name::of("PC"),
            address: Address::of(address),
            uniqueid: Address::of(uniqueid),
            mac: None,
        }
    }

    fn fill(bytes: &mut [u8]) -> bool {
        use std::io::Read;
        std::fs::File::open("/dev/urandom").and_then(|mut file| file.read_exact(bytes)).is_ok()
    }

    #[test]
    fn the_sunshine_key_book_survives_the_directory() {
        use moonlight_nx2_app::{
            direct_keys::{FILE, Keys},
            pairings::Loaded,
            sunshine::{identity::Identity, random::Random},
        };
        let folder = std::env::temp_dir().join(format!("moonlight-keys-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        let path = CString::new(folder.to_str().unwrap()).unwrap();
        let mut directory = Directory::create(&path).unwrap();
        let identity = Identity::generate(Random(fill)).unwrap();
        let mut keys = Keys::default();
        assert!(keys.pin(&Address::of("192.0.2.245"), &identity, identity.cert_der()));
        let size = keys.format().unwrap().len();
        assert!(size > 4096, "the book is {size} bytes");

        assert!(keys.save(&mut directory));
        assert!(keys.save(&mut directory), "a save over an existing book");
        assert!(folder.join(FILE).exists());
        let (loaded, state) = Keys::load(&mut directory);
        assert_eq!(state, Loaded::Read);
        let pc = Address::of("192.0.2.245");
        assert_eq!(loaded.identity(&pc).unwrap().uniqueid, identity.uniqueid());
        assert!(loaded.server(&Address::of("192.0.2.245")).is_some());
        let _ = std::fs::remove_dir_all(&folder);
    }

    #[test]
    fn a_cover_name_belongs_to_one_owner() {
        assert!(is_cover_of("ABC-12.png", "ABC"));
        assert!(is_cover_of("ABC-12.png.part", "ABC"));
        assert!(is_cover_of("192.168.1.5-7.png", "192.168.1.5"));
        assert!(!is_cover_of("ABC-1-12.png", "ABC"));
        assert!(!is_cover_of("ABCD-12.png", "ABC"));
        assert!(!is_cover_of("ABC-x.png", "ABC"));
        assert!(!is_cover_of("ABC-.png", "ABC"));
        assert!(!is_cover_of("ABC-12.jpg", "ABC"));
        assert!(!is_cover_of("-12.png", ""));
    }

    #[test]
    fn forgetting_a_host_removes_only_its_covers() {
        let folder = std::env::temp_dir().join(format!("moonlight-covers-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&folder);
        let path = CString::new(folder.to_str().unwrap()).unwrap();
        let cache = CoverDirectory::open(&path).unwrap();
        let pc = host("192.168.1.5", "ABC");
        let den = host("192.168.1.6", "DEF");
        assert!(cache.write(&pc, 1, b"png"));
        assert!(cache.write(&pc, 22, b"png"));
        assert!(cache.write(&den, 1, b"png"));
        std::fs::write(folder.join("192.168.1.5-3.png"), b"png").unwrap();

        assert_eq!(cache.forget(&pc), 3);
        assert!(cache.read(&pc, 1).is_none() && cache.read(&pc, 22).is_none());
        assert!(cache.read(&den, 1).is_some());
        assert_eq!(cache.forget(&pc), 0);
        let _ = std::fs::remove_dir_all(&folder);
    }
}
