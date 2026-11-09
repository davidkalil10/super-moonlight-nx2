.DEFAULT_GOAL := all
.SUFFIXES:

PROBE_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
PROOF_DIR := $(abspath $(PROBE_DIR)/..)

ifeq ($(strip $(DEVKITPRO)),)
$(error Set DEVKITPRO to the installation containing ounce-sdk 20261109)
endif
ifeq ($(strip $(BUILD_DIR)),)
$(error Set BUILD_DIR to a fresh absolute build directory)
endif

include $(DEVKITPRO)/libounce/switch2_rules

CARGO ?= cargo
RUST_TARGET := aarch64-unknown-none
OUTPUT := $(BUILD_DIR)/moonlight-nx2-rust-proof
OBJECTS := $(BUILD_DIR)/main.o $(BUILD_DIR)/runtime.o
ARCH := -march=armv8-a+crc+crypto -mtune=cortex-a57 -mtp=soft -fPIE
CPPFLAGS += -I$(LIBNX)/include
ifneq ($(findstring allocator-proof,$(RUST_FEATURES)),)
CPPFLAGS += -DMOONLIGHT_RUST_ALLOCATOR_PROOF
endif
CFLAGS := $(ARCH) -std=gnu11 -O2 -g -Wall -Wextra -Werror -ffunction-sections -fdata-sections
LDFLAGS := $(ARCH) -specs=$(LIBNX)/switch.specs -Wl,-Map,$(OUTPUT).map
LIBS := -L$(LIBNX)/lib -lnx -lm

.PHONY: all
all: $(OUTPUT).nro

ifeq ($(strip $(RUST_LIBRARY)),)
RUST_LIBRARY := $(BUILD_DIR)/cargo/$(RUST_TARGET)/release/libmoonlight_rust_proof.a

$(RUST_LIBRARY): $(PROOF_DIR)/Cargo.toml $(PROOF_DIR)/Cargo.lock $(PROOF_DIR)/src/lib.rs
	CARGO_TARGET_DIR=$(BUILD_DIR)/cargo RUSTFLAGS="$(RUSTFLAGS) -C relocation-model=pic" $(CARGO) build --manifest-path $(PROOF_DIR)/Cargo.toml --target $(RUST_TARGET) --release --frozen --offline $(if $(RUST_FEATURES),--features $(RUST_FEATURES))
endif

$(BUILD_DIR)/main.o: $(PROBE_DIR)/main.c $(PROOF_DIR)/proof.h
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@

$(BUILD_DIR)/runtime.o: $(PROOF_DIR)/runtime.c
	$(CC) $(CPPFLAGS) $(CFLAGS) -MMD -MP -c $< -o $@

$(OUTPUT).elf: $(OBJECTS) $(RUST_LIBRARY)
	$(CC) $(LDFLAGS) $(OBJECTS) $(RUST_LIBRARY) $(LIBS) -o $@

$(OUTPUT).nacp:
	nacptool --create "Moonlight NX2 Rust proof" "Azkali" "0.1.0" $@

$(OUTPUT).nro: $(OUTPUT).elf $(OUTPUT).nacp
	elf2nro $< $@ --nacp=$(OUTPUT).nacp

-include $(OBJECTS:.o=.d)
