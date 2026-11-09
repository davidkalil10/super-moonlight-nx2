"""Pinned identity of the qualified OunceVK alias copy (ouncevk fd483fb, libouncevk.a 9b8d1de4).

`python3 pins.py --shell` prints the same pins as shell assignments for prepare-alias-archive.sh.
"""
import sys

SDK_ARCHIVE_SHA = "9b8d1de4d5d6c64de7ab737e940a05650544823ea46cd04f60c76d7a2d93621f"
MEMBER = "vulkan.o"
MEMBER_SHA = "5b3efdf1968e41230915e62cfef7a16942c993f56c9a37290bdbf49ac55f63b5"
ALIAS_MEMBER_SHA = "adcb05710664bf85a66d07e6ccea4a81c5895bc52546027527c61ee84a9f2449"
ALIAS_ARCHIVE_SHA = "b33546d8f616e135257a27b5606992a2b8a9708dc8d11e8343b55faa34176531"

# alias: (local, type, size, object section, object section sha256 or None for NOBITS,
#         final output section, local visibility)
ALIASES = {
    "moonlight_ouncevk_mem_ops": (
        "native_mem_ops", "OBJECT", 0x50, ".data.rel.ro.local.native_mem_ops",
        "5b6fb58e61fa475939767d68a446f97f1bff02c0e5935a3ea8bb51e6515783d8", ".data.rel.ro", "DEFAULT"),
    "moonlight_ouncevk_device": (
        "native_device", "OBJECT", 0x66590, ".bss.native_device", None, ".bss", "DEFAULT"),
    "moonlight_ouncevk_owner_lock": (
        "nvkmd_nvgpu_native_owner_lock", "FUNC", 0x9c, ".text.nvkmd_nvgpu_native_owner_lock",
        "167b3c9f583b85f9940537f475d4451a6baa1487629cceabfb5803c25e87b0df", ".text", "HIDDEN"),
    "moonlight_ouncevk_owner_unlock": (
        "nvkmd_nvgpu_native_owner_unlock", "FUNC", 0x28, ".text.nvkmd_nvgpu_native_owner_unlock",
        "6e8caaf6f41855427d51f216584af159981f851891b9d526aaa0b01cde7e82d4", ".text", "HIDDEN"),
}
LOCK_ALIAS = "moonlight_ouncevk_owner_lock"
UNLOCK_ALIAS = "moonlight_ouncevk_owner_unlock"

# GNU ld 2.45.1 keeps hidden data aliases GLOBAL HIDDEN and localizes hidden function aliases.
FINAL_BINDING = {"OBJECT": ("GLOBAL", "HIDDEN"), "FUNC": ("LOCAL", "DEFAULT")}

# The only external call inside each SDK lock function.
SDK_CALLS = {
    "nvkmd_nvgpu_native_owner_lock": ("bl", "mesa_c11_mtx_lock"),
    "nvkmd_nvgpu_native_owner_unlock": ("b", "mesa_c11_mtx_unlock"),
}

# Relocations an input object may use against each alias type (direct, no GOT).
INPUT_RELOCS = {
    "OBJECT": {"R_AARCH64_ADR_PREL_PG_HI21", "R_AARCH64_ADD_ABS_LO12_NC"},
    "FUNC": {"R_AARCH64_CALL26"},
}


def shell():
    kind = {"OBJECT": "object", "FUNC": "function"}
    print(f"SDK_ARCHIVE_SHA={SDK_ARCHIVE_SHA}")
    print(f"MEMBER={MEMBER}")
    print(f"MEMBER_SHA={MEMBER_SHA}")
    print(f"ALIAS_MEMBER_SHA={ALIAS_MEMBER_SHA}")
    print(f"ALIAS_ARCHIVE_SHA={ALIAS_ARCHIVE_SHA}")
    print("ALIASES='" + " ".join(f"{a}={v[0]}" for a, v in ALIASES.items()) + "'")
    print("ADD_SYMBOLS='" + " ".join(f"--add-symbol {a}={v[3]}:0,global,{kind[v[1]]}"
                                     for a, v in ALIASES.items()) + "'")


if __name__ == "__main__":
    if sys.argv[1:] != ["--shell"]:
        sys.exit("usage: pins.py --shell")
    shell()
