extern crate alloc;

use alloc::{ffi::CString, vec::Vec};
use core::{
    ffi::{CStr, c_char, c_int, c_void},
    ptr::NonNull,
};
use moonlight_nx2_core::cache::{self, Identity};

unsafe extern "C" {
    fn fopen(path: *const c_char, mode: *const c_char) -> *mut c_void;
    fn fread(data: *mut c_void, size: usize, count: usize, file: *mut c_void) -> usize;
    fn fwrite(data: *const c_void, size: usize, count: usize, file: *mut c_void) -> usize;
    fn fgetc(file: *mut c_void) -> c_int;
    fn ferror(file: *mut c_void) -> c_int;
    fn fflush(file: *mut c_void) -> c_int;
    fn fclose(file: *mut c_void) -> c_int;
    fn remove(path: *const c_char) -> c_int;
    fn rename(from: *const c_char, to: *const c_char) -> c_int;
}

struct File(Option<NonNull<c_void>>);

impl File {
    fn open(path: &CStr, mode: &CStr) -> Option<Self> {
        NonNull::new(unsafe { fopen(path.as_ptr(), mode.as_ptr()) }).map(|file| Self(Some(file)))
    }
    fn pointer(&self) -> *mut c_void {
        self.0.unwrap().as_ptr()
    }
    fn close(&mut self) -> bool {
        self.0
            .take()
            .is_none_or(|file| unsafe { fclose(file.as_ptr()) } == 0)
    }
}

impl Drop for File {
    fn drop(&mut self) {
        self.close();
    }
}

fn temporary(path: &CStr) -> Result<CString, &'static str> {
    let bytes = path.to_bytes();
    if bytes.is_empty() || bytes.len() + 4 >= 256 {
        return Err("path");
    }
    let mut name = Vec::new();
    name.try_reserve_exact(bytes.len() + 5)
        .map_err(|_| "memory")?;
    name.extend_from_slice(bytes);
    name.extend_from_slice(b".tmp\0");
    CString::from_vec_with_nul(name).map_err(|_| "path")
}

fn read(path: &CStr, identity: Identity) -> Result<Vec<u8>, &'static str> {
    let file = File::open(path, c"rb").ok_or("missing")?;
    let mut header = [0; cache::HEADER_BYTES];
    if unsafe { fread(header.as_mut_ptr().cast(), 1, header.len(), file.pointer()) } != header.len()
    {
        return Err("truncated");
    }
    let bytes = identity
        .check_header(&header)
        .map_err(|error| error.name())?;
    let mut data = Vec::new();
    data.try_reserve_exact(cache::HEADER_BYTES + bytes)
        .map_err(|_| "memory")?;
    data.extend_from_slice(&header);
    data.resize(cache::HEADER_BYTES + bytes, 0);
    if unsafe {
        fread(
            data[cache::HEADER_BYTES..].as_mut_ptr().cast(),
            1,
            bytes,
            file.pointer(),
        )
    } != bytes
    {
        return Err("truncated");
    }
    if unsafe { fgetc(file.pointer()) } != -1 {
        return Err("trailing");
    }
    if unsafe { ferror(file.pointer()) } != 0 {
        return Err("read");
    }
    identity.decode(&data).map_err(|error| error.name())?;
    Ok(data)
}

pub fn load(path: &CStr, identity: Identity) -> Result<Vec<u8>, &'static str> {
    let reason = match read(path, identity) {
        Ok(data) => return Ok(data),
        Err(reason) => reason,
    };
    let temporary = temporary(path)?;
    let data = read(&temporary, identity).map_err(|_| reason)?;
    unsafe {
        remove(path.as_ptr());
        rename(temporary.as_ptr(), path.as_ptr());
    }
    Ok(data)
}

pub fn save(path: &CStr, identity: Identity, data: &[u8]) -> Result<(), &'static str> {
    let header = identity.encode_header(data).map_err(|error| error.name())?;
    let temporary = temporary(path)?;
    let mut file = File::open(&temporary, c"wb").ok_or("open")?;
    let written = unsafe { fwrite(header.as_ptr().cast(), 1, header.len(), file.pointer()) }
        == header.len()
        && unsafe { fwrite(data.as_ptr().cast(), 1, data.len(), file.pointer()) } == data.len()
        && unsafe { fflush(file.pointer()) } == 0;
    let closed = file.close();
    if !written || !closed {
        unsafe {
            remove(temporary.as_ptr());
        }
        return Err("write");
    }
    if unsafe { rename(temporary.as_ptr(), path.as_ptr()) } == 0 {
        return Ok(());
    }
    if unsafe { remove(path.as_ptr()) } != 0 {
        return Err("replace");
    }
    if unsafe { rename(temporary.as_ptr(), path.as_ptr()) } != 0 {
        return Err("rename");
    }
    Ok(())
}
