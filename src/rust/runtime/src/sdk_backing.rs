use core::mem::{align_of, offset_of, size_of};

pub const ABI_VERSION: u32 = 2;
pub const ALLOCATION_BYTES: u64 = 64 * 1024;

#[repr(C)]
pub struct Request {
    pub abi_version: u32,
    pub reserved: u32,
    pub device_memory: u64,
    pub retired: *const u32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Info {
    pub abi_version: u32,
    pub memory_handle: u32,
    pub cpu_address: u64,
    pub gpu_address: u64,
    pub requested_size: u64,
    pub native_size: u64,
    pub slice_size: u64,
    pub relative_offset: u64,
    pub backing_cpu_base: u64,
    pub backing_size: u64,
    pub arena_used: u64,
    pub source: u32,
    pub segment_index: u32,
    pub owner_verified: u32,
    pub reserved: u32,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Report {
    pub abi_version: u32,
    pub result: u32,
    pub lock_status: u32,
    pub metadata_status: u32,
    pub info: Info,
}

const _: () = {
    assert!(size_of::<Request>() == 0x18 && align_of::<Request>() == 8);
    assert!(offset_of!(Request, device_memory) == 8 && offset_of!(Request, retired) == 0x10);
    assert!(size_of::<Report>() == 0x70 && align_of::<Report>() == 8);
    assert!(offset_of!(Report, info) == 0x10);
    assert!(size_of::<Info>() == 0x60 && align_of::<Info>() == 8);
    assert!(offset_of!(Info, memory_handle) == 4);
    assert!(offset_of!(Info, cpu_address) == 8);
    assert!(offset_of!(Info, gpu_address) == 0x10);
    assert!(offset_of!(Info, requested_size) == 0x18);
    assert!(offset_of!(Info, native_size) == 0x20);
    assert!(offset_of!(Info, slice_size) == 0x28);
    assert!(offset_of!(Info, relative_offset) == 0x30);
    assert!(offset_of!(Info, backing_cpu_base) == 0x38);
    assert!(offset_of!(Info, backing_size) == 0x40);
    assert!(offset_of!(Info, arena_used) == 0x48);
    assert!(offset_of!(Info, source) == 0x50);
    assert!(offset_of!(Info, segment_index) == 0x54);
    assert!(offset_of!(Info, owner_verified) == 0x58);
    assert!(offset_of!(Info, reserved) == 0x5c);
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Allocation {
    pub memory: u64,
    pub mapped: u64,
    pub bytes: u64,
    pub map_alignment: u64,
    pub memory_type: u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Mismatch {
    Report,
    Owner,
    Pointer,
    Size,
    Bounds,
}

#[derive(Clone, Copy, Debug)]
pub struct Probe {
    pub allocation: Allocation,
    pub report: Report,
    pub comparison: Result<(), Mismatch>,
    pub query_ns: Option<u64>,
}

pub fn compare(allocation: Allocation, report: &Report) -> Result<(), Mismatch> {
    let info = &report.info;
    if report.abi_version != ABI_VERSION
        || report.result != 0
        || report.lock_status != 0
        || report.metadata_status != 0
        || info.abi_version != ABI_VERSION
    {
        return Err(Mismatch::Report);
    }
    if info.owner_verified != 1 || info.reserved != 0 || !matches!(info.source, 1 | 2) {
        return Err(Mismatch::Owner);
    }
    if allocation.memory == 0
        || allocation.mapped == 0
        || allocation.map_alignment == 0
        || !allocation.mapped.is_multiple_of(allocation.map_alignment)
        || info.cpu_address != allocation.mapped
    {
        return Err(Mismatch::Pointer);
    }
    if allocation.bytes == 0
        || info.requested_size != allocation.bytes
        || info.requested_size > info.native_size
        || info.native_size > info.slice_size
    {
        return Err(Mismatch::Size);
    }
    if info.memory_handle == 0
        || info.gpu_address == 0
        || info.cpu_address.checked_sub(info.backing_cpu_base) != Some(info.relative_offset)
        || info.arena_used > info.backing_size
        || info
            .relative_offset
            .checked_add(info.slice_size)
            .is_none_or(|end| end > info.arena_used)
        || info.cpu_address.checked_add(info.requested_size).is_none()
        || info.gpu_address.checked_add(info.requested_size).is_none()
    {
        return Err(Mismatch::Bounds);
    }
    Ok(())
}

#[cfg(target_os = "none")]
pub(crate) fn query(memory: u64) -> Report {
    unsafe extern "C" {
        fn moonlightSdkBackingQuery(request: *const Request, report: *mut Report) -> u32;
    }
    let retired = || Report {
        abi_version: ABI_VERSION,
        result: 3,
        ..Report::default()
    };
    if crate::sdk::process_retired() {
        return retired();
    }
    let request = Request {
        abi_version: ABI_VERSION,
        reserved: 0,
        device_memory: memory,
        retired: core::ptr::null(),
    };
    let mut report = Report::default();
    let status = unsafe { moonlightSdkBackingQuery(&request, &mut report) };
    if crate::sdk::process_retired() {
        return retired();
    }
    if status != report.result {
        report.result = u32::MAX;
    }
    report
}
