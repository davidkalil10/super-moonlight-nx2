#![cfg_attr(target_os = "none", no_std)]

#[cfg(feature = "allocator-proof")]
extern crate alloc;

#[cfg(feature = "allocator-proof")]
use alloc::vec::Vec;
#[cfg(feature = "allocator-proof")]
use core::alloc::{GlobalAlloc, Layout};
#[cfg(feature = "allocator-proof")]
use core::ffi::c_void;
#[cfg(target_os = "none")]
use core::panic::PanicInfo;

unsafe extern "C" {
    #[cfg(feature = "allocator-proof")]
    fn moonlightRustAllocate(bytes: usize, alignment: usize) -> *mut c_void;
    #[cfg(feature = "allocator-proof")]
    fn moonlightRustDeallocate(memory: *mut c_void);
    #[cfg(target_os = "none")]
    fn moonlightRustAbort() -> !;
}

#[cfg(feature = "allocator-proof")]
struct RuntimeAllocator;

#[cfg(feature = "allocator-proof")]
unsafe impl GlobalAlloc for RuntimeAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        unsafe { moonlightRustAllocate(layout.size(), layout.align()).cast() }
    }

    unsafe fn dealloc(&self, memory: *mut u8, _layout: Layout) {
        unsafe { moonlightRustDeallocate(memory.cast()) }
    }
}

#[global_allocator]
#[cfg(feature = "allocator-proof")]
static ALLOCATOR: RuntimeAllocator = RuntimeAllocator;

#[cfg(target_os = "none")]
#[panic_handler]
fn panic(_info: &PanicInfo<'_>) -> ! {
    unsafe { moonlightRustAbort() }
}

#[repr(u32)]
enum ResultCode {
    Ok = 0,
    BadKind = 1,
    BadLength = 2,
    BadAuth = 3,
    BadMagic = 4,
    BadVersion = 5,
    Invalid = 10,
    #[cfg(feature = "allocator-proof")]
    NoMemory = 11,
    #[cfg(feature = "allocator-proof")]
    BadAlignment = 12,
}

#[repr(C)]
pub struct ControlHeader {
    kind: u32,
    request_id: u32,
    payload_bytes: u32,
}

fn read_header(bytes: &[u8; 16]) -> Result<ControlHeader, ResultCode> {
    let magic = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
    if magic != 0x3143_4e4d {
        return Err(ResultCode::BadMagic);
    }

    let version = u16::from_le_bytes(bytes[4..6].try_into().unwrap());
    if version != 1 {
        return Err(ResultCode::BadVersion);
    }

    let kind = u16::from_le_bytes(bytes[6..8].try_into().unwrap());
    let request_id = u32::from_le_bytes(bytes[8..12].try_into().unwrap());
    let payload_bytes = u32::from_le_bytes(bytes[12..16].try_into().unwrap());
    if !(1..=6).contains(&kind) {
        return Err(ResultCode::BadKind);
    }
    if !(1..=65_536).contains(&payload_bytes) {
        return Err(ResultCode::BadLength);
    }
    if kind == 1 && (request_id != 0 || payload_bytes != 64) {
        return Err(ResultCode::BadAuth);
    }

    Ok(ControlHeader {
        kind: u32::from(kind),
        request_id,
        payload_bytes,
    })
}

/// # Safety
/// `bytes` must name `length` readable bytes and `out` one aligned, writable header.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn moonlightRustReadControlHeader(
    bytes: *const u8,
    length: usize,
    out: *mut ControlHeader,
) -> u32 {
    if bytes.is_null() || out.is_null() || length != 16 {
        return ResultCode::Invalid as u32;
    }

    let mut header = [0; 16];
    unsafe { core::ptr::copy_nonoverlapping(bytes, header.as_mut_ptr(), header.len()) };
    match read_header(&header) {
        Ok(parsed) => {
            unsafe { out.write(parsed) };
            ResultCode::Ok as u32
        }
        Err(error) => error as u32,
    }
}

#[repr(align(64))]
#[cfg(feature = "allocator-proof")]
struct AlignedBlock([u8; 64]);

/// # Safety
/// `out` must name one aligned, writable u64. Rust releases its own allocation.
#[unsafe(no_mangle)]
#[cfg(feature = "allocator-proof")]
pub unsafe extern "C" fn moonlightRustCheckAllocation(seed: u32, out: *mut u64) -> u32 {
    if out.is_null() {
        return ResultCode::Invalid as u32;
    }

    let mut blocks = Vec::new();
    if blocks.try_reserve_exact(8).is_err() {
        return ResultCode::NoMemory as u32;
    }
    for index in 0..8_u32 {
        let value = seed.wrapping_add(index.wrapping_mul(17)) as u8;
        blocks.push(AlignedBlock([value; 64]));
    }
    if blocks.as_ptr() as usize % 64 != 0 {
        return ResultCode::BadAlignment as u32;
    }

    let mut checksum = 0xcbf2_9ce4_8422_2325_u64;
    for block in &blocks {
        for byte in block.0 {
            checksum ^= u64::from(byte);
            checksum = checksum.wrapping_mul(0x0100_0000_01b3);
        }
    }
    unsafe { out.write(checksum) };
    ResultCode::Ok as u32
}
