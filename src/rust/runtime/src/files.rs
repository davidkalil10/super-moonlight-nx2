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
        if !matches!(
            name,
            "hosts.json" | "settings.json" | "settings-0.json" | "settings-1.json" | "pairings"
        ) {
            return None;
        }
        CString::new(format!("{}/{name}{suffix}", self.path.to_str().ok()?)).ok()
    }
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
        if bytes.len() > 4096 {
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
